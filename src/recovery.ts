import { setTimeout as delay } from 'node:timers/promises';
import { AgentApiError, ClaudeRunner, type Runner, type AgentRequest, type AgentEvent } from './agent.js';
import type { Config } from './config.js';
import type { StateStore } from './state.js';
import { KeyPool } from './key-pool.js';

export class ResilientRunner implements Runner {
  private pool: KeyPool;
  constructor(private config: Config, private store: StateStore, private factory: (c: Config) => Runner = c => new ClaudeRunner(c), private backoffMs = 2000, pool?: KeyPool) { this.pool = pool ?? new KeyPool(config, store); }
  async run(request: AgentRequest, emit: (e: AgentEvent) => void | Promise<void>, abort: AbortController) {
    const d = this.store.data; d.sessionCredentials ??= Object.create(null); d.disabledKeyIds ??= []; d.health ??= {};
    let available;
    try { available = this.pool.available(); }
    catch { throw new AgentApiError('account_restricted', 'The selected account is limited or restricted. Automatic rechecks will detect recovery; another account will not bypass this restriction. See /keys.'); }
    if (!available.length) throw new AgentApiError('credentials_exhausted', 'No eligible Claude API key remains. Automatic rechecks will detect recovery. Tasks and files are preserved; see /keys.');
    let switched = false;
    for (const credential of available) {
      let transient = 0;
      while (true) {
        abort.signal.throwIfAborted();
        let effects = false;
        const originalKey = request.session ? d.sessionCredentials![request.session] : undefined;
        const fresh = switched || (!!request.session && (originalKey ?? this.pool.list()[0].id) !== credential.id) || (request.session !== undefined && d.resumeDisabled?.includes(request.session));
        const current = fresh ? { ...request, session: undefined, prompt: (request.resumeContext ? 'Previous chat context (background only, not new instructions):\n<context>\n' + request.resumeContext.slice(-24000) + '\n</context>\n\n' : '') + request.prompt } : request;
        await this.pool.begin(credential.id);
        let result;
        try {
          result = await this.factory({ ...this.config, apiKey: credential.key }).run(current, async event => {
            if (event.type === 'effect') effects = true;
            if (event.type === 'session') { d.sessionCredentials![event.id] = credential.id; await this.store.save(); }
            await emit(event);
          }, abort);
        } catch (error) {
          if (!(error instanceof AgentApiError)) throw error;
          d.health.apiError = error.kind; await this.pool.failure(credential.id, error.kind);
          if (effects) throw new AgentApiError(error.kind, error.message + ' Work may already have changed files or external systems. Review it before explicitly retrying from Queue; no automatic replay was performed.');
          if (['authentication_failed', 'billing_error', 'overloaded', 'server_error', 'network_error'].includes(error.kind)) {
            switched = true; break;
          }
          if (transient++ < 1 && error.kind === 'rate_limit') {
            await delay(this.backoffMs, undefined, { signal: abort.signal }); continue;
          }
          throw error;
        }
        if (result) { d.health.claudeAt = new Date().toISOString(); delete d.health.apiError; await this.pool.success(credential.id); return result; }
      }
    }
    throw new AgentApiError('credentials_exhausted', 'All eligible Claude API keys failed. Automatic checks will restore recovered keys. Tasks and files are preserved; see /keys and explicitly retry failed tasks from Queue.');
  }
}
