import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import type { StateStore } from './state.js';
import type { UsageLedger } from './usage.js';
import { button, BACK, type Buttons } from './ui.js';

const reason = z.enum(['authentication_failed', 'billing_error', 'rate_limit', 'overloaded', 'server_error', 'network_error', 'account_on_hold', 'verification_required', 'oauth_org_not_allowed', 'model_not_found', 'invalid_request', 'unknown']);
export type KeyReason = z.infer<typeof reason>;
export const keyRecordSchema = z.object({
  label: z.string().max(32), status: z.enum(['ready', 'healthy', 'no_credit', 'rejected', 'cooldown', 'blocked', 'error']),
  attempts: z.number().int().nonnegative(), successes: z.number().int().nonnegative(), failures: z.number().int().nonnegative(), checks: z.number().int().nonnegative(),
  lastAttemptAt: z.string().datetime().optional(), lastSuccessAt: z.string().datetime().optional(), lastFailureAt: z.string().datetime().optional(), lastCheckAt: z.string().datetime().optional(),
  nextCheckAt: z.string().datetime(), lastError: reason.optional(),
  history: z.array(z.object({ at: z.string().datetime(), event: z.enum(['added', 'selected', 'working', 'failed', 'recovered']), reason: reason.optional(), source: z.enum(['task', 'check', 'setup']) })),
});
export type KeyRecord = z.infer<typeof keyRecordSchema>;
export type KeyProbe = (key: string, signal: AbortSignal) => Promise<{ ok: boolean; kind?: KeyReason }>;
const restricted = ['rate_limit', 'account_on_hold', 'verification_required', 'oauth_org_not_allowed'];
const transient = ['overloaded', 'server_error', 'network_error'];
const stamp = (ms: number) => new Date(ms).toISOString();
class ProbeAccountingError extends Error {}

