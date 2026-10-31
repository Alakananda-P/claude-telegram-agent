import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { AgentError, type Runner } from './agent.js';
import { StateStore } from './state.js';
import { authorized, projectName, redact, safeFile, secretPath, type Message, type Callback } from './safety.js';
import { MODELS, EFFORTS, effectiveSettings, settingsLabel, modelLabel, type AgentSettings, type Effort } from './settings.js';
import { UsageLedger } from './usage.js';
import { SharedMemory } from './memory.js';
import { button, BACK, HOME, type Buttons } from './ui.js';
import { ChatArchive } from './chats.js';
import { SessionCatalog, sessionTitle } from './sessions.js';
import { TitleAccountingError, type TitleGenerator } from './titles.js';

export interface Messenger {
  send(chat: number, text: string): Promise<void>;
  sendFile(chat: number, name: string, bytes: Uint8Array): Promise<void>;
  download(fileId: string): Promise<Buffer>;
  temporary(chat: number, text: string): Promise<number>;
  edit(chat: number, id: number, text: string): Promise<void>;
  remove(chat: number, id: number): Promise<void>;
  typing(chat: number): Promise<void>;
  panel?(chat: number, text: string, buttons: Buttons, editId?: number): Promise<void>;
  acknowledge?(id: string): Promise<void>;
  clear?(chat: number, includeLegacy?: boolean): Promise<boolean>;
}

const HELP = `Your Claude assistant
Send a task in plain text, or upload a document with instructions in its caption.
/menu — buttons for all controls
/model fable|opus|sonnet — choose model
/efforts low|medium|high|xhigh|max — reasoning effort
/fast on|off — Opus Fast mode preference
/token count — lifetime tokens by model (also /tokens)
/cost — lifetime estimated Claude cost by model
/session — saved chats; /session ID to resume
/rename TITLE — rename the current chat
/new chat — fresh chat, keep files and shared memory
/memory — shared memory; on, off, remember TEXT, clear
/status — current job, model and execution limits
/stop — cancel the running task (does not undo edits)
/new — fresh conversation, keep project files
/project NAME — create/switch project while idle
/projects — list project folders
/files — list files in current project
/get PATH — download a project file (up to 49 MB)
/help — this guide
Auto uses safety checks and can deny actions. No unrestricted permission bypass.
Uploads: documents up to 20 MB. No voice/photo transcription in this version.`;

export class Controller {
  private running?: { abort: AbortController; done: Promise<void> };
  private shuttingDown = false;
  private persistenceFailed = false;
  private panelId?: number;
  private memory: SharedMemory;
  private chats: ChatArchive;
  readonly sessions: SessionCatalog;

  constructor(private config: Config, private store: StateStore, private messenger: Messenger, private runner: Runner, private ledger?: UsageLedger, private titles?: TitleGenerator) {
    this.memory = new SharedMemory(config.dataDir, [config.token, config.apiKey]);
    this.chats = new ChatArchive(path.join(config.dataDir, 'bot', 'chats'), [config.token, config.apiKey]);
    this.sessions = new SessionCatalog(store, this.chats, [config.token, config.apiKey]);
  }

  async prepareSessions(signal: AbortSignal): Promise<void> {
    await this.sessions.backfill();
    let named = 0;
    if (this.titles) for (const record of this.store.data.conversations ?? []) {
      if (signal.aborted) break;
      if (await this.sessions.autoName(record.id, turns => this.titles!.generate(turns, signal))) named++;
    }
    console.log(`Session catalog ready: chats=${this.sessions.context().total}; generatedNames=${named}; tools=list,read,rename,search,memory.`);
  }

  private get settings(): AgentSettings { return this.store.data.settings ?? { model: this.config.model, effort: this.config.effort, fast: this.config.fast }; }

  private async panel(text: string, buttons: Buttons = BACK): Promise<void> {
    if (!this.messenger.panel) return this.say(text);
    try { await this.messenger.panel(this.config.owner, text, buttons, this.panelId); }
    catch { await this.say(text); }
  }

  async menu(): Promise<void> {
    await this.panel(`Claude · Your workspace\n\n${settingsLabel(this.settings)}\nProject: ${this.store.data.project}\nMemory: ${this.store.data.memoryEnabled !== false ? 'ON · shared across chats' : 'OFF'}\n${this.running ? 'Working on your task…' : 'Ready for your next task.'}\n\nSend a message or choose a control below.`, HOME);
  }

