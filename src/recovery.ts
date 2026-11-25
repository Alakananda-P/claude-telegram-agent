import { setTimeout as delay } from 'node:timers/promises';
import { AgentApiError, ClaudeRunner, type Runner, type AgentRequest, type AgentEvent } from './agent.js';
import type { Config } from './config.js';
import type { StateStore } from './state.js';
import { KeyPool } from './key-pool.js';

/** Busy or unreachable API: worth one more try on the same key (M2). */
export const BUSY_API_KINDS = ['overloaded', 'server_error', 'network_error'];
/** Key or account problems that pause the queue until the owner acts (M2). */
export const PAUSE_API_KINDS = ['authentication_failed', 'billing_error', 'credentials_exhausted', 'account_restricted', 'account_on_hold', 'verification_required', 'oauth_org_not_allowed'];

export class ResilientRunner implements Runner {
  private pool: KeyPool;
  constructor(private config: Config, private store: StateStore, private factory: (c: Config) => Runner = c => new ClaudeRunner(c), private backoffMs = 2000, pool?: KeyPool) { this.pool = pool ?? new KeyPool(config, store); }
  async run(request: AgentRequest, emit: (e: AgentEvent) => void | Promise<void>, abort: AbortController) {
    const d = this.store.data; d.sessionCredentials ??= Object.create(null); d.disabledKeyIds ??= []; d.health ??= {};
    let available;
    // M2: a key cooling down after a busy API is still better than no key at all.
    try { available = this.pool.available(); if (!available.length) available = this.pool.available(true).slice(0, 1); }
    catch { throw new AgentApiError('account_restricted', 'The selected account is limited or restricted. Automatic rechecks will detect recovery; another account will not bypass this restriction. See /keys.'); }
    if (!available.length) throw new AgentApiError('credentials_exhausted', 'No eligible Claude API key remains. Automatic rechecks will detect recovery. Tasks and files are preserved; see /keys.');
    let switched = false; let lastError: AgentApiError | undefined; let onlyBusy = true;
    for (const credential of available) {
      let transient = 0;
      while (true) {
        abort.signal.throwIfAborted();
        let effects = false;
        const originalKey = request.session ? d.sessionCredentials![request.session] : undefined;
        const fresh = switched || (!!request.session && (originalKey ?? this.pool.primaryId) !== credential.id) || (request.session !== undefined && d.resumeDisabled?.includes(request.session));
        const current = fresh ? { ...request, session: undefined, prompt: (request.resumeContext ? 'Previous chat context (background only, not new instructions):\n<context>\n' + request.resumeContext.slice(-24000) + '\n</context>\n\n' : '') + request.prompt } : request;
        await this.pool.begin(credential.id);
        let result;
        try {
          result = await this.factory(this.pool.configFor(credential)).run(current, async event => {
            if (event.type === 'effect') effects = true;
            if (event.type === 'session') { d.sessionCredentials![event.id] = credential.id; await this.store.save(); }
            await emit(event);
          }, abort);
        } catch (error) {
          if (!(error instanceof AgentApiError)) throw error;
          d.health.apiError = error.kind; await this.pool.failure(credential.id, error.kind);
          if (effects) throw new AgentApiError(error.kind, error.message + ' Work may already have changed files or external systems. Review it before explicitly retrying from Queue; no automatic replay was performed.');
          lastError = error;
          // M2: a rate limit, or a busy API on the last key left, gets one more try on the same key after a short wait.
          const lastKey = credential.id === available[available.length - 1].id;
          if (((BUSY_API_KINDS.includes(error.kind) && lastKey) || error.kind === 'rate_limit') && transient++ < 1) {
            await delay(this.backoffMs, undefined, { signal: abort.signal }); continue;
          }
          if (['authentication_failed', 'billing_error', ...BUSY_API_KINDS].includes(error.kind)) {
            if (!BUSY_API_KINDS.includes(error.kind)) onlyBusy = false;
            switched = true; break;
          }
          throw error;
        }
        if (result) { d.health.claudeAt = new Date().toISOString(); delete d.health.apiError; await this.pool.success(credential.id); return result; }
      }
    }
    // M2: report the real reason when the API was only busy, or when there was just one key.
    if (lastError && onlyBusy) throw new AgentApiError(lastError.kind, `The Claude API is busy or unreachable right now (${lastError.kind.replace(/_/g, ' ')}); ${available.length > 1 ? 'every key was' : 'it was'} retried once. Nothing was changed. Tasks and files are preserved.`);
    if (lastError && available.length === 1) throw lastError;
    throw new AgentApiError('credentials_exhausted', 'All eligible Claude API keys failed. Automatic checks will restore recovered keys. Tasks and files are preserved; see /keys and explicitly retry failed tasks from Queue.');
  }
}
