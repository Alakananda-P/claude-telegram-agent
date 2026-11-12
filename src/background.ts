import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, rename, access } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { z } from 'zod';
import { configSecrets, type Config } from './config.js';
import type { StateStore } from './state.js';
import { safeFile, projectName, redact } from './safety.js';

export const backgroundJobSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/), project: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/), chatKey: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  name: z.string().min(1).max(80), script: z.string().min(1).max(500), runtime: z.enum(['node', 'python', 'bash']), args: z.array(z.string().max(2000)).max(32),
  status: z.enum(['starting', 'running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted']),
  createdAt: z.string().datetime(), startedAt: z.string().datetime().optional(), finishedAt: z.string().datetime().optional(),
  timeoutMs: z.number().int().min(1000).max(7_200_000), exitCode: z.number().int().optional(), truncated: z.boolean().optional(),
  notifiedAt: z.string().datetime().optional(), notificationAttempts: z.number().int().nonnegative().optional(), notifyAfter: z.string().datetime().optional(),
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;
export interface BackgroundInput { name: string; project: string; chatKey: string; root: string; script: string; runtime: BackgroundJob['runtime']; args?: string[]; timeoutMs?: number }
export class BackgroundError extends Error {}
type LiveJob = { child: ChildProcess; stdoutRaw: string; stderrRaw: string; out: StringDecoder; err: StringDecoder; done: Promise<void>; resolve: () => void; reason?: BackgroundJob['status']; finishing?: boolean; timeout?: ReturnType<typeof setTimeout>; killTimer?: ReturnType<typeof setTimeout>; flushTimer?: ReturnType<typeof setTimeout>; writing: Promise<void> };
const terminal = (job: BackgroundJob) => !['starting', 'running'].includes(job.status);
const OUTPUT_LIMIT = 262_144;