  async callback(callback: Callback): Promise<void> {
    if (!callback.message || !authorized({ ...callback.message, from: callback.from }, this.config.owner)) return;
    await this.messenger.acknowledge?.(callback.id).catch(() => {});
    const data = callback.data ?? '';
    if (!/^(menu|help|status|stop|rename|new chat|model(?: (?:fable|opus|sonnet))?|efforts(?: (?:low|medium|high|xhigh|max))?|fast(?: (?:on|off))?|token count|cost|memory(?: (?:on|off|confirm-clear|clear))?|session(?: [a-zA-Z0-9_-]+)?|sessionpage \d+|history [a-zA-Z0-9_-]+ \d+|projects|project [a-zA-Z0-9_-]+|files)$/.test(data)) return;
    this.panelId = callback.message.message_id;
    try {
      if (data === 'memory confirm-clear') {
        await this.panel('Clear shared memory? Saved conversations and files will stay.', [[button('Clear memory', 'memory clear')], ...BACK]);
      } else await this.handle({ ...callback.message, from: callback.from, text: '/' + data, document: undefined, caption: undefined });
    } finally { this.panelId = undefined; }
  }

  async cleanIndicators(): Promise<void> {
    const remaining: number[] = [];
    for (const id of this.store.data.indicatorIds ?? []) {
      try { await this.messenger.remove(this.config.owner, id); }
      catch { remaining.push(id); }
    }
    this.store.data.indicatorIds = remaining.slice(-10);
    await this.store.save();
  }

  private chatKey(): string { return this.store.data.sessions[this.store.data.project] ?? 'draft-' + this.store.data.project; }

  private async clearScreen(): Promise<void> {
    const cleared = await this.messenger.clear?.(this.config.owner);
    this.panelId = undefined;
    if (cleared === false) await this.say('Some older messages could not be removed by Telegram. The selected chat will appear below.');
  }

  private async history(id: string, page?: number): Promise<void> {
    if (!this.store.data.conversations?.some(s => s.id === id)) return this.panel('Saved chat not found.');
    if (this.store.data.sessions[this.store.data.project] !== id) return this.panel('Resume this saved chat before viewing its messages.', [[button('Resume chat', 'session ' + id)], ...BACK]);
    const turns = await this.chats.read(id);
    const pages = Math.max(1, Math.ceil(turns.length / 6));
    const current = Math.min(pages - 1, Math.max(0, page ?? pages - 1));
    const previews = turns.slice(current * 6, current * 6 + 6).map(turn => {
      const text = turn.text.replace(/\s+/g, ' ').trim();
      return `${turn.role === 'user' ? 'You' : 'Claude'}\n${text.slice(0, 360)}${text.length > 360 ? '…' : ''}`;
    });
    const nav = [];
    if (current > 0) nav.push(button('‹ Older', `history ${id} ${current - 1}`));
    if (current < pages - 1) nav.push(button('Newer ›', `history ${id} ${current + 1}`));
    const record = this.store.data.conversations!.find(s => s.id === id)!;
    return this.panel(`${sessionTitle(record)}\nChat overview · Page ${current + 1}/${pages}\n${this.store.data.project} · ${id.slice(0, 8)}\n\n${previews.join('\n\n') || 'No recoverable messages for this session.'}\n\nSaved message previews. Send a message to continue this chat.`, [
      ...(nav.length ? [nav] : []), [button('💬 Sessions', 'session'), button('➕ New chat', 'new chat')], [button('✏️ Rename chat', 'rename')], ...BACK]);
  }

  private async session(id: string, project: string): Promise<void> {
    this.store.data.sessions[project] = id;
    const list = this.store.data.conversations ??= [];
    const record = list.find(s => s.id === id);
    if (record) record.updatedAt = new Date().toISOString();
    else list.push({ id, project, updatedAt: new Date().toISOString() });
    await this.sessions.ensureName(id);
    await this.store.save();
  }

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

