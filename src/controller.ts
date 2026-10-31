import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile, statfs } from 'node:fs/promises';
import { configSecrets, type Config } from './config.js';
import { AgentError, AgentApiError, type Runner } from './agent.js';
import { StateStore } from './state.js';
import { authorized, projectName, redact, safeFile, secretPath, type Message, type Callback } from './safety.js';
import { MODELS, EFFORTS, effectiveSettings, settingsLabel, modelLabel, type AgentSettings, type Effort } from './settings.js';
import { UsageLedger } from './usage.js';
import { SharedMemory } from './memory.js';
import { button, BACK, HOME, type Buttons } from './ui.js';
import { ChatArchive } from './chats.js';
import { SessionCatalog, sessionTitle } from './sessions.js';
import { TitleAccountingError, type TitleGenerator } from './titles.js';
import { Automation, clockInfo, type Task, type Batch } from './automation.js';
import { artifactSnapshot, changedArtifacts } from './artifacts.js';
import { Backups } from './backup.js';

export interface Messenger {
  send(chat: number, text: string): Promise<void>;
  sendFile(chat: number, name: string, bytes: Uint8Array): Promise<void>;
  sendPhoto?(chat: number, name: string, bytes: Uint8Array, caption?: string): Promise<void>;
  download(fileId: string): Promise<Buffer>;
  temporary(chat: number, text: string): Promise<number>;
  edit(chat: number, id: number, text: string): Promise<void>;
  remove(chat: number, id: number): Promise<void>;
  typing(chat: number): Promise<void>;
  panel?(chat: number, text: string, buttons: Buttons, editId?: number, scope?: string): Promise<void>;
  notice?(chat: number, text: string, scope?: string, ttlMs?: number): Promise<void>;
  dismiss?(chat: number, scope?: string, graceMs?: number): Promise<void>;
  cleanup?(chat: number, now?: number): Promise<void>;
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
Photos and documents: up to 20 MB each. Albums wait for Process.
/batch — collect multiple files; /process — process the current batch
/queue — tasks, cancel, reorder, pause/resume and explicit retry
/schedules — reminders and recurring tasks; ask Claude to create or edit them
/clock — current India time; specify other timezones in your task
/trash — restore deleted chats within 48 hours
/backup — encrypted export and restore controls
/health — Telegram, Claude, queue, storage and API recovery`;

export class Controller {
  private running?: { abort: AbortController; done: Promise<void> };
  private shuttingDown = false;
  private persistenceFailed = false;
  private panelId?: number;
  private memory: SharedMemory;
  private chats: ChatArchive;
  readonly sessions: SessionCatalog;
  readonly automation: Automation;
  private backups: Backups;
  private pump?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private cleaningUi?: Promise<void>;
  private restorePending?: { path: string; project: string; expires: number };

  constructor(private config: Config, private store: StateStore, private messenger: Messenger, private runner: Runner, private ledger?: UsageLedger, private titles?: TitleGenerator) {
    this.memory = new SharedMemory(config.dataDir, configSecrets(config));
    this.chats = new ChatArchive(path.join(config.dataDir, 'bot', 'chats'), configSecrets(config));
    this.sessions = new SessionCatalog(store, this.chats, configSecrets(config), path.join(config.dataDir, 'claude', 'projects'));
    this.sessions.onDeleteRequest = async (id, title) => this.panel(`Move “${title}” to Trash? Restore within 48 hours; then the chat archive is permanently deleted. Shared memory, project files and lifetime usage stay.`, [[button('Move to Trash', 'trashmove ' + id)], ...BACK], 'session-delete-' + id);
    this.automation = new Automation(store);
    this.backups = new Backups(config.dataDir, config.backupEncryptionKey, store, this.chats, this.memory, configSecrets(config));
  }

  async prepareSessions(signal: AbortSignal): Promise<void> {
    await this.sessions.backfill();
    let named = 0;
    if (this.titles) for (const record of this.store.data.conversations ?? []) {
      if (signal.aborted) break;
      if (record.trashedAt) continue;
      if (await this.sessions.autoName(record.id, turns => this.titles!.generate(turns, signal))) named++;
    }
    console.log(`Session catalog ready: chats=${this.sessions.context().total}; generatedNames=${named}; tools=list,read,rename,search,memory.`);
  }

  private get settings(): AgentSettings { return this.store.data.settings ?? { model: this.config.model, effort: this.config.effort, fast: this.config.fast }; }

  private async panel(text: string, buttons: Buttons = BACK, scope = 'controls'): Promise<void> {
    if (!this.messenger.panel) return this.say(text);
    try { await this.messenger.panel(this.config.owner, text, buttons, this.panelId, scope); }
    catch { await this.say(text); }
  }

  async menu(): Promise<void> {
    await this.panel(`Claude · Your workspace\n\n${settingsLabel(this.settings)}\nProject: ${this.store.data.project}\nMemory: ${this.store.data.memoryEnabled !== false ? 'ON · shared across chats' : 'OFF'}\n${this.running ? 'Working on your task…' : 'Ready for your next task.'}\n\nSend a message or choose a control below.`, HOME);
  }

  async callback(callback: Callback): Promise<void> {
    if (!callback.message || !authorized({ ...callback.message, from: callback.from }, this.config.owner)) return;
    await this.messenger.acknowledge?.(callback.id).catch(() => {});
    const data = callback.data ?? '';
    if (!/^(menu|help|status|stop|rename|new chat|model(?: (?:fable|opus|sonnet))?|efforts(?: (?:low|medium|high|xhigh|max))?|fast(?: (?:on|off))?|token count|cost|memory(?: (?:on|off|confirm-clear|clear))?|session(?: [a-zA-Z0-9_-]+)?|sessionpage \d+|history [a-zA-Z0-9_-]+ \d+|projects|project [a-zA-Z0-9_-]+|files|batch|process(?: [a-zA-Z0-9_-]+)?|discard [a-zA-Z0-9_-]+|queue(?: (?:pause|resume))?|task(?:cancel|first|retry|confirm) [a-zA-Z0-9_-]+|schedules|schedule(?:pause|resume|delete) [a-zA-Z0-9_-]+|trash|(?:delete|trashmove|restore|purge|purgeconfirm) [a-zA-Z0-9_-]+|backup(?: (?:export|files|daily|off))?|restorebackup confirm|health(?: retry)?|clock)$/.test(data)) return;
    this.panelId = callback.message.message_id;
    try {
      if (data === 'memory confirm-clear') {
        await this.panel('Clear shared memory? Saved conversations and files will stay.', [[button('Clear memory', 'memory clear')], ...BACK]);
      } else await this.handle({ ...callback.message, from: callback.from, text: '/' + data, document: undefined, photo: undefined, media_group_id: undefined, caption: undefined });
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

  private chatKey(): string { const d = this.store.data; return d.sessions[d.project] ?? d.drafts?.[d.project] ?? 'draft-' + d.project; }
  private resolveChat(key: string): string { let id = key; const seen = new Set<string>(); while (this.store.data.bindings?.[id] && !seen.has(id)) { seen.add(id); id = this.store.data.bindings[id]; } return id; }

  private async clearScreen(): Promise<void> {
    const cleared = await this.messenger.clear?.(this.config.owner);
    this.panelId = undefined;
    if (cleared === false) await this.say('Some older messages could not be removed by Telegram. The selected chat will appear below.');
  }

  private async history(id: string, page?: number): Promise<void> {
    if (!this.store.data.conversations?.some(s => s.id === id && !s.trashedAt)) return this.panel('Saved chat not found.');
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
      ...(nav.length ? [nav] : []), [button('💬 Sessions', 'session'), button('➕ New chat', 'new chat')], [button('✏️ Rename chat', 'rename'), button('Delete chat', 'delete ' + id)], ...BACK]);
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

  async idle(): Promise<void> { while (this.pump) await this.pump; }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking || this.shuttingDown) return;
    if (!this.cleaningUi && this.messenger.cleanup) {
      this.cleaningUi = this.messenger.cleanup(this.config.owner, +now).catch(() => { console.warn('Temporary UI cleanup deferred; conversation data is unchanged.'); }).finally(() => { this.cleaningUi = undefined; });
    }
    this.ticking = true;
    try { await this.sessions.purgeExpired(now); await this.automation.tick(now); this.kick(); }
    finally { this.ticking = false; }
  }
  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch(() => { this.persistenceFailed = true; console.error('Automation storage failed; queue stopped.'); });
    this.timer = setInterval(tick, 5000); this.timer.unref(); tick();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.timer);
    this.running?.abort.abort();
    await this.idle();
  }

  private async say(text: string, persistent = false, scope?: string): Promise<void> {
    try {
      const safe = redact(text, configSecrets(this.config));
      if (!persistent && this.messenger.notice) await this.messenger.notice(this.config.owner, safe, scope);
      else await this.messenger.send(this.config.owner, safe);
    }
    catch { console.warn('Owner message delivery failed; job state was preserved.'); }
  }
  private async dismiss(scope: string, graceMs = 0): Promise<void> { await this.messenger.dismiss?.(this.config.owner, scope, graceMs).catch(() => {}); }

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
    const list = [...(this.store.data.conversations ?? [])].filter(s => !s.trashedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
      [button('➕ New chat', 'new chat'), button('Trash', 'trash')], ...BACK]);
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
    try { if (await this.extraCommand(command, argument)) return; }
    catch { return this.say('Could not complete that action. Check the selected item, storage and command. Existing data is kept.'); }
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
      await this.automation.setPaused(true);
      this.running.abort.abort();
      return this.say('Stop requested; queue paused. File edits already made are kept; external effects are not undone. Resume queued work from /queue.');
    }
    if (this.pump && command && !['run', 'get', 'files'].includes(command)) return this.say('Busy with your current task. Send more tasks to queue them; switch chats or settings after it finishes.');
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
        await this.controls(command!); await this.dismiss('controls', 3000); return;
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
        const found = this.store.data.conversations?.filter(s => !s.trashedAt && (s.id === argument || s.id.startsWith(argument)));
        if (!found || found.length !== 1) return this.panel('Session not found or ID is ambiguous. Choose one from /session.');
        await this.workspace(found[0].project);
        this.store.data.project = found[0].project;
        await this.session(found[0].id, found[0].project);
        await this.clearScreen();
        return this.history(found[0].id);
      }
      if (command === 'new') {
        delete this.store.data.sessions[this.store.data.project];
        (this.store.data.drafts ??= {})[this.store.data.project] = 'draft-' + randomUUID();
        await this.store.save();
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
      if (message.document || message.photo?.length) return this.receive(message, root);
      const prompt = command === 'run' ? argument : text;
      if (!prompt) return this.say('Send a text task, photo or document. Use /help for commands.');
      const pending = this.pendingBatches();
      if (pending.length) await this.processBatches(pending, prompt);
      else await this.launch(prompt, root);
    } catch {
      await this.say('Could not process this request. Check the command, file path/size and storage. No automatic retry was performed.');
    }
  }

  private async launch(prompt: string, cwd: string, displayPrompt = prompt): Promise<void> {
    await this.dismiss('controls');
    const task = await this.automation.enqueue({ kind: 'agent', project: this.store.data.project, chatKey: this.chatKey(), prompt, displayPrompt, settings: { ...this.settings }, interactive: true });
    if (this.pump || this.store.data.queuePaused) await this.say(`Task saved in queue · ${this.store.data.tasks!.filter(t => t.status === 'queued').length} waiting. /queue for controls.`, false, 'task-' + task.id);
    this.kick();
  }

  private kick(): void {
    if (this.pump || this.shuttingDown || this.persistenceFailed || this.store.data.queuePaused) return;
    this.pump = this.runQueue().catch(() => { this.persistenceFailed = true; console.error('Queue state failed; new tasks paused.'); }).finally(() => {
      this.pump = undefined;
      if (this.store.data.tasks!.some(t => t.status === 'queued')) this.kick();
    });
  }
  private async runQueue(): Promise<void> {
    while (!this.shuttingDown && !this.persistenceFailed) {
      const task = await this.automation.claim(); if (!task) break;
      await this.dismiss('task-' + task.id);
      const abort = new AbortController(); const running = { abort, done: Promise.resolve() }; this.running = running;
      running.done = (async () => {
        if (task.kind === 'agent') {
          const cwd = await this.workspace(task.project);
          await this.execute(task, cwd, abort);
        } else {
          try {
            if (task.kind === 'backup') await this.exportBackup();
            else await this.messenger.send(this.config.owner, 'Reminder\n\n' + redact(task.prompt, configSecrets(this.config)));
            await this.automation.finish(task.id, 'completed');
          } catch { await this.automation.finish(task.id, 'failed'); await this.say('Scheduled delivery failed. Open /queue to retry it.'); }
        }
      })();
      try { await running.done; } finally { this.running = undefined; }
    }
  }

  private async execute(task: Task, cwd: string, abort: AbortController): Promise<void> {
    const { prompt, project } = task;
    const job = { id: task.id, project, startedAt: task.startedAt! };
    this.store.data.active = job; await this.store.save();
    let status: 'completed' | 'failed' | 'cancelled' = 'failed';
    let archiveKey = this.resolveChat(task.chatKey);
    const originalKey = archiveKey;
    const delivered = new Set<string>();
    const before = await artifactSnapshot(cwd);
    await this.chats.append(archiveKey, { role: 'user', text: task.displayPrompt ?? prompt });
    const bind = async (id: string) => {
      const active = task.interactive && (this.chatKey() === archiveKey || this.resolveChat(this.chatKey()) === archiveKey);
      await this.chats.bind(archiveKey, id);
      if (archiveKey !== id) (this.store.data.bindings ??= {})[archiveKey] = id;
      this.store.data.bindings![task.chatKey] = id; archiveKey = id;
      if (active) await this.session(id, project);
      else {
        if (!this.store.data.conversations!.some(s => s.id === id)) this.store.data.conversations!.push({ id, project, updatedAt: new Date().toISOString() });
        await this.sessions.ensureName(id); await this.store.save();
      }
    };
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
      const selected = effectiveSettings(task.settings ?? this.settings);
      const prior = (await this.chats.read(originalKey)).slice(-30).map(t => `${t.role}: ${t.text}`).join('\n').slice(-24000);
      const result = await this.runner.run({ prompt, cwd, session: this.store.data.conversations!.some(s => s.id === originalKey && !s.trashedAt) ? originalKey : undefined, resumeContext: prior,
        settings: selected, memoryEnabled: this.store.data.memoryEnabled !== false, sessions: this.sessions,
        workspace: { root: cwd, project, automation: this.automation, deliver: async (file, preview) => { await this.deliver(cwd, file, preview); delivered.add(file.replace(/\\/g, '/')); }, backup: () => this.exportBackup() } }, async event => {
        if (event.type === 'session') {
          await bind(event.id);
        } else if (event.type === 'usage' || event.type === 'step') {
          try {
            if (event.type === 'usage') await this.ledger?.recordResult(event.session, event.id, event.models, event.cost);
            else await this.ledger?.recordStep(event.session, event.id, event.model, event.usage, event.complete);
          } catch { this.persistenceFailed = true; abort.abort(); throw new AgentError('Usage storage failed. Work stopped to protect your records.'); }
        } else if (event.type === 'speed') this.store.data.lastSpeed = event.state;
        else if (event.type === 'progress') progress = event.text;
      }, abort);
      abort.signal.throwIfAborted();
      await bind(result.session);
      await this.chats.append(result.session, { role: 'assistant', text: result.text });
      // Store a redacted result in the project so a Telegram outage is recoverable.
      const outputName = `result-${job.id}.txt`;
      await writeFile(path.join(cwd, outputName), redact(result.text, configSecrets(this.config)), { flag: 'wx', mode: 0o600 });
      status = 'completed';
      (this.store.data.health ??= {}).claudeAt = new Date().toISOString(); delete this.store.data.health.apiError;
      const preview = result.text.length > 12000 ? result.text.slice(0, 12000) + `\n\nFull result: /get ${outputName}` : result.text;
      await finishIndicator();
      await this.say(preview, true);
      const artifacts = (await changedArtifacts(cwd, before)).filter(file => !delivered.has(file));
      for (const file of artifacts.slice(0, 20)) { try { await this.deliver(cwd, file, 'Ready · ' + path.basename(file)); } catch { await this.say(`File saved; automatic delivery failed. Retry: /get ${file}`); } }
      if (artifacts.length > 20) await this.say('Additional files are saved. Use /files and /get to download them.');
      if (this.titles && !abort.signal.aborted) await this.sessions.autoName(result.session, turns => this.titles!.generate(turns, abort.signal));
      console.log(`Claude task completed: ${selected.model}; effort=${selected.effort}; requestedFast=${selected.fast}; reportedSpeed=${this.store.data.lastSpeed ?? 'unknown'}.`);
    } catch (error) {
      if (error instanceof TitleAccountingError) this.persistenceFailed = true;
      if (error instanceof AgentApiError) { (this.store.data.health ??= {}).apiError = error.kind; console.warn(`Claude task API failure: ${error.kind}.`); await this.automation.setPaused(true); }
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
      try { await this.automation.finish(task.id, this.shuttingDown && status === 'cancelled' ? 'interrupted' : status); }
      catch { this.persistenceFailed = true; console.error('Job state persistence failed; new jobs disabled.'); }
      await this.dismiss('task-' + task.id);
    }
  }

  private pendingBatches(): Batch[] {
    const key = this.resolveChat(this.chatKey());
    return this.store.data.batches!.filter(b => b.status === 'collecting' && b.project === this.store.data.project && this.resolveChat(b.chatKey) === key);
  }
  private async receive(message: Message, root: string): Promise<void> {
    const photo = message.photo?.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const attachment = photo ?? message.document!;
    if ((attachment.file_size ?? 0) > 20000000) return this.say('Upload exceeds the 20 MB incoming file limit.');
    const base = photo ? 'photo.jpg' : path.basename((message.document!.file_name ?? 'document.bin').replace(/\\/g, '/'));
    if (secretPath(base)) return this.say('Do not send credential files through Telegram. Configure secrets in Render.');
    const indicator = await this.messenger.temporary(this.config.owner, 'Receiving ' + (photo ? 'photo…' : 'file…')).catch(() => undefined);
    let success = false;
    try {
      const uploads = path.join(root, 'uploads'); await mkdir(uploads, { recursive: true, mode: 0o700 });
      if ((await lstat(uploads)).isSymbolicLink()) throw new Error('Invalid uploads directory.');
      const name = randomUUID() + '-' + (base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'file.bin');
      const bytes = await this.messenger.download(attachment.file_id);
      if (bytes.length > 20000000) throw new Error('Oversized upload.');
      await writeFile(path.join(uploads, name), bytes, { flag: 'wx', mode: 0o600 });
      const relative = 'uploads/' + name;
      if (base.toLowerCase().endsWith('.ctab')) {
        const decoded = this.backups.decode(bytes);
        this.restorePending = { path: relative, project: this.store.data.project, expires: Date.now() + 600000 };
        await this.panel(`Encrypted backup received · ${decoded.chats.length} chats, ${decoded.schedules.length} schedules, ${decoded.files.length} files.\n\nRestore merges missing items; existing chats/files and usage stay. Restored schedules start paused. Confirm within 10 minutes while the queue is paused and idle.`, [[button('Restore backup', 'restorebackup confirm')], ...BACK]);
        success = true; return;
      }
      const candidates = this.pendingBatches();
      let batch = candidates.find(b => b.manual) ?? candidates.find(b => message.media_group_id ? b.groupId === message.media_group_id : !b.groupId);
      if (!batch) {
        batch = { id: randomUUID().slice(0, 8), project: this.store.data.project, chatKey: this.chatKey(), uploadIds: [], status: 'collecting', groupId: message.media_group_id, updatedAt: new Date().toISOString() };
        this.store.data.batches!.push(batch);
      }
      const upload = { id: randomUUID().slice(0, 8), project: batch.project, chatKey: batch.chatKey, path: relative, name: base, photo: !!photo, receivedAt: new Date().toISOString(), batchId: batch.id };
      this.store.data.uploads!.push(upload); batch.uploadIds.push(upload.id); batch.updatedAt = upload.receivedAt;
      if (message.caption?.trim()) batch.prompt = (batch.prompt ? batch.prompt + '\n' : '') + message.caption.trim();
      await this.chats.append(this.resolveChat(batch.chatKey), { role: 'user', text: `Attachment: ${base}\nProject path: ${relative}`, file: { id: attachment.file_id, name: base } });
      await this.store.save(); success = true;
      await this.panel(`${photo ? 'Photo' : base} received · ${batch.uploadIds.length} file(s) in this batch.\n${batch.manual || batch.groupId ? 'Send more files, then tap Process or send your instructions.' : 'Send instructions or tap Process.'}\nOriginal saved.`, [[button('Process', 'process ' + batch.id), button('Discard batch', 'discard ' + batch.id)], ...BACK], 'batch-' + batch.id);
      if (message.caption?.trim() && !batch.manual && !batch.groupId) await this.processBatches([batch], batch.prompt!);
    } catch {
      await this.say('Upload could not be accepted. Check file size/format and send it again. No processing started.');
    } finally {
      if (indicator !== undefined) await this.messenger.remove(this.config.owner, indicator).catch(() => this.messenger.edit(this.config.owner, indicator, success ? 'Received.' : 'Upload failed.').catch(() => {}));
    }
  }
  private async processBatches(batches: Batch[], instruction?: string): Promise<void> {
    if (!batches.length || !batches.some(b => b.uploadIds.length)) return this.say('No files waiting in this chat. Send photos or documents first.');
    const ids = new Set(batches.flatMap(b => b.uploadIds));
    const files = this.store.data.uploads!.filter(u => ids.has(u.id));
    const prompt = instruction ?? (batches.map(b => b.prompt).filter(Boolean).join('\n') || 'Inspect these files. For bill photos, extract only clear values, check arithmetic, and ask about unclear fields with relevant crops. If the desired output is unclear, ask the owner.');
    for (const batch of batches) batch.status = 'queued';
    const task = await this.automation.enqueue({ kind: 'agent', project: batches[0].project, chatKey: batches[0].chatKey,
      prompt: prompt + '\n\nAttached project files:\n' + files.map(f => f.path).join('\n'), displayPrompt: prompt + `\n[${files.length} attached files]`, settings: { ...this.settings }, interactive: true });
    for (const batch of batches) await this.dismiss('batch-' + batch.id);
    await this.dismiss('controls');
    await this.say(`${files.length} file(s) queued for processing.`, false, 'task-' + task.id); this.kick();
  }
  private async deliver(root: string, relative: string, preview?: string): Promise<void> {
    const file = await safeFile(root, relative);
    if ((await lstat(file)).size > 49000000) throw new Error('File exceeds 49 MB.');
    const bytes = await readFile(file);
    if (configSecrets(this.config).some(s => s.length > 5 && bytes.includes(Buffer.from(s)))) throw new Error('Credential-bearing file cannot be sent.');
    if (/\.(png|jpe?g|webp)$/i.test(file) && this.messenger.sendPhoto) await this.messenger.sendPhoto(this.config.owner, path.basename(file), bytes, preview);
    else { if (preview) await this.say(preview, true); await this.messenger.sendFile(this.config.owner, path.basename(file), bytes); }
  }
  async exportBackup(files = false): Promise<void> {
    const bytes = await this.backups.export(files);
    await this.messenger.sendFile(this.config.owner, `claude-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.ctab`, bytes);
    (this.store.data.health ??= {}).lastBackupAt = new Date().toISOString(); await this.store.save();
    await this.say('Encrypted backup sent. Keep the private BACKUP_ENCRYPTION_KEY from your environment to restore it on another server. Restore by uploading this .ctab file. Secrets and lifetime usage are not imported or reset.');
  }
  private async extraCommand(command: string | undefined, argument: string): Promise<boolean> {
    const d = this.store.data;
    if (command === 'clock') { const clock = clockInfo(); await this.panel(clock.local + '\n' + clock.timezone + '\nUTC: ' + clock.utc); }
    else if (command === 'batch') {
      let batch = this.pendingBatches().find(b => b.manual);
      if (!batch) { batch = { id: randomUUID().slice(0, 8), project: d.project, chatKey: this.chatKey(), uploadIds: [], status: 'collecting', manual: true, updatedAt: new Date().toISOString() }; d.batches!.push(batch); await this.store.save(); }
      await this.panel(`Batch open · ${batch.uploadIds.length} files. Send photos/documents, then your instructions or tap Process.`, [[button('Process batch', 'process ' + batch.id), button('Discard batch', 'discard ' + batch.id)], ...BACK], 'batch-' + batch.id);
    } else if (command === 'process') await this.processBatches(this.pendingBatches().filter(b => !argument || b.id === argument));
    else if (command === 'discard') { const b = this.pendingBatches().find(b => b.id === argument); if (b) { b.status = 'discarded'; await this.store.save(); } await this.dismiss('batch-' + argument); await this.panel('Batch discarded. Original uploaded files remain in the project.'); await this.dismiss('controls', 3000); }
    else if (command === 'queue') {
      if (argument === 'pause' || argument === 'resume') { await this.automation.setPaused(argument === 'pause'); if (argument === 'resume') this.kick(); }
      const waiting = d.tasks!.filter(t => ['queued', 'running'].includes(t.status)); const recent = d.tasks!.filter(t => !['queued', 'running'].includes(t.status)).slice(-6).reverse();
      const shown = [...waiting.slice(0, 8), ...recent];
      await this.panel(`Tasks · ${d.queuePaused ? 'PAUSED' : 'ON'} · ${waiting.filter(t => t.status === 'queued').length} waiting\n\n${shown.map(t => `${t.status} · ${t.id} · ${t.project}\n${(t.displayPrompt ?? t.prompt).replace(/\s+/g, ' ').slice(0, 100)}`).join('\n\n') || 'No tasks yet.'}`, [
        [button(d.queuePaused ? 'Resume queue' : 'Pause queue', 'queue ' + (d.queuePaused ? 'resume' : 'pause'))],
        ...waiting.filter(t => t.status === 'queued').slice(0, 8).map(t => [button('First ' + t.id, 'taskfirst ' + t.id), button('Cancel ' + t.id, 'taskcancel ' + t.id)]),
        ...recent.filter(t => ['failed', 'interrupted', 'cancelled'].includes(t.status)).map(t => [button('Retry ' + t.id, 'taskretry ' + t.id)]), ...BACK]);
    } else if (command === 'taskcancel' || command === 'taskfirst') { if (command === 'taskcancel') await this.automation.cancelTask(argument); else await this.automation.prioritize(argument); await this.extraCommand('queue', ''); }
    else if (command === 'taskretry') { await this.panel('Retry this task? It may have already changed files or external systems. Review the previous output first; retry starts the task again.', [[button('Retry task', 'taskconfirm ' + argument)], ...BACK]); }
    else if (command === 'taskconfirm') { await this.automation.retryTask(argument); this.kick(); await this.extraCommand('queue', ''); }
    else if (command === 'schedules') {
      await this.panel(`Schedules · ${d.schedules!.length}\nIndia time by default. Ask Claude to create/edit reminders or recurring jobs.\n\n${d.schedules!.slice(0, 12).map(s => `${s.enabled ? 'ON' : 'PAUSED'} · ${s.name}\nNext: ${new Date(s.nextRun).toLocaleString('en-GB', { timeZone: s.timezone })} (${s.timezone})\nLast: ${s.lastStatus ?? 'not run'}`).join('\n\n') || 'No schedules yet.'}`, [
        ...d.schedules!.slice(0, 12).map(s => [button((s.enabled ? 'Pause ' : 'Resume ') + s.name.slice(0, 22), 'schedule' + (s.enabled ? 'pause ' : 'resume ') + s.id), button('Delete', 'scheduledelete ' + s.id)]), [button('Clock', 'clock')], ...BACK]);
    } else if (['schedulepause', 'scheduleresume', 'scheduledelete'].includes(command ?? '')) { await this.automation.changeSchedule(argument, command!.slice(8) as 'pause' | 'resume' | 'delete'); await this.extraCommand('schedules', ''); }
    else if (command === 'delete') { const s = d.conversations!.find(s => s.id === argument && !s.trashedAt); if (s) await this.sessions.requestDelete(s.id); else await this.panel('Chat not found.'); }
    else if (['trashmove', 'restore', 'purgeconfirm'].includes(command ?? '')) {
      if (this.pump) { await this.say('Finish or stop the current task before changing saved chats.'); return true; }
      if (command === 'trashmove') await this.sessions.trash(argument);
      else if (command === 'restore') await this.sessions.restore(argument);
      else await this.sessions.purge(argument);
      await this.dismiss('session-delete-' + argument);
      await this.extraCommand('trash', '');
      await this.dismiss('controls', 3000);
    } else if (command === 'purge') { const s = d.conversations!.find(s => s.id === argument && s.trashedAt); if (s) await this.panel(`Permanently delete “${sessionTitle(s)}” now? This removes its chat archive and SDK transcript. Project files, shared memory and lifetime usage stay. Existing exported backups are separate copies.`, [[button('Delete permanently', 'purgeconfirm ' + argument)], ...BACK]); }
    else if (command === 'trash') {
      const items = this.sessions.trashList();
      await this.panel(`Trash · ${items.length}\nAutomatic permanent deletion 48 hours after moving here.\n\n${items.slice(0, 12).map(s => `${s.title}\nDeletes: ${new Date(s.purgeAt!).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })} IST`).join('\n\n') || 'Trash is empty.'}`, [...items.slice(0, 12).map(s => [button('Restore ' + s.title.slice(0, 20), 'restore ' + s.id), button('Delete forever', 'purge ' + s.id)]), ...BACK]);
    } else if (command === 'backup') {
      if (argument === 'export' || argument === 'files') await this.exportBackup(argument === 'files');
      else if (argument === 'daily') { const old = d.schedules!.find(s => s.name === 'Daily encrypted backup'); if (old) await this.automation.changeSchedule(old.id, 'resume'); else await this.automation.createSchedule({ name: 'Daily encrypted backup', kind: 'backup', prompt: 'Export encrypted app backup', project: d.project, cron: '0 3 * * *', timezone: 'Asia/Kolkata' }); await this.panel('Daily encrypted backup enabled · 03:00 IST. Each export is sent here.'); }
      else if (argument === 'off') { for (const s of d.schedules!.filter(s => s.kind === 'backup')) await this.automation.changeSchedule(s.id, 'pause'); await this.panel('Scheduled backups paused.'); }
      else await this.panel('Encrypted backups\n\nExport chats, shared memory and schedules. Optional files export is limited to 12 MB of project files (19 MB encrypted export limit). Private encryption key stays in the environment.\n\nRestore: upload a .ctab backup, pause the queue and confirm. Existing data and usage are preserved; restored schedules start paused.', [[button('Export chats + memory', 'backup export')], [button('Include project files', 'backup files')], [button('Daily 03:00 IST', 'backup daily'), button('Pause backups', 'backup off')], ...BACK]);
    } else if (command === 'restorebackup' && argument === 'confirm') {
      if (this.pump || !d.queuePaused) { await this.panel('Pause the queue and wait for the running task to finish before restoring.', [[button('Pause queue', 'queue pause')], ...BACK]); return true; }
      const pending = this.restorePending; if (!pending || pending.expires < Date.now()) throw new Error('Restore confirmation expired.');
      const file = await safeFile(await this.workspace(pending.project), pending.path);
      const result = await this.backups.restore(await readFile(file)); this.restorePending = undefined;
      await this.panel(`Restore complete · ${result.chats} chats, ${result.schedules} paused schedules, ${result.files} files added. Existing data and lifetime usage preserved.`);
    } else if (command === 'health') {
      if (argument === 'retry') { d.disabledKeyIds = []; await this.store.save(); }
      const disk = await statfs(this.config.dataDir); const keys = 1 + (this.config.backupKeys?.length ?? 0);
      await this.panel(`Health\n\nTelegram last successful poll: ${d.health?.telegramAt ?? 'not recorded'}\nClaude last success: ${d.health?.claudeAt ?? 'not recorded'}\nClaude error: ${d.health?.apiError ?? 'none recorded'}\nConfigured keys: ${keys}; disabled: ${d.disabledKeyIds?.length ?? 0}\nCurrent task: ${d.active?.id ?? 'idle'}\nQueue: ${d.tasks!.filter(t => t.status === 'queued').length} waiting · ${d.queuePaused ? 'paused' : 'on'}\nSchedules: ${d.schedules!.filter(s => s.enabled).length} enabled\nFree disk: ${(Number(disk.bavail) * Number(disk.bsize) / 1073741824).toFixed(2)} GiB\nLast backup delivered: ${d.health?.lastBackupAt ?? 'none'}\n\nLast success is historical, not a live credit-balance check. No external outage monitor is configured.`, [[button('Re-enable fixed API keys', 'health retry'), button('Queue', 'queue')], ...BACK]);
    } else return false;
    return true;
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