/** Processes belong to the bot worker, never to an individual SDK query. */
export class BackgroundJobs {
  private live = new Map<string, LiveJob>();
  private starting = new Set<Promise<BackgroundJob>>();
  private closing = false;
  private storageFailed = false;
  private notifying?: Promise<void>;
  private secrets: string[];
  private dir: string;
  constructor(private config: Config, private store: StateStore, private notify: (job: BackgroundJob) => Promise<void>) {
    store.data.backgroundJobs ??= []; this.secrets = configSecrets(config); this.dir = path.join(path.dirname(store.file), 'background');
  }
  private job(id: string): BackgroundJob { const job = this.store.data.backgroundJobs!.find(j => j.id === id); if (!job) throw new BackgroundError('Background job not found.'); return job; }
  list(offset = 0, limit = 20): BackgroundJob[] { return this.store.data.backgroundJobs!.slice().reverse().slice(Math.max(0, offset), Math.max(0, offset) + Math.min(50, Math.max(1, limit))).map(j => ({ ...j, args: [...j.args] })); }
  private logFile(id: string) { if (!/^[a-f0-9]{16}$/.test(id)) throw new BackgroundError('Invalid background job ID.'); return path.join(this.dir, id + '.log'); }
  private safeOutput(raw: string): string {
    let safe = redact(raw, this.secrets);
    // Redact an unfinished credential at a stream boundary too. Raw buffers stay
    // only in memory; only this redacted representation is written to disk.
    for (const secret of this.secrets.filter(Boolean)) for (let n = Math.min(secret.length - 1, safe.length); n > 0; n--) {
      if (safe.endsWith(secret.slice(0, n))) { safe = safe.slice(0, -n) + '[REDACTED]'; break; }
    }
    return safe;
  }
  private async logDirectory() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if ((await lstat(this.dir)).isSymbolicLink()) throw new BackgroundError('Background log storage is unavailable.');
  }
  private flush(job: BackgroundJob, live: LiveJob) {
    const text = this.safeOutput(live.stdoutRaw) + (live.stderrRaw ? '\n[stderr]\n' + this.safeOutput(live.stderrRaw) : '') + (job.truncated ? '\n[Further output omitted: 256 KiB log limit.]' : '');
    const file = this.logFile(job.id);
    live.writing = live.writing.then(async () => {
      await this.logDirectory();
      const temporary = file + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, file);
    });
    return live.writing;
  }
  private append(job: BackgroundJob, live: LiveJob, text: string, stream: 'stdoutRaw' | 'stderrRaw' = 'stdoutRaw') {
    const remaining = Math.max(0, OUTPUT_LIMIT - Buffer.byteLength(live.stdoutRaw) - Buffer.byteLength(live.stderrRaw));
    const bytes = Buffer.from(text); live[stream] += bytes.subarray(0, remaining).toString('utf8'); if (bytes.length > remaining) job.truncated = true;
    if (!live.flushTimer && !live.finishing) live.flushTimer = setTimeout(() => {
      live.flushTimer = undefined; void this.flush(job, live).catch(() => { this.storageFailed = true; console.error('Background log storage failed; new background jobs disabled.'); });
    }, 500);
  }
  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
    env.HOME = path.join(this.config.dataDir, 'home'); env.USERPROFILE = env.HOME; env.VIRTUAL_ENV = path.join(this.config.dataDir, 'venv');
    return env;
  }
  start(input: BackgroundInput): Promise<BackgroundJob> {
    const pending = this.launch(input); this.starting.add(pending);
    void pending.finally(() => this.starting.delete(pending)).catch(() => {}); return pending;
  }
  private async launch(input: BackgroundInput): Promise<BackgroundJob> {
    if (this.closing || this.storageFailed) throw new BackgroundError('Background execution is stopped or its storage needs attention.');
    projectName(input.project);
    const expected = path.join(this.config.dataDir, 'workspaces', input.project);
    if (path.resolve(input.root) !== path.resolve(expected) || (await lstat(path.dirname(expected))).isSymbolicLink() || (await lstat(expected)).isSymbolicLink()) throw new BackgroundError('Choose a regular project workspace.');
    const script = await safeFile(expected, input.script);
    const extensions = { node: /\.(?:js|mjs|cjs)$/i, python: /\.py$/i, bash: /\.sh$/i };
    if (!extensions[input.runtime]?.test(script) || (await lstat(script)).size > 2_000_000) throw new BackgroundError('Choose a Node .js/.mjs/.cjs, Python .py, or Bash .sh project script up to 2 MB.');
    const parsed = backgroundJobSchema.safeParse({ id: randomUUID().replaceAll('-', '').slice(0, 16), project: input.project, chatKey: input.chatKey, name: input.name, script: input.script, runtime: input.runtime, args: input.args ?? [], status: 'starting', createdAt: new Date().toISOString(), timeoutMs: input.timeoutMs ?? 3_600_000 });
    if (!parsed.success) throw new BackgroundError('Invalid background job settings; use up to 32 arguments and a timeout of 1 second to 120 minutes.');
    const job = parsed.data;
    if ([job.name, job.script, ...job.args].some(v => v.includes('\0') || redact(v, this.secrets) !== v)) throw new BackgroundError('Do not put service credentials in job names, paths or arguments.');
    await this.logDirectory();
    let executable = process.execPath, prefix: string[] = [];
    if (job.runtime === 'python') {
      executable = path.join(this.config.dataDir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      try { await access(executable); } catch { executable = process.platform === 'win32' ? 'python' : 'python3'; }
      prefix = ['-u'];
    } else if (job.runtime === 'bash') { executable = process.platform === 'win32' ? 'bash.exe' : '/bin/bash'; prefix = ['--noprofile', '--norc']; }
    // Reserve synchronously after all validation awaits, so concurrent starts
    // cannot both observe the same free slot.
    if (this.closing || this.storageFailed) throw new BackgroundError('Background execution is stopped or its storage needs attention.');
    if (this.store.data.backgroundJobs!.filter(j => !terminal(j)).length >= 2) throw new BackgroundError('At most two background jobs may run at once.');
    this.store.data.backgroundJobs!.push(job);
    try { await this.store.save(); } catch { this.storageFailed = true; job.status = 'failed'; throw new BackgroundError('Background state could not be saved; no process was started.'); }
    if (this.closing) { job.status = 'interrupted'; job.finishedAt = new Date().toISOString(); await this.store.save(); throw new BackgroundError('The worker is stopping; no process was started.'); }
    const child = spawn(executable, [...prefix, script, ...job.args], { cwd: expected, env: this.environment(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let resolve!: () => void;
    const live: LiveJob = { child, stdoutRaw: '', stderrRaw: '', out: new StringDecoder('utf8'), err: new StringDecoder('utf8'), done: new Promise<void>(r => { resolve = r; }), resolve: () => resolve(), writing: Promise.resolve() };
    this.live.set(job.id, live); job.status = 'running'; job.startedAt = new Date().toISOString();
    const finish = (code?: number) => void this.finish(job, live, code).catch(() => { this.storageFailed = true; this.live.delete(job.id); console.error('Background completion storage failed; new background jobs disabled.'); live.resolve(); });
    child.stdout!.on('data', bytes => this.append(job, live, live.out.write(bytes)));
    child.stderr!.on('data', bytes => this.append(job, live, live.err.write(bytes), 'stderrRaw'));
    child.once('error', () => { this.append(job, live, 'The project process could not start.'); finish(); });
    child.once('close', code => finish(code ?? undefined));
    live.timeout = setTimeout(() => { live.reason = 'timed_out'; this.terminate(live); }, job.timeoutMs); live.timeout.unref();
    try { await this.store.save(); } catch { this.storageFailed = true; live.reason = 'interrupted'; this.terminate(live); throw new BackgroundError('Background state could not be saved; the process was stopped.'); }
    return { ...job, args: [...job.args] };
  }
  private terminate(live: LiveJob) {
    if (live.finishing) return;
    const kill = (signal: NodeJS.Signals) => { try { if (process.platform !== 'win32' && live.child.pid) process.kill(-live.child.pid, signal); else live.child.kill(signal); } catch { /* Already exited. Only this worker's live process handles are used. */ } };
    kill('SIGTERM'); if (!live.killTimer) { live.killTimer = setTimeout(() => kill('SIGKILL'), 2000); live.killTimer.unref(); }
  }
  private async finish(job: BackgroundJob, live: LiveJob, code?: number) {
    if (live.finishing) return; live.finishing = true;
    clearTimeout(live.timeout); clearTimeout(live.killTimer); clearTimeout(live.flushTimer);
    this.append(job, live, live.out.end()); this.append(job, live, live.err.end(), 'stderrRaw');
    job.status = live.reason ?? (code === 0 ? 'completed' : 'failed'); job.finishedAt = new Date().toISOString(); if (code !== undefined) job.exitCode = code;
    await this.flush(job, live); await this.store.save();
    this.live.delete(job.id); live.resolve();
    if (!this.closing) await this.tick();
  }
  async wait(id: string): Promise<void> { this.job(id); await this.live.get(id)?.done; }
  async read(id: string, offset = 0, limit = 6000) {
    const job = this.job(id), live = this.live.get(id);
    if (live) await this.flush(job, live);
    let text: string;
    try { await this.logDirectory(); text = redact(await readFile(await safeFile(this.dir, id + '.log'), 'utf8'), this.secrets); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BackgroundError('Background output could not be read.'); text = ''; }
    const start = Math.max(0, Math.floor(offset)), end = start + Math.min(12000, Math.max(1, Math.floor(limit)));
    return { job: { ...job, args: [...job.args] }, text: text.slice(start, end), nextOffset: end < text.length ? end : undefined, totalCharacters: text.length };
  }
  async cancel(id: string) { const job = this.job(id), live = this.live.get(id); if (live && !live.finishing) { live.reason ??= 'cancelled'; this.terminate(live); await live.done; } return { ...job, args: [...job.args] }; }
  tick(now = Date.now()): Promise<void> {
    if (this.notifying) return this.notifying;
    this.notifying = this.notifyDue(now).finally(() => { this.notifying = undefined; }); return this.notifying;
  }
  private async notifyDue(now: number) {
    if (this.closing || this.storageFailed) return;
    for (const job of this.store.data.backgroundJobs!) {
      if (!terminal(job) || job.notifiedAt || (job.notifyAfter && Date.parse(job.notifyAfter) > now)) continue;
      job.notificationAttempts = (job.notificationAttempts ?? 0) + 1;
      try { await this.notify({ ...job, args: [...job.args] }); job.notifiedAt = new Date(now).toISOString(); delete job.notifyAfter; }
      catch { job.notifyAfter = new Date(now + 30_000).toISOString(); console.warn('Background completion delivery deferred; saved output is available.'); }
      await this.store.save();
    }
  }
  async stop(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.starting]);
    for (const live of this.live.values()) { live.reason ??= 'interrupted'; this.terminate(live); }
    await Promise.all([...this.live.values()].map(live => live.done)); await this.notifying;
  }
}