  private async controls(command: string, page = 0): Promise<void> {
    const s = this.settings;
    if (command === 'model') return this.panel(`Model\n\nCurrent: ${settingsLabel(s)}\nChoose the model for your next task.`, [
      [button((s.model === MODELS.fable ? '✓ ' : '') + 'Fable 5.1', 'model fable')],
      [button((s.model === MODELS.opus ? '✓ ' : '') + 'Opus 5.5', 'model opus'), button((s.model === MODELS.sonnet ? '✓ ' : '') + 'Sonnet 5.5', 'model sonnet')], ...BACK]);
    if (command === 'efforts' || command === 'effort') return this.panel(`Reasoning effort\n\nCurrent: ${s.effort}\nHigher effort can take longer and use more tokens.`, [
      EFFORTS.slice(0, 3).map(v => button((s.effort === v ? '✓ ' : '') + v, 'efforts ' + v)),
      EFFORTS.slice(3).map(v => button((s.effort === v ? '✓ ' : '') + v, 'efforts ' + v)), ...BACK]);
    if (command === 'fast') return this.panel(`Speed\n\n${settingsLabel(s)}\nFast preference: ${s.fast ? 'ON' : 'OFF'}\nFast mode applies to Opus; Fable and Sonnet use standard speed. Provider capacity can temporarily put Fast mode in cooldown.`, [
      [button('⚡ Fast ON', 'fast on'), button('Standard', 'fast off')], ...BACK]);
    if (command === 'memory') {
      const content = await this.memory.read();
      return this.panel(`Shared memory · ${this.store.data.memoryEnabled !== false ? 'ON' : 'OFF'}\n\n${content.slice(0, 2400) || 'Nothing saved yet. Tell me what to remember, or use /memory remember TEXT.'}${content.length > 2400 ? '\n…Ask me to show or tidy the rest.' : ''}\n\nShared across every project and new chat. Turning it off does not erase old conversation history.`, [
        [button('Memory ON', 'memory on'), button('Memory OFF', 'memory off')], [button('Clear saved memory', 'memory confirm-clear')], ...BACK]);
    }
    const list = [...(this.store.data.conversations ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const active = this.store.data.sessions[this.store.data.project];
    const pages = Math.max(1, Math.ceil(list.length / 8));
    const current = Math.min(pages - 1, Math.max(0, page));
    const slice = list.slice(current * 8, current * 8 + 8);
    const descriptions = slice.map(x => `${x.id === active ? '✓ ' : ''}${sessionTitle(x)}\n${x.project} · ${x.id.slice(0, 8)} · ${x.updatedAt.slice(0, 16).replace('T', ' ')} UTC`);
    const nav = [];
    if (current > 0) nav.push(button('‹ Previous', 'sessionpage ' + (current - 1)));
    if (current < pages - 1) nav.push(button('Next ›', 'sessionpage ' + (current + 1)));
    return this.panel(`Saved conversations · ${list.length} chats · Page ${current + 1}/${pages}\n\n${descriptions.join('\n\n') || 'No saved chats yet.'}\n\nTap to resume. /session ID also works. Ask Claude to find a past chat or change its name.`, [
      ...slice.map(x => [button(`${x.id === active ? '✓ ' : ''}${sessionTitle(x)}`, 'session ' + x.id)]),
      ...(nav.length ? [nav] : []),
      [button('➕ New chat', 'new chat')], ...BACK]);
  }

  async handle(message: Message): Promise<void> {
    if (!authorized(message, this.config.owner) || this.shuttingDown) return;
    if (message.message_id !== undefined) {
      const ids = this.store.data.visibleMessageIds ??= [];
      if (!ids.includes(message.message_id)) { ids.push(message.message_id); await this.store.save(); }
    }
    const text = message.text?.trim() ?? '';
    const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
    const command = match?.[1]?.toLowerCase();
    const argument = match?.[2]?.trim() ?? '';
    if (command === 'start' || command === 'menu') return this.menu();
    if (command === 'help') return this.panel(HELP);
    if (command === 'rename' && !argument) return this.panel('Send /rename followed by the new title, or ask Claude to rename this chat.');
    if (command === 'sessionpage') return this.controls('session', Math.max(0, Math.floor(Number(argument) || 0)));
    if (command === 'history') {
      const [id, page] = argument.split(' ');
      return this.history(id, Number(page) || 0);
    }
    if (command === 'token' || command === 'tokens' || command === 'cost') {
      return this.panel(this.ledger?.report(command === 'cost' ? 'cost' : 'tokens') ?? 'Usage records are not available yet.');
    }
    if (command === 'status') {
      const d = this.store.data;
      return this.panel(`Project: ${d.project}\n${settingsLabel(this.settings)} · Permissions: auto\n` +
        `State: ${this.running ? 'running' : 'idle'}\nMemory: ${d.memoryEnabled !== false ? 'ON' : 'OFF'}\nLast reported speed: ${d.lastSpeed ?? 'not observed yet'}\n` +
        `Last job: ${d.lastJob?.status ?? 'none'}\nSpending cap: none (no bot-enforced billing limit).\n` +
        `Execution limits: ${this.config.maxTurns} turns; ${this.config.timeoutMs / 60_000} minutes per task.`);
    }
    if (['model', 'efforts', 'effort', 'fast', 'session', 'memory'].includes(command ?? '') && !argument) {
      return this.controls(command!);
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
      if (command === 'rename') {
        const id = this.store.data.sessions[this.store.data.project];
        if (!id) return this.panel('Send your first task to start this chat, then rename it.');
        await this.sessions.rename(id, argument, 'manual');
        return this.controls('session');
      }
      if (['model', 'efforts', 'effort', 'fast'].includes(command ?? '')) {
        const next = { ...this.settings };
        if (command === 'model') {
          const model = MODELS[argument.toLowerCase() as keyof typeof MODELS] ?? argument;
          if (!Object.values(MODELS).includes(model as typeof MODELS.opus)) return this.panel('Choose fable, opus or sonnet.');
          next.model = model;
        } else if (command === 'fast') {
          if (!['on', 'off'].includes(argument.toLowerCase())) return this.panel('Use /fast on or /fast off.');
          next.fast = argument.toLowerCase() === 'on';
        } else {
          if (!EFFORTS.includes(argument.toLowerCase() as Effort)) return this.panel('Choose low, medium, high, xhigh or max.');
          next.effort = argument.toLowerCase() as Effort;
        }
        this.store.data.settings = next;
        await this.store.save();
        return this.controls(command!);
      }
      if (command === 'memory') {
        if (argument === 'on' || argument === 'off') {
          this.store.data.memoryEnabled = argument === 'on';
          await this.store.save();
        } else if (argument === 'clear') await this.memory.clear();
        else if (argument.startsWith('remember ')) await this.memory.remember(argument.slice(9));
        else return this.panel('Use /memory on, /memory off, /memory remember TEXT, or /memory clear.');
        return this.controls('memory');
      }
      if (command === 'session') {
        const found = this.store.data.conversations?.filter(s => s.id === argument || s.id.startsWith(argument));
        if (!found || found.length !== 1) return this.panel('Session not found or ID is ambiguous. Choose one from /session.');
        await this.workspace(found[0].project);
        this.store.data.project = found[0].project;
        await this.session(found[0].id, found[0].project);
        await this.clearScreen();
        return this.history(found[0].id);
      }
      if (command === 'new') {
        delete this.store.data.sessions[this.store.data.project];
        await this.store.save();
        await this.chats.resetDraft(this.store.data.project);
        await this.clearScreen();
        return this.panel('New chat ready. Your previous chat is in Sessions. Files and shared memory are kept.', HOME);
      }
      if (command === 'project') {
        const name = projectName(argument);
        await this.workspace(name);
        this.store.data.project = name;
        await this.store.save();
        return this.panel(`Active project: ${name}. Its saved conversation will resume.`, HOME);
      }
      if (command === 'projects') {
        const entries = await readdir(path.dirname(root), { withFileTypes: true });
        const names = entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name).slice(0, 20);
        return this.panel('Projects\n\nChoose a project below. To create one, send /project NAME.', [...names.map(name => [button((name === this.store.data.project ? '✓ ' : '') + name, 'project ' + name)]), ...BACK]);
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
        await this.chats.append(this.chatKey(), { role: 'user', text: `📎 ${base}`, file: { id: message.document.file_id, name: base } });
        await this.say(`📎 ${base} received.`);
        if (message.caption?.trim()) await this.launch(`${message.caption.trim()}\n\nAttached file in this project: ${relative}`, root, message.caption.trim());
        return;
      }
      const prompt = command === 'run' ? argument : text;
      if (!prompt) return this.say('Send a text task or a file as a document. Use /help for commands.');
      await this.launch(prompt, root);
    } catch {
      await this.say('Could not process this request. Check the command, file path/size and storage. No automatic retry was performed.');
    }
  }

  private async launch(prompt: string, cwd: string, displayPrompt = prompt): Promise<void> {
    await this.chats.append(this.chatKey(), { role: 'user', text: displayPrompt });
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
    let archiveKey = this.chatKey();
    let progress = 'Thinking…';
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, this.config.timeoutMs);
    let indicator: number | undefined;
    let lastProgress = progress;
    let lastEdit = Date.now();
    let uiWork: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (!uiWork && !abort.signal.aborted) {
        uiWork = (async () => {
          await this.messenger.typing(this.config.owner).catch(() => {});
          if (indicator !== undefined && progress !== lastProgress && Date.now() - lastEdit >= 8000) {
            await this.messenger.edit(this.config.owner, indicator, progress).catch(() => {});
            lastProgress = progress; lastEdit = Date.now();
          }
        })().finally(() => { uiWork = undefined; });
      }
    }, 4000);
    const finishIndicator = async () => {
      clearInterval(heartbeat);
      await uiWork;
      if (indicator === undefined) return;
      try {
        await this.messenger.remove(this.config.owner, indicator);
        this.store.data.indicatorIds = this.store.data.indicatorIds?.filter(id => id !== indicator);
      } catch { /* Kept in state for cleanup on restart. */ }
      indicator = undefined;
    };
    try {
      indicator = await this.messenger.temporary(this.config.owner, progress).catch(() => undefined);
      if (indicator !== undefined) {
        (this.store.data.indicatorIds ??= []).push(indicator);
        await this.store.save();
      }
      abort.signal.throwIfAborted();
      const selected = effectiveSettings(this.settings);
      const result = await this.runner.run({ prompt, cwd, session: this.store.data.sessions[project], settings: selected, memoryEnabled: this.store.data.memoryEnabled !== false, sessions: this.sessions }, async event => {
        if (event.type === 'session') {
          await this.chats.bind(archiveKey, event.id);
          archiveKey = event.id;
          await this.session(event.id, project);
        } else if (event.type === 'usage' || event.type === 'step') {
          try {
            if (event.type === 'usage') await this.ledger?.recordResult(event.session, event.id, event.models, event.cost);
            else await this.ledger?.recordStep(event.session, event.id, event.model, event.usage, event.complete);
          } catch { this.persistenceFailed = true; abort.abort(); throw new AgentError('Usage storage failed. Work stopped to protect your records.'); }
        } else if (event.type === 'speed') this.store.data.lastSpeed = event.state;
        else progress = event.text;
      }, abort);
      abort.signal.throwIfAborted();
      await this.session(result.session, project);
      await this.chats.bind(archiveKey, result.session);
      await this.chats.append(result.session, { role: 'assistant', text: result.text });
      // Store a redacted result in the project so a Telegram outage is recoverable.
      const outputName = `result-${job.id}.txt`;
      await writeFile(path.join(cwd, outputName), redact(result.text, [this.config.token, this.config.apiKey]), { flag: 'wx', mode: 0o600 });
      status = 'completed';
      const preview = result.text.length > 12000 ? result.text.slice(0, 12000) + `\n\nFull result: /get ${outputName}` : result.text;
      await finishIndicator();
      await this.say(preview);
      if (this.titles && !abort.signal.aborted) await this.sessions.autoName(result.session, turns => this.titles!.generate(turns, abort.signal));
      console.log(`Claude task completed: ${selected.model}; effort=${selected.effort}; requestedFast=${selected.fast}; reportedSpeed=${this.store.data.lastSpeed ?? 'unknown'}.`);
    } catch (error) {
      if (error instanceof TitleAccountingError) this.persistenceFailed = true;
      status = abort.signal.aborted ? 'cancelled' : 'failed';
      await finishIndicator();
      await this.say(timedOut ? 'This task reached its time limit and was stopped.'
        : this.persistenceFailed ? 'Usage storage failed. New tasks are paused until storage is restored.'
        : abort.signal.aborted ? 'Task stopped.'
        : error instanceof AgentError ? error.message : 'The task could not finish. Check API access and storage, or try a smaller task.');
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat);
      await finishIndicator();
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
