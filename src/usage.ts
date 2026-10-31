import { open, mkdir, readFile, readdir, truncate } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { modelLabel } from './settings.js';

export interface Counts {
  inputTokens: number; outputTokens: number; cacheReadInputTokens: number;
  cacheCreationInputTokens: number; costUSD: number; webSearchRequests: number;
}
type Models = Record<string, Counts>;
type Entry = { kind: 'result'; id: string; session: string; at: string; models: Models; cost: number }
  | { kind: 'step'; id: string; requestId: string; session: string; at: string; model: string; counts: Counts; complete: boolean; priced: boolean };
interface Session { models: Models; cost: number; pending: Map<string, Extract<Entry, { kind: 'step' }>> }
const n = (x: unknown): number => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0;
const empty = (): Counts => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0 });
const fields = Object.keys(empty()) as (keyof Counts)[];
function cleanModels(raw: Record<string, unknown>): Models {
  const result: Models = Object.create(null);
  for (const [model, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    result[model] = Object.fromEntries(fields.map(k => [k, n((value as Record<string, unknown>)[k])])) as unknown as Counts;
  }
  return result;
}
function add(target: Counts, value: Counts): void { for (const key of fields) target[key] += value[key]; }

/** Durable, content-free accounting. Result snapshots replace session totals;
 * steps are provisional until the next cumulative result covers them. */
export class UsageLedger {
  private sessions = new Map<string, Session>();
  private seen = new Set<string>();
  private steps = new Map<string, Extract<Entry, { kind: 'step' }>>();
  private saving: Promise<void> = Promise.resolve();
  historyIncomplete = false;
  private constructor(readonly file: string) {}

  static async open(file: string): Promise<UsageLedger> {
    const ledger = new UsageLedger(file);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let bytes: Buffer;
    try { bytes = await readFile(file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ledger; throw new Error('Cannot load usage ledger.'); }
    // Only a torn final line is recoverable. Never silently discard interior records.
    let end = bytes.length;
    if (end && bytes[end - 1] !== 10) {
      end = bytes.lastIndexOf(10) + 1;
      await truncate(file, end);
      ledger.historyIncomplete = true;
    }
    try {
      for (const line of bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
        const entry = JSON.parse(line) as Entry;
        if (!['result', 'step'].includes(entry.kind) || typeof entry.id !== 'string' || typeof entry.session !== 'string'
          || !Number.isFinite(Date.parse(entry.at)) || (entry.kind === 'result' && (!entry.models || !Number.isFinite(entry.cost)))
          || (entry.kind === 'step' && (!entry.counts || typeof entry.model !== 'string'))) throw new Error('Invalid entry');
        ledger.apply(entry);
      }
    } catch { throw new Error('Cannot load usage ledger; restore or repair it before starting.'); }
    return ledger;
  }

  private apply(e: Entry): void {
    const key = `${e.kind}:${e.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    let session = this.sessions.get(e.session);
    if (!session) this.sessions.set(e.session, session = { models: Object.create(null), cost: 0, pending: new Map() });
    if (e.kind === 'step') {
      // A later stream delta replaces the message-start placeholder for the same API response.
      const previous = this.steps.get(e.requestId);
      if (!previous || !previous.complete || e.complete) {
        this.steps.set(e.requestId, e);
        session.pending.set(e.requestId, e);
      }
    } else {
      // Zeroed crash results must not wipe out saved usage or provisional steps.
      if (e.cost < session.cost || Object.keys(e.models).length === 0) return;
      for (const [model, value] of Object.entries(e.models)) {
        const previous = session.models[model] ?? empty();
        session.models[model] = Object.fromEntries(fields.map(k => [k, Math.max(previous[k], value[k])])) as unknown as Counts;
      }
      session.cost = Math.max(session.cost, e.cost);
      session.pending.clear();
    }
  }

  private async append(e: Entry): Promise<void> {
    const task = this.saving.then(async () => {
      if (this.seen.has(`${e.kind}:${e.id}`)) return;
      const handle = await open(this.file, 'a', 0o600);
      try { await handle.writeFile(JSON.stringify(e) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      this.apply(e);
    });
    this.saving = task.catch(() => {});
    await task;
  }

  async recordResult(session: string, id: string, models: Record<string, unknown>, cost: number, at = new Date().toISOString()): Promise<void> {
    await this.append({ kind: 'result', session, id, at, models: cleanModels(models), cost: n(cost) });
  }

  /** Serialized direct API checks have final usage but no SDK cumulative result. */
  async recordProbe(id: string, model: string, usage: Record<string, unknown>): Promise<void> {
    const sessionId = 'key-health-checks', resultId = 'key-health:' + id;
    if (this.seen.has('result:' + resultId)) return;
    await this.recordStep(sessionId, id, model, usage, true);
    const session = this.sessions.get(sessionId)!;
    const models = cleanModels(session.models); let cost = session.cost;
    for (const step of session.pending.values()) { add(models[step.model] ??= empty(), step.counts); cost += step.counts.costUSD; }
    await this.recordResult(sessionId, resultId, models, cost);
  }

  async recordStep(session: string, id: string, model: string, usage: Record<string, unknown>, complete: boolean, at = new Date().toISOString()): Promise<void> {
    // Only final stream deltas have reliable output counts. Transcript assistant
    // rows carry placeholders, so historical output is left explicitly partial.
    const counts = { ...empty(), inputTokens: n(usage.input_tokens), outputTokens: complete ? n(usage.output_tokens) : 0,
      cacheReadInputTokens: n(usage.cache_read_input_tokens), cacheCreationInputTokens: n(usage.cache_creation_input_tokens) };
    const price = model === 'claude-fable-5-1' ? [10, 50, 0.25] : model === 'claude-opus-5-5' ? [4, 20, 0.2] : model === 'claude-sonnet-5-5' ? [2, 10, 0.1] : undefined;
    if (price) {
      const factor = (usage.speed === 'fast' ? 2 : 1) * (usage.inference_geo === 'us' ? 1.1 : 1);
      const oneHour = n((usage.cache_creation as Record<string, unknown> | undefined)?.ephemeral_1h_input_tokens);
      counts.costUSD = factor * (counts.inputTokens * price[0] + counts.outputTokens * price[1]
        + counts.cacheReadInputTokens * price[2]
        + (counts.cacheCreationInputTokens - oneHour) * price[0] * 1.25 + oneHour * price[0] * 2) / 1e6;
      counts.webSearchRequests = n((usage.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests);
      counts.costUSD += counts.webSearchRequests * 0.01;
    }
    const requestId = `${session}:${id}`;
    const digest = createHash('sha256').update(JSON.stringify({ counts, complete })).digest('hex');
    const entry: Extract<Entry, { kind: 'step' }> = { kind: 'step', session, id: `${requestId}:${digest}`, requestId, model, at, counts, complete, priced: !!price };
    await this.append(entry);
  }

  totals(): { models: Models; costUSD: number; partial: boolean; sessions: number } {
    const models: Models = Object.create(null);
    let costUSD = 0, partial = this.historyIncomplete;
    for (const s of this.sessions.values()) {
      for (const [model, counts] of Object.entries(s.models)) add(models[model] ??= empty(), counts);
      costUSD += s.cost;
      for (const step of s.pending.values()) {
        add(models[step.model] ??= empty(), step.counts);
        costUSD += step.counts.costUSD;
        partial = true;
      }
    }
    return { models, costUSD, partial, sessions: this.sessions.size };
  }

  report(kind: 'tokens' | 'cost'): string {
    const t = this.totals();
    const total = Object.values(t.models).reduce((s, v) => s + v.inputTokens + v.outputTokens + v.cacheReadInputTokens + v.cacheCreationInputTokens, 0);
    const rows = Object.entries(t.models).sort((a, b) => b[1].costUSD - a[1].costUSD).map(([m, v]) => kind === 'cost'
      ? `${modelLabel(m)}: $${v.costUSD.toFixed(4)}`
      : `${modelLabel(m)}\nInput: ${v.inputTokens.toLocaleString('en-US')} · Output: ${v.outputTokens.toLocaleString('en-US')}\nCache read: ${v.cacheReadInputTokens.toLocaleString('en-US')} · Cache write: ${v.cacheCreationInputTokens.toLocaleString('en-US')}`);
    return (kind === 'cost' ? `Claude cost so far ≈ $${t.costUSD.toFixed(4)} USD` : `Overall recorded tokens: ${total.toLocaleString('en-US')}`)
      + '\n\n' + (rows.join('\n\n') || 'No recorded usage yet.')
      + `\n\nLifetime bot records · ${t.sessions} session(s). Includes recovered history; survives /new and restarts.`
      + (t.partial ? '\nPartial: some historical/interrupted requests have incomplete usage; totals are a lower estimate.' : '')
      + '\nSDK estimates; excludes unreported helper calls, other apps and hosting. Claude Console is the billing authority.';
  }

  async importHistory(root: string): Promise<void> {
    const known = new Set(this.sessions.keys());
    const snapshots = new Map<string, { data: any; at: string }>();
    type HistoricalStep = { session: string; id: string; model: string; usage: Record<string, unknown>; at: string };
    const looseSteps: HistoricalStep[] = [], tailSteps: HistoricalStep[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; this.historyIncomplete = true; return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { await walk(file); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        // Existing recorded sessions are already durable. Import only new histories;
        // replaying an old snapshot after new steps would hide partial work.
        const fallback = entry.name.slice(0, -6);
        if (known.has(fallback)) continue;
        const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        let fileSteps: HistoricalStep[] = [];
        let hadSnapshot = false;
        try {
          for await (const line of lines) {
            let row: any;
            try { row = JSON.parse(line); } catch { this.historyIncomplete = true; continue; }
            const session = String(row.sessionId ?? row.session_id ?? fallback);
            if (known.has(session)) continue;
            const at = Number.isFinite(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : new Date().toISOString();
            const data = [row, row.data, row.usage, row.stats].find(v => v && typeof v === 'object'
              && v.modelUsage && typeof (v.totalCostUSD ?? v.total_cost_usd) === 'number');
            if (data) {
              hadSnapshot = true;
              fileSteps = [];
              const previous = snapshots.get(session)?.data;
              if (!previous || (data.totalCostUSD ?? data.total_cost_usd) >= (previous.totalCostUSD ?? previous.total_cost_usd)) snapshots.set(session, { data, at });
            } else if (row.type === 'assistant' && row.message?.id && row.message?.model && row.message?.usage) {
              fileSteps.push({ session, id: row.message.id, model: row.message.model, usage: row.message.usage, at });
            }
          }
        } finally { lines.close(); }
        (hadSnapshot ? tailSteps : looseSteps).push(...fileSteps);
      }
    };
    await walk(root);
    // Parent cost-state snapshots already include subagents. Apply them after
    // all provisional history rows, so directory order cannot double-count.
    for (const [session, { data, at }] of snapshots) {
      const id = 'history-' + createHash('sha256').update(session + JSON.stringify(data.modelUsage) + (data.totalCostUSD ?? data.total_cost_usd)).digest('hex');
      await this.recordResult(session, id, data.modelUsage, data.totalCostUSD ?? data.total_cost_usd, at);
    }
    for (const step of [...looseSteps.filter(s => !snapshots.has(s.session)), ...tailSteps]) {
      await this.recordStep(step.session, step.id, step.model, step.usage, false, step.at);
    }
  }
}
