import { mkdir, readdir, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StateStore } from './state.js';
import { projectName, redact, secretPath } from './safety.js';
import { ProjectError, assertProjectWork, type ProjectRecord } from './project-state.js';
import { ChatArchive } from './chats.js';
import { SessionCatalog } from './sessions.js';

export { ProjectError } from './project-state.js';
export interface ProjectQuery { status?: ProjectRecord['status'] | 'all'; query?: string; offset?: number; limit?: number }
const locks = new WeakMap<StateStore, Promise<unknown>>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** IDs and directories never change when the owner edits a project's name. */
export class ProjectCatalog {
  private initialized?: Promise<void>;
  private base: string;
  private sessions: SessionCatalog;
  constructor(private dataDir: string, readonly store: StateStore, readonly secrets: string[] = []) {
    this.base = path.resolve(dataDir, 'workspaces');
    this.sessions = new SessionCatalog(store, new ChatArchive(path.join(dataDir, 'bot/chats'), secrets), secrets, path.join(dataDir, 'claude/projects'));
  }
  private lock<T>(work: () => Promise<T>): Promise<T> {
    const task = (locks.get(this.store) ?? Promise.resolve()).catch(() => {}).then(work);
    locks.set(this.store, task.catch(() => {})); return task;
  }
  private id(id: string) {
    try { projectName(id); } catch { throw new ProjectError('Use a valid project ID from list_projects.'); }
    if (redact(id, this.secrets) !== id) throw new ProjectError('A project ID cannot contain private credentials.');
    return id;
  }
  private find(id: string) {
    this.id(id); const record = this.store.data.projects!.find(p => p.id === id);
    if (!record) throw new ProjectError('Project not found. Use list_projects for its exact ID.');
    return record;
  }
  private text(value: string, max: number, empty = false) {
    const text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if ((!empty && !text) || text.length > max) throw new ProjectError(`Use ${empty ? '0' : '1'}-${max} characters for project metadata.`);
    if (redact(text, this.secrets) !== text || text.includes('[REDACTED]')) throw new ProjectError('Keep project names and descriptions free of credentials and private secrets.');
    return text;
  }
  private async directoryBase() {
    await mkdir(this.base, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.base)).isDirectory() || (await lstat(this.base)).isSymbolicLink()) throw new ProjectError('The project directory is unavailable; symlink roots are refused.');
    return realpath(this.base);
  }
  private async directory(id: string, create: boolean) {
    this.id(id); const base = await this.directoryBase(), target = path.resolve(base, id);
    if (path.dirname(target) !== base || path.relative(base, target) !== id) throw new ProjectError('Invalid project directory.');
    if (create) await mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(target).catch(error => { if (missing(error)) throw new ProjectError('Project files are missing. Restore a backup before continuing.'); throw error; });
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ProjectError('Invalid project directory; symlinks are refused.');
    return target;
  }
  private record(id: string, name = id): ProjectRecord {
    const stamp = new Date().toISOString();
    const record: ProjectRecord = { id, name, description: '', status: 'active', createdAt: stamp, updatedAt: stamp };
    this.store.data.projects!.push(record); return record;
  }
  private async discover() {
    const base = await this.directoryBase(); let changed = false;
    const references = [this.store.data.project, ...Object.keys(this.store.data.sessions),
      ...(this.store.data.conversations ?? []).map(c => c.project), ...(this.store.data.schedules ?? []).map(s => s.project),
      ...(this.store.data.tasks ?? []).map(t => t.project), ...(this.store.data.uploads ?? []).map(u => u.project)];
    const dirs = (await readdir(base, { withFileTypes: true })).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => e.name);
    for (const id of new Set([...references, ...dirs])) {
      try { this.id(id); } catch { continue; }
      if (!this.store.data.projects!.some(p => p.id === id)) {
        // A legacy selected/referenced project may not have received its first
        // file yet. Only migration is allowed to create that missing folder.
        await this.directory(id, true); this.record(id); changed = true;
      }
    }
    return changed;
  }
  private async fallback() {
    const current = this.store.data.projects!.find(p => p.id === this.store.data.project && p.status === 'active');
    if (current) return;
    let next = this.store.data.projects!.find(p => p.status === 'active' && p.id === 'default') ?? this.store.data.projects!.find(p => p.status === 'active');
    if (!next) {
      let id = 'default';
      while (this.store.data.projects!.some(p => p.id === id)) id = 'default-' + randomUUID().slice(0, 8);
      await this.directory(id, true); next = this.record(id, 'New project');
    }
    this.store.data.project = next.id;
  }
  initialize(): Promise<void> {
    this.initialized ??= this.lock(async () => {
      this.store.data.projects ??= []; await this.discover(); await this.fallback(); await this.store.save();
    }).catch(error => { this.initialized = undefined; throw error; });
    return this.initialized;
  }
  private view(p: ProjectRecord) {
    const data = this.store.data;
    return { ...p, name: redact(p.name, this.secrets), description: redact(p.description, this.secrets), selected: data.project === p.id,
      workspace: 'workspaces/' + p.id, counts: {
        chats: new Set((data.conversations ?? []).filter(c => c.project === p.id).map(c => this.sessions.resolve(c.id))).size,
        queuedTasks: (data.tasks ?? []).filter(t => t.project === p.id && t.status === 'queued').length,
        runningTasks: (data.tasks ?? []).filter(t => t.project === p.id && t.status === 'running').length,
        enabledSchedules: (data.schedules ?? []).filter(s => s.project === p.id && s.enabled).length,
        runningBackgroundJobs: (data.backgroundJobs ?? []).filter(j => j.project === p.id && ['starting', 'running'].includes(j.status)).length,
      } };
  }
  async list(query: ProjectQuery = {}) {
    await this.initialize();
    return this.lock(async () => {
      if (await this.discover()) await this.store.save();
      const offset = query.offset ?? 0, limit = query.limit ?? 20;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ProjectError('Invalid project page.');
      const status = query.status ?? 'active', term = query.query?.toLocaleLowerCase().trim();
      const projects = this.store.data.projects!.filter(p => status === 'all' || p.status === status).map(p => this.view(p))
        .filter(p => !term || [p.id, p.name, p.description].some(t => t.toLocaleLowerCase().includes(term))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      return { selectedProject: this.store.data.project, total: projects.length, offset, nextOffset: offset + limit < projects.length ? offset + limit : null, projects: projects.slice(offset, offset + limit) };
    });
  }
  async get(id: string) { await this.initialize(); return this.lock(async () => this.view(this.find(id))); }
  async workspace(id: string, createLegacy = false): Promise<string> {
    await this.initialize(); return this.lock(async () => {
      this.id(id);
      if (!this.store.data.projects!.some(p => p.id === id)) {
        if (!createLegacy) throw new ProjectError('Project not found. Create it or use list_projects.');
        await this.directory(id, true); this.record(id); await this.store.save();
      }
      assertProjectWork(this.store.data, id); return this.directory(id, false);
    });
  }
  async create(input: { name: string; id?: string; description?: string }) {
    await this.initialize(); return this.lock(async () => {
      const name = this.text(input.name, 80), description = this.text(input.description ?? '', 4000, true);
      let id = input.id ? this.id(input.id) : name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'project';
      if (!input.id) while (this.store.data.projects!.some(p => p.id === id)) id = id.slice(0, 35) + '-' + randomUUID().slice(0, 8);
      if (this.store.data.projects!.some(p => p.id === id)) throw new ProjectError('This project ID already exists or is reserved; it cannot be reused.');
      const base = await this.directoryBase();
      if (await lstat(path.join(base, id)).then(() => true, error => { if (missing(error)) return false; throw error; })) throw new ProjectError('This project directory already exists. Use list_projects to discover it.');
      await this.directory(id, true); const record = this.record(id, name); record.description = description;
      await this.store.save(); return this.view(record);
    });
  }
  async update(id: string, input: { name?: string; description?: string }) {
    await this.initialize(); return this.lock(async () => {
      const p = this.find(id);
      if (!['active', 'archived'].includes(p.status)) throw new ProjectError('Restore the project before editing its metadata.');
      const name = input.name === undefined ? p.name : this.text(input.name, 80);
      const description = input.description === undefined ? p.description : this.text(input.description, 4000, true);
      p.name = name; p.description = description; p.updatedAt = new Date().toISOString(); await this.store.save(); return this.view(p);
    });
  }
  rename(id: string, name: string) { return this.update(id, { name }); }
  async assertIdle(id: string, exceptTaskId?: string): Promise<void> { await this.initialize(); return this.lock(async () => { this.find(id); this.idle(id, exceptTaskId); }); }
  private idle(id: string, exceptTaskId?: string) {
    const d = this.store.data;
    if ((d.active?.project === id && d.active.id !== exceptTaskId) || d.tasks?.some(t => t.project === id && t.status === 'running' && t.id !== exceptTaskId)) throw new ProjectError('This project has a running task. Stop or finish that task first.');
    if (d.backgroundJobs?.some(j => j.project === id && ['starting', 'running'].includes(j.status))) throw new ProjectError('This project has a running background job. Finish or cancel it before closing the project.');
  }
  private async retire(id: string, action: 'archived' | 'trashed', now: Date) {
    const p = this.find(id); this.idle(id);
    if (p.status === action) return this.view(p);
    if (!['active', 'archived'].includes(p.status)) throw new ProjectError('Restore the project from Trash before changing its status.');
    p.status = action; p.updatedAt = now.toISOString();
    if (action === 'archived') p.archivedAt = now.toISOString();
    else { p.trashedAt = now.toISOString(); p.purgeAt = new Date(+now + 48 * 3600000).toISOString(); }
    for (const s of this.store.data.schedules ?? []) if (s.project === id) s.enabled = false;
    for (const t of this.store.data.tasks ?? []) if (t.project === id && t.status === 'queued') { t.status = 'cancelled'; t.finishedAt = now.toISOString(); }
    await this.fallback(); await this.store.save(); return this.view(p);
  }
  async archive(id: string, now = new Date()) { await this.initialize(); return this.lock(() => this.retire(id, 'archived', now)); }
  async trash(id: string, now = new Date()) { await this.initialize(); return this.lock(() => this.retire(id, 'trashed', now)); }
  async restore(id: string, now = new Date()) {
    await this.initialize(); return this.lock(async () => {
      const p = this.find(id);
      if (['purged', 'purging'].includes(p.status)) throw new ProjectError('This project was permanently deleted or its purge has started.');
      if (p.status === 'trashed' && (!p.purgeAt || Date.parse(p.purgeAt) <= +now)) throw new ProjectError('This project passed its 48-hour restore deadline.');
      if (p.status === 'active') return this.view(p);
      await this.directory(id, false); p.status = 'active'; p.updatedAt = now.toISOString();
      delete p.archivedAt; delete p.trashedAt; delete p.purgeAt; await this.store.save(); return this.view(p);
    });
  }
  async purge(id: string) {
    await this.initialize(); return this.lock(async () => {
      const p = this.find(id); if (p.status === 'purged') return;
      if (!['trashed', 'purging'].includes(p.status)) throw new ProjectError('Move the project to Trash before permanently deleting it.');
      this.idle(id);
      const base = await this.directoryBase(), target = path.resolve(base, this.id(id));
      if (path.dirname(target) !== base || path.relative(base, target) !== id) throw new ProjectError('Invalid project deletion target.');
      const info = await lstat(target).catch(error => { if (missing(error)) return undefined; throw error; });
      if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new ProjectError('Refusing permanent deletion through a symlink or invalid project directory.');
      p.status = 'purging'; await this.store.save();
      const d = this.store.data;
      const owned = new Set([
        ...d.conversations!.filter(c => c.project === id).map(c => c.id),
        ...d.tasks!.filter(t => t.project === id).map(t => t.chatKey),
        ...d.uploads!.filter(u => u.project === id).map(u => u.chatKey),
        d.sessions[id], d.drafts?.[id],
      ].filter((key): key is string => !!key && !d.conversations!.some(c => c.id === key && c.project !== id)));
      for (const key of Object.keys(d.bindings ?? {})) if (owned.has(this.sessions.resolve(key, id))) owned.add(key);
      const tombstones = d.purgedSessions ??= [];
      for (const key of owned) if (!tombstones.includes(key)) tombstones.push(key);
      await this.store.save();
      for (const chat of (this.store.data.conversations ?? []).filter(c => c.project === id)) {
        if (!this.store.data.conversations!.some(c => c.id === chat.id)) continue;
        await this.sessions.trash(chat.id); await this.sessions.purge(chat.id);
      }
      const archive = new ChatArchive(path.join(this.dataDir, 'bot/chats'), this.secrets);
      for (const key of owned) {
        await archive.purge(key, path.join(this.dataDir, 'claude/projects'));
        if (d.freshContexts) delete d.freshContexts[key];
        if (d.sessionCredentials) delete d.sessionCredentials[key];
      }
      for (const [key, value] of Object.entries(d.bindings ?? {})) if (owned.has(key) || owned.has(value)) delete d.bindings![key];
      if (d.resumeDisabled) d.resumeDisabled = d.resumeDisabled.filter(key => !owned.has(key));
      for (const job of this.store.data.backgroundJobs ?? []) if (job.project === id) {
        if (!/^[a-f0-9]{16}$/.test(job.id)) throw new ProjectError('Invalid background job record.');
        const logs = path.resolve(path.dirname(this.store.file), 'background');
        const rootInfo = await lstat(logs).catch(error => { if (missing(error)) return undefined; throw error; });
        if (rootInfo?.isSymbolicLink()) throw new ProjectError('Background log directory is invalid.');
        await rm(path.join(logs, job.id + '.log'), { force: true });
      }
      // target is a verified direct workspace child. rm removes nested links,
      // rather than traversing their targets; Linux sentinel tests cover this.
      await rm(target, { recursive: true, force: true, maxRetries: 3 });
      for (const t of d.tasks ?? []) if (t.project === id) { t.prompt = '[Deleted project]'; delete t.displayPrompt; delete t.steers; delete t.voiceInput; delete t.attachedFiles; delete t.messageContext; }
      d.schedules = d.schedules?.filter(s => s.project !== id); d.uploads = d.uploads?.filter(u => u.project !== id); d.batches = d.batches?.filter(b => b.project !== id);
      d.backgroundJobs = d.backgroundJobs?.filter(j => j.project !== id); delete d.sessions[id]; delete d.drafts?.[id];
      p.status = 'purged'; p.name = 'Deleted project'; p.description = ''; p.updatedAt = p.purgedAt = new Date().toISOString();
      await this.fallback(); await this.store.save();
    });
  }
  async purgeExpired(now = new Date()) {
    await this.initialize();
    const ids = this.store.data.projects!.filter(p => p.status === 'purging' || (p.status === 'trashed' && !!p.purgeAt && Date.parse(p.purgeAt) <= +now)).map(p => p.id);
    for (const id of ids) await this.purge(id); return ids.length;
  }
  async select(id: string) {
    await this.workspace(id); return this.lock(async () => { assertProjectWork(this.store.data, id); this.store.data.project = id; await this.store.save(); return this.view(this.find(id)); });
  }
  async listFiles(id: string, query: { path?: string; offset?: number; limit?: number } = {}) {
    await this.initialize(); return this.lock(async () => {
      const p = this.find(id);
      if (!['active', 'archived'].includes(p.status)) throw new ProjectError('Restore the project before browsing its files.');
      const rel = query.path ?? '', offset = query.offset ?? 0, limit = query.limit ?? 30;
      if (path.isAbsolute(rel) || /[\\<>:"|?*\x00-\x1F]/.test(rel) || rel.split('/').some(s => s === '..' || s === '.' || (rel && !s)) || secretPath(rel)) throw new ProjectError('Use a safe relative project directory path.');
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProjectError('Invalid file-list page.');
      let dir = await this.directory(id, false);
      for (const segment of rel.split('/').filter(Boolean)) {
        dir = path.join(dir, segment); const info = await lstat(dir).catch(error => { if (missing(error)) throw new ProjectError('Project directory not found.'); throw error; });
        if (info.isSymbolicLink() || !info.isDirectory()) throw new ProjectError('Use a project directory without symlinks.');
      }
      const entries = (await readdir(dir, { withFileTypes: true })).filter(e => !e.isSymbolicLink() && !secretPath(rel ? rel + '/' + e.name : e.name))
        .filter(e => !['node_modules', '.git', '.venv', 'venv', '.cache'].includes(e.name)).sort((a, b) => a.name.localeCompare(b.name));
      return { project: id, path: rel, total: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null,
        files: entries.slice(offset, offset + limit).map(e => ({ path: rel ? rel + '/' + e.name : e.name, name: redact(e.name, this.secrets), type: e.isDirectory() ? 'directory' : 'file' })) };
    });
  }
}
