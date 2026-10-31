import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { AgentError, type Runner } from './agent.js';
import { StateStore } from './state.js';
import { authorized, projectName, redact, safeFile, secretPath, type Message } from './safety.js';

export interface Messenger {
  send(chat: number, text: string): Promise<void>;
  sendFile(chat: number, name: string, bytes: Uint8Array): Promise<void>;
  download(fileId: string): Promise<Buffer>;
}

const HELP = `Private Claude Code assistant
Send a task in plain text, or upload a document with instructions in its caption.
/status — current job, model and execution limits
/stop — cancel the running task (does not undo edits)
/new — fresh conversation, keep project files
/project NAME — create/switch project while idle
/projects — list project folders
/files — list files in current project
/get PATH — download a project file (up to 49 MB)
/help — this guide
Model: Sonnet 5.5 · Effort: high · Permissions: auto
Auto uses safety checks and can deny actions. No unrestricted permission bypass.
Uploads: documents up to 20 MB. No voice/photo transcription in this version.`;

export class Controller {
  private running?: { abort: AbortController; done: Promise<void> };
  private shuttingDown = false;
  private persistenceFailed = false;

  constructor(private config: Config, private store: StateStore, private messenger: Messenger, private runner: Runner) {}

  async idle(): Promise<void> { await this.running?.done; }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.running?.abort.abort();
    await this.idle();
  }

  private async say(text: string): Promise<void> {
    try { await this.messenger.send(this.config.owner, redact(text, [this.config.token, this.config.apiKey])); }
    catch { console.warn('Owner message delivery failed; job state was preserved.'); }
  }

  private async workspace(name = this.store.data.project): Promise<string> {
    projectName(name);
    const base = path.join(this.config.dataDir, 'workspaces');
    await mkdir(base, { recursive: true, mode: 0o700 });
    if ((await lstat(base)).isSymbolicLink()) throw new Error('Invalid workspaces directory.');
    const root = path.join(base, name);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Invalid project directory.');
    return root;
  }

  async handle(message: Message): Promise<void> {
    if (!authorized(message, this.config.owner) || this.shuttingDown) return;
    const text = message.text?.trim() ?? '';
    const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
    const command = match?.[1]?.toLowerCase();
    const argument = match?.[2]?.trim() ?? '';
    if (command === 'start' || command === 'help') return this.say(HELP);
    if (command === 'status') {
      const d = this.store.data;
      return this.say(`Project: ${d.project}\nModel: ${this.config.model}\nEffort: high · Permissions: auto\n` +
        `State: ${this.running ? 'running' : 'idle'}${d.active ? ' · job ' + d.active.id : ''}\n` +
        `Last job: ${d.lastJob?.status ?? 'none'}\nSpending cap: none (no bot-enforced billing limit).\n` +
        `Execution limits: ${this.config.maxTurns} turns; ${this.config.timeoutMs / 60_000} minutes per task.`);
    }
    if (command === 'stop') {
      if (!this.running) return this.say('No task is running.');
      this.running.abort.abort();
      return this.say('Stop requested. File edits already made are kept; external effects are not undone.');
    }
    if (this.running) return this.say('Busy with your current task. Use /status or /stop; send the next task after it finishes.');
    if (this.persistenceFailed) return this.say('State storage failed. Restart only after checking the persistent disk; new tasks are disabled.');
    try {
      const root = await this.workspace();
      if (command === 'new') {
        delete this.store.data.sessions[this.store.data.project];
        await this.store.save();
        return this.say('Fresh conversation started. Existing project files are unchanged.');
      }
      if (command === 'project') {
        const name = projectName(argument);
        await this.workspace(name);
        this.store.data.project = name;
        await this.store.save();
        return this.say(`Active project: ${name}. Its saved conversation will resume.`);
      }
      if (command === 'projects') {
        const entries = await readdir(path.dirname(root), { withFileTypes: true });
        return this.say(entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name).slice(0, 100).join('\n'));
      }
      if (command === 'files') return this.say((await this.listFiles(root)).join('\n') || 'No files yet.');
      if (command === 'get') {
        const file = await safeFile(root, argument);
        if ((await lstat(file)).size > 49_000_000) return this.say('File exceeds the 49 MB download limit.');
        await this.messenger.sendFile(this.config.owner, path.basename(file), await readFile(file));
        return;
      }
      if (command && command !== 'run') return this.say('Unknown command. Send /help, or /run followed by your task.');
      if (message.document) {
        if ((message.document.file_size ?? 0) > 20_000_000) return this.say('Upload exceeds 20 MB.');
        const uploads = path.join(root, 'uploads');
        await mkdir(uploads, { recursive: true });
        if ((await lstat(uploads)).isSymbolicLink()) throw new Error('Invalid uploads directory.');
        const base = path.basename((message.document.file_name ?? 'document.bin').replace(/\\/g, '/'));
        if (secretPath(base)) return this.say('Do not send credential files through Telegram. Configure secrets in Render.');
        const name = `${randomUUID()}-${base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'document.bin'}`;
        const bytes = await this.messenger.download(message.document.file_id);
        await writeFile(path.join(uploads, name), bytes, { flag: 'wx', mode: 0o600 });
        const relative = `uploads/${name}`;
        await this.say(`Uploaded: ${relative}`);
        if (message.caption?.trim()) await this.launch(`${message.caption.trim()}\n\nAttached file in this project: ${relative}`, root);
        return;
      }
      const prompt = command === 'run' ? argument : text;
      if (!prompt) return this.say('Send a text task or a file as a document. Use /help for commands.');
      await this.launch(prompt, root);
    } catch {
      await this.say('Could not process this request. Check the command, file path/size and storage. No automatic retry was performed.');
    }
  }

  private async launch(prompt: string, cwd: string): Promise<void> {
    const project = this.store.data.project;
    const job = { id: randomUUID().slice(0, 8), project, startedAt: new Date().toISOString() };
    this.store.data.active = job;
    try { await this.store.save(); } catch { this.persistenceFailed = true; throw new Error('Cannot persist job.'); }
    const abort = new AbortController();
    // Establish busy state before any asynchronous notifications or SDK work.
    const running = { abort, done: Promise.resolve() };
    this.running = running;
    running.done = this.execute(prompt, cwd, project, job, abort).finally(() => {
      if (this.running === running) this.running = undefined;
    });
    // Let synchronous SDK setup begin without waiting for the full task.
    await Promise.resolve();
  }

  private async execute(prompt: string, cwd: string, project: string, job: NonNullable<StateStore['data']['active']>, abort: AbortController): Promise<void> {
    let status: 'completed' | 'failed' | 'cancelled' = 'failed';
    let progress = 'Starting Claude Code';
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, this.config.timeoutMs);
    let sendingProgress = false;
    const heartbeat = setInterval(() => {
      if (!sendingProgress && !abort.signal.aborted) {
        sendingProgress = true;
        void this.say(`Job ${job.id}: ${progress}`).finally(() => { sendingProgress = false; });
      }
    }, 30_000);
    try {
      await this.say(`Started job ${job.id} in ${project}. Use /stop to cancel.`);
      const result = await this.runner.run({ prompt, cwd, session: this.store.data.sessions[project] }, async event => {
        if (event.type === 'session') {
          this.store.data.sessions[project] = event.id;
          await this.store.save();
        } else progress = event.text;
      }, abort);
      abort.signal.throwIfAborted();
      this.store.data.sessions[project] = result.session;
      status = 'completed';
      // Store a redacted result in the project so a Telegram outage is recoverable.
      const outputName = `result-${job.id}.txt`;
      await writeFile(path.join(cwd, outputName), redact(result.text, [this.config.token, this.config.apiKey]), { flag: 'wx', mode: 0o600 });
      const preview = result.text.length > 12000 ? result.text.slice(0, 12000) + `\n\nFull result: /get ${outputName}` : result.text;
      await this.say(preview);
      await this.say(`Job ${job.id} completed. Saved: ${outputName}\nSession cumulative estimate: $${result.cumulativeCost.toFixed(4)} (may include previous turns; excludes some helper calls).`);
    } catch (error) {
      status = abort.signal.aborted ? 'cancelled' : 'failed';
      await this.say(timedOut ? `Job ${job.id} reached its time limit and was stopped.`
        : abort.signal.aborted ? `Job ${job.id} stopped.`
        : error instanceof AgentError ? error.message : `Job ${job.id} failed. Check API credentials/access, limits and storage. Raw error details were withheld to protect secrets.`);
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat);
      this.store.data.lastJob = { ...job, status, finishedAt: new Date().toISOString() };
      this.store.data.active = null;
      try { await this.store.save(); }
      catch { this.persistenceFailed = true; console.error('Job state persistence failed; new jobs disabled.'); }
    }
  }

  private async listFiles(root: string): Promise<string[]> {
    const result: string[] = [];
    let scanned = 0;
    const walk = async (relative: string, depth: number) => {
      if (depth > 3 || result.length >= 100 || scanned > 500) return;
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        if (++scanned > 500 || result.length >= 100) break;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || secretPath(rel) || ['node_modules', '.venv', 'venv'].includes(entry.name)) continue;
        if (entry.isFile()) result.push(rel);
        else if (entry.isDirectory()) await walk(rel, depth + 1);
      }
    };
    await walk('', 0);
    return result;
  }
}
