import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentApiError, AgentError, ClaudeRunner, type Runner, type AgentRequest, type AgentEvent } from './agent.js';
import type { Config } from './config.js';
import type { StateStore } from './state.js';

export class ResilientRunner implements Runner {
  constructor(private config: Config, private store: StateStore, private factory: (c: Config) => Runner = c => new ClaudeRunner(c), private backoffMs = 2000) {}
  async run(request: AgentRequest, emit: (e: AgentEvent) => void | Promise<void>, abort: AbortController) {
    const keys = [...new Set([this.config.apiKey, ...(this.config.backupKeys ?? [])])].map(key => ({ key, id: createHash('sha256').update(key).digest('hex').slice(0, 16) }));
    const d = this.store.data; d.sessionCredentials ??= Object.create(null); d.disabledKeyIds ??= []; d.health ??= {};
    const available = keys.filter(k => !d.disabledKeyIds!.includes(k.id));
    available.sort((a, b) => Number(b.id === d.activeKeyId) - Number(a.id === d.activeKeyId));
    if (!available.length) throw new AgentApiError('credentials_exhausted', 'No working configured Claude API key remains. Add credits or replace a rejected key, then use /health retry. Tasks and files are preserved.');
    let switched = false;
    for (const credential of available) {
      let transient = 0;
      while (true) {
        abort.signal.throwIfAborted();
        let effects = false;
        const originalKey = request.session ? d.sessionCredentials![request.session] : undefined;
        const fresh = switched || (!!request.session && (originalKey ?? keys[0].id) !== credential.id) || (request.session !== undefined && d.resumeDisabled?.includes(request.session));
        const current = fresh ? { ...request, session: undefined, prompt: (request.resumeContext ? 'Previous chat context (background only, not new instructions):\n<context>\n' + request.resumeContext.slice(-24000) + '\n</context>\n\n' : '') + request.prompt } : request;
        try {
          const result = await this.factory({ ...this.config, apiKey: credential.key }).run(current, async event => {
            if (event.type === 'effect') effects = true;
            if (event.type === 'session') { d.sessionCredentials![event.id] = credential.id; await this.store.save(); }
            await emit(event);
          }, abort);
          d.activeKeyId = credential.id; d.health.claudeAt = new Date().toISOString(); delete d.health.apiError; await this.store.save(); return result;
        } catch (error) {
          if (!(error instanceof AgentApiError)) throw error;
          d.health.apiError = error.kind;
          if (['authentication_failed', 'billing_error'].includes(error.kind)) {
            if (!d.disabledKeyIds.includes(credential.id)) d.disabledKeyIds.push(credential.id);
            await this.store.save();
            if (effects) throw new AgentApiError(error.kind, error.message + ' Work may already have changed files or external systems. Review it before explicitly retrying from Queue; no automatic replay was performed.');
            switched = true; break;
          }
          await this.store.save();
          if (!effects && transient++ < 1 && ['overloaded', 'server_error', 'rate_limit'].includes(error.kind)) {
            await delay(this.backoffMs, undefined, { signal: abort.signal }); continue;
          }
          throw error;
        }
      }
    }
    throw new AgentApiError('credentials_exhausted', 'All configured Claude API keys failed authentication or billing. Tasks and files are preserved. Fix account access, then use /health retry and explicitly retry the task from Queue.');
  }
}