/** No raw credentials or provider error descriptions enter durable state. */
export class KeyPool {
  private credentials: { id: string; key: string; label: string }[];
  private checking?: Promise<void>;
  private probeAbort?: AbortController;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private config: Config, private store: StateStore, private probe: KeyProbe = messageProbe(), private now = Date.now) {
    this.credentials = [...new Set([config.apiKey, ...(config.backupKeys ?? [])])].map((key, i) => ({ key, id: createHash('sha256').update(key).digest('hex').slice(0, 16), label: config.keyLabels?.[i] ?? `Key ${i + 1}` }));
    store.data.keyRecords ??= Object.create(null); store.data.disabledKeyIds ??= [];
    for (const c of this.credentials) {
      const previous = store.data.keyRecords![c.id];
      if (previous) { previous.label = c.label; continue; }
      store.data.keyRecords![c.id] = { label: c.label, status: store.data.disabledKeyIds.includes(c.id) ? 'error' : 'ready', attempts: 0, successes: 0, failures: 0, checks: 0, nextCheckAt: stamp(this.now()), history: [{ at: stamp(this.now()), event: 'added', source: 'setup' }] };
    }
  }
  async initialize() { await this.store.save(); }
  list() { return this.credentials.map(c => ({ ...this.record(c.id), id: c.id, selected: this.store.data.activeKeyId === c.id })); }
  private record(id: string): KeyRecord { if (!this.credentials.some(c => c.id === id)) throw new Error('Unknown configured key.'); return this.store.data.keyRecords![id]; }
  available() {
    const preferred = this.credentials.some(c => c.id === this.store.data.activeKeyId) ? this.store.data.activeKeyId! : this.credentials[0].id;
    const current = this.record(preferred);
    if (current.lastError && restricted.includes(current.lastError)) throw new Error(current.lastError);
    return this.credentials.filter(c => !this.store.data.disabledKeyIds!.includes(c.id)
      && !['blocked', 'rejected', 'no_credit'].includes(this.record(c.id).status)
      && !(this.record(c.id).lastError && restricted.includes(this.record(c.id).lastError!))
      && !(this.record(c.id).status === 'cooldown' && Date.parse(this.record(c.id).nextCheckAt) > this.now()))
      .sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  }
  selectedConfig(): Config | undefined {
    try { const credential = this.available()[0]; return credential ? { ...this.config, apiKey: credential.key } : undefined; }
    catch { return undefined; }
  }
  async begin(id: string) {
    this.probeAbort?.abort();
    const r = this.record(id); r.attempts++; r.lastAttemptAt = stamp(this.now());
    if (this.store.data.activeKeyId !== id) r.history.push({ at: r.lastAttemptAt, event: 'selected', source: 'task' });
    this.store.data.activeKeyId = id; await this.store.save();
  }
  async success(id: string, source: 'task' | 'check' = 'task') {
    const r = this.record(id), at = stamp(this.now());
    if (r.status !== 'healthy') r.history.push({ at, event: r.failures ? 'recovered' : 'working', source });
    r.status = 'healthy'; r.lastSuccessAt = at; delete r.lastError;
    if (source === 'task') r.successes++;
    this.store.data.disabledKeyIds = this.store.data.disabledKeyIds!.filter(x => x !== id);
    r.nextCheckAt = stamp(this.now() + 6 * 60 * 60_000); await this.store.save();
  }
  async failure(id: string, kind: string, source: 'task' | 'check' = 'task') {
    const r = this.record(id), safe = reason.safeParse(kind).success ? kind as KeyReason : 'unknown';
    r.failures++; r.lastError = safe; r.lastFailureAt = stamp(this.now());
    r.status = safe === 'billing_error' ? 'no_credit' : safe === 'authentication_failed' ? 'rejected' : restricted.includes(safe) ? 'blocked' : transient.includes(safe) ? 'cooldown' : 'error';
    r.nextCheckAt = stamp(this.now() + (transient.includes(safe) ? 2 : 30) * 60_000);
    r.history.push({ at: r.lastFailureAt, event: 'failed', reason: safe, source });
    if (['billing_error', 'authentication_failed'].includes(safe) && !this.store.data.disabledKeyIds!.includes(id)) this.store.data.disabledKeyIds!.push(id);
    await this.store.save();
  }
  checkDue(): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = this.checkLoop().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  async requestChecks() {
    // The old /health retry command now verifies recovery instead of blindly enabling keys.
    for (const { id } of this.credentials) {
      const r = this.record(id);
      if (r.lastError === 'rate_limit' || (r.lastCheckAt && this.now() - Date.parse(r.lastCheckAt) < 60_000)) continue;
      r.nextCheckAt = stamp(this.now());
    }
    await this.store.save();
    void this.checkDue().catch(() => console.warn('Key status check deferred; storage unavailable.'));
  }
  private async checkLoop() {
    for (const c of this.credentials) {
      if (this.stopped || this.store.data.active) return;
      const r = this.record(c.id); if (Date.parse(r.nextCheckAt) > this.now()) continue;
      const lastAttempt = r.lastAttemptAt;
      let timedOut = false;
      const abort = this.probeAbort = new AbortController(); const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 15_000);
      let result: Awaited<ReturnType<KeyProbe>>;
      try { result = await this.probe(c.key, abort.signal); }
      catch (error) { if (error instanceof ProbeAccountingError) throw error; if (abort.signal.aborted && !timedOut) continue; result = { ok: false, kind: 'network_error' }; }
      finally { clearTimeout(timer); if (this.probeAbort === abort) this.probeAbort = undefined; }
      if (this.stopped || (abort.signal.aborted && !timedOut) || r.lastAttemptAt !== lastAttempt) continue;
      r.checks++; r.lastCheckAt = stamp(this.now());
      if (result.ok) await this.success(c.id, 'check'); else await this.failure(c.id, result.kind ?? 'unknown', 'check');
      console.log(`API key check: ${r.label}; status=${r.status}; checks=${r.checks}.`);
    }
  }
  start() { if (this.timer) return; const tick = () => void this.checkDue().catch(() => console.warn('Key status check deferred; storage unavailable.')); this.timer = setInterval(tick, 60_000); this.timer.unref(); tick(); }
  async stop() { this.stopped = true; clearInterval(this.timer); this.probeAbort?.abort(); await this.checking; }
  panel(id?: string, page = 0): { text: string; buttons: Buttons } {
    const rows = this.list(); const r = rows.find(x => x.id === id);
    const time = (v?: string) => v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : 'not yet';
    if (!r) return { text: `API key status · ${rows.length} keys\n\n` + rows.map(x => `${x.selected ? '▶ ' : ''}${x.label}: ${x.status}${x.lastError ? ' (' + x.lastError + ')' : ''}\nTask successes: ${x.successes} · Failures: ${x.failures}\nLast success: ${time(x.lastSuccessAt)}`).join('\n\n') + '\n\nAuto checks: healthy keys every 6h; credit/auth/limit failures every 30m; network/server failures every 2m. Checks wait while a task runs. Status is historical, not a credit balance. Tap a key for history.', buttons: [...rows.map(x => [button(x.label + ' · history', `keyhistory ${x.id} 0`)]), [button('Refresh', 'keys')], ...BACK] };
    const pages = Math.max(1, Math.ceil(r.history.length / 8)), p = Math.max(0, Math.min(pages - 1, page));
    const history = [...r.history].reverse().slice(p * 8, (p + 1) * 8);
    return { text: `${r.label} · ${r.status}${r.selected ? ' · selected' : ''}\nAttempts: ${r.attempts} · Completed: ${r.successes} · Failures: ${r.failures} · Checks: ${r.checks}\nLast success: ${time(r.lastSuccessAt)}\nLast failure: ${time(r.lastFailureAt)}\nLast check: ${time(r.lastCheckAt)}\nNext check: ${time(r.nextCheckAt)}\n\nHistory ${p + 1}/${pages}\n` + history.map(h => `${time(h.at)}\n${h.event}${h.reason ? ': ' + h.reason : ''} · ${h.source}`).join('\n\n'), buttons: [...(p > 0 ? [[button('Newer', `keyhistory ${id} ${p - 1}`)]] : []), ...(p + 1 < pages ? [[button('Older', `keyhistory ${id} ${p + 1}`)]] : []), [button('All keys', 'keys')], ...BACK] };
  }
}

/** One output token, fixed endpoint, no user content or raw error logging. */
export function messageProbe(ledger?: UsageLedger, fetcher: typeof fetch = fetch): KeyProbe {
  return async (key, signal) => {
    const response = await fetcher('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK.' }] }), signal, redirect: 'error' });
    const body = await response.json().catch(() => ({})) as { id?: string; model?: string; usage?: Record<string, unknown>; error?: { type?: string; message?: string } };
    if (response.ok && body.id && body.model && body.usage) {
      if (ledger) { try { await ledger.recordProbe(body.id, body.model, body.usage); } catch { throw new ProbeAccountingError('Probe usage storage failed.'); } }
      return { ok: true };
    }
    const detail = body.error?.message ?? '', type = body.error?.type;
    const kind: KeyReason = response.status === 401 ? 'authentication_failed'
      : /account.*hold|suspend/i.test(detail) ? 'account_on_hold'
      : /verif/i.test(detail) && response.status === 403 ? 'verification_required'
      : response.status === 402 || /credit balance|insufficient credit|credit.*too low/i.test(detail) ? 'billing_error'
      : response.status === 429 ? 'rate_limit' : response.status === 529 ? 'overloaded'
      : response.status >= 500 ? 'server_error' : response.status === 403 ? 'oauth_org_not_allowed'
      : response.status === 404 ? 'model_not_found' : type === 'invalid_request_error' ? 'invalid_request' : 'unknown';
    return { ok: false, kind };
  };
}
