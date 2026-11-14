import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { mkdir, lstat, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { StateStore } from './state.js';
import { ChatArchive } from './chats.js';
import { SharedMemory } from './memory.js';
import { secretPath, safeFile, redact } from './safety.js';
import { Automation } from './automation.js';
import { ProjectCatalog } from './projects.js';
import { projectRecordSchema, projectVisible, type ProjectRecord } from './project-state.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const project = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/);
const date = z.string().datetime();
const schema = z.object({ version: z.literal(1), createdAt: date, memory: z.string(), memoryTopics: z.array(z.object({ topic: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), text: z.string() })).optional(),
  projects: z.array(projectRecordSchema.refine(p => p.status === 'active' || p.status === 'archived')).refine(records => new Set(records.map(p => p.id)).size === records.length).optional(),
  chats: z.array(z.object({ id, project, updatedAt: date, title: z.string().max(96).optional(), turns: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(1000000) })).max(100000) })).max(10000),
  schedules: z.array(z.object({ id, name: z.string().min(1).max(80), kind: z.enum(['agent', 'reminder', 'backup']), prompt: z.string().min(1).max(10000), project, timezone: z.string(), at: z.string().optional(), cron: z.string().optional(), intervalMinutes: z.number().int().positive().optional(), nextRun: date })).max(10000),
  files: z.array(z.object({ project, path: z.string().max(512), base64: z.string().max(60000000) })).max(10000),
  bindings: z.record(id, id).optional(),
});
export class Backups {
  constructor(private root: string, private key: string | undefined, private store: StateStore, private chats: ChatArchive, private memory: SharedMemory, private secrets: string[]) {}
  private cipherKey(): Buffer { if (!this.key || !/^[a-f0-9]{64}$/i.test(this.key)) throw new Error('Backup encryption key is not configured.'); return Buffer.from(this.key, 'hex'); }
  async export(includeFiles = false): Promise<Buffer> {
    await new ProjectCatalog(this.root, this.store, this.secrets).initialize();
    const chats = [];
    for (const s of this.store.data.conversations ?? []) if (!s.trashedAt && projectVisible(this.store.data, s.project)) chats.push({ id: s.id, project: s.project, updatedAt: s.updatedAt, title: s.title, turns: (await this.chats.snapshot(s.id)).map(t => ({ role: t.role, text: t.text })) });
    const files: { project: string; path: string; base64: string }[] = []; let total = 0;
    if (includeFiles) {
      const base = path.join(this.root, 'workspaces');
      for (const p of await readdir(base, { withFileTypes: true }).catch(() => [])) {
        if (!p.isDirectory() || p.isSymbolicLink() || !project.safeParse(p.name).success || !projectVisible(this.store.data, p.name)) continue;
        const walk = async (rel: string, depth: number): Promise<void> => {
          if (depth > 6) return;
          for (const e of await readdir(path.join(base, p.name, rel), { withFileTypes: true })) {
            const name = rel ? rel + '/' + e.name : e.name;
            if (e.isSymbolicLink() || secretPath(name) || ['node_modules', '.venv', 'venv', '.git', '.cache'].includes(e.name)) continue;
            if (e.isDirectory()) await walk(name, depth + 1);
            else if (e.isFile()) {
              const file = await safeFile(path.join(base, p.name), name); const size = (await lstat(file)).size;
              if (total + size > 12000000) throw new Error('Project files exceed the 12 MB backup limit. Export chats only or split project files.');
              const bytes = await readFile(file);
              if (this.secrets.some(s => s.length > 5 && bytes.includes(Buffer.from(s)))) throw new Error('A project file contains a configured credential; remove it before exporting files.');
              total += bytes.length; files.push({ project: p.name, path: name, base64: bytes.toString('base64') });
            }
          }
        }; await walk('', 0);
      }
    }
    const included = new Map(chats.map(s => [s.id, s.project]));
    const bindings = Object.fromEntries(Object.entries(this.store.data.bindings ?? {}).filter(([from, to]) => from !== to && included.has(from) && included.get(from) === included.get(to)));
    const savedMemory = await this.memory.snapshot();
    const projects = this.store.data.projects!.filter(p => ['active', 'archived'].includes(p.status)).map(p => ({ ...p, name: redact(p.name, this.secrets), description: redact(p.description, this.secrets) }));
    const payload = schema.parse({ version: 1, createdAt: new Date().toISOString(), projects, memory: savedMemory.find(t => t.topic === 'core')?.text ?? '', memoryTopics: savedMemory.filter(t => t.topic !== 'core'), chats, bindings, schedules: (this.store.data.schedules ?? []).filter(s => projectVisible(this.store.data, s.project)), files });
    const plain = Buffer.from(JSON.stringify(payload));
    if (this.secrets.some(s => s.length > 5 && plain.includes(Buffer.from(s)))) throw new Error('Backup contains a configured credential; remove it from saved content before exporting.');
    if (plain.length > 64000000) throw new Error('Backup exceeds the 64 MB uncompressed limit.');
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.cipherKey(), iv);
    const encrypted = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
    const output = Buffer.concat([Buffer.from('CTAB1'), iv, cipher.getAuthTag(), encrypted]);
    if (output.length > 19000000) throw new Error('Encrypted backup exceeds the 19 MB limit for Telegram restore uploads.');
    return output;
  }
  decode(bytes: Buffer) {
    if (bytes.length > 49000000 || bytes.length < 34 || bytes.subarray(0, 5).toString() !== 'CTAB1') throw new Error('Invalid encrypted backup.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.cipherKey(), bytes.subarray(5, 17)); decipher.setAuthTag(bytes.subarray(17, 33));
      return schema.parse(JSON.parse(gunzipSync(Buffer.concat([decipher.update(bytes.subarray(33)), decipher.final()]), { maxOutputLength: 64000000 }).toString()));
    } catch { throw new Error('Backup authentication or format validation failed.'); }
  }
  async restore(bytes: Buffer): Promise<{ chats: number; schedules: number; files: number }> {
    const payload = this.decode(bytes);
    // Validate every file and schedule before the first write. Existing data is never overwritten.
    const referenced = new Set([...(payload.projects ?? []).map(p => p.id), ...payload.chats.map(c => c.project), ...payload.files.map(f => f.project), ...payload.schedules.map(s => s.project)]);
    for (const id of referenced) {
      if (!projectVisible(this.store.data, id)) throw new Error('This backup targets a project in Trash or permanently deleted. Restore the project manually before importing; deleted IDs cannot be reused.');
      let target = path.resolve(this.root);
      for (const segment of ['workspaces', id]) {
        target = path.join(target, segment);
        const info = await lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return undefined; });
        if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Refusing project restore through a symlink or non-directory.');
      }
    }
    for (const p of payload.projects ?? []) if ([p.name, p.description, p.id].some(v => redact(v, this.secrets) !== v || v.includes('[REDACTED]'))) throw new Error('Review project metadata before restoring; it contains private credentials.');
    const versions = new Map(payload.chats.map(s => [s.id, s.project]));
    for (const [from, to] of Object.entries(payload.bindings ?? {})) if (!versions.has(from) || versions.get(from) !== versions.get(to)) throw new Error('Invalid backup session-version link.');
    for (const f of payload.files) {
      if (secretPath(f.path) || /[\\<>:"|?*\x00-\x1F]/.test(f.path) || f.path.split('/').some(x => !x || x === '.' || x === '..') || path.isAbsolute(f.path)) throw new Error('Unsafe backup file path.');
      const bytes = Buffer.from(f.base64, 'base64');
      if (bytes.toString('base64') !== f.base64 || this.secrets.some(s => s.length > 5 && bytes.includes(Buffer.from(s)))) throw new Error('Invalid or credential-bearing backup file.');
      let target = path.resolve(this.root);
      for (const part of ['workspaces', f.project, ...f.path.split('/')]) {
        target = path.join(target, part); const stat = await lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return undefined; });
        if (stat?.isSymbolicLink()) throw new Error('Refusing restore through a symlink.');
      }
    }
    const memoryEntries = [{ topic: 'core', text: payload.memory }, ...(payload.memoryTopics ?? [])];
    if (memoryEntries.some(entry => redact(entry.text, this.secrets).includes('[REDACTED]'))) throw new Error('Review memory before restoring; it contains redacted secrets.');
    for (const s of payload.schedules) {
      const scratch = { data: { tasks: [], schedules: [] }, save: async () => {} } as unknown as StateStore;
      await new Automation(scratch).createSchedule({ ...s, at: s.at ? new Date(Date.now() + 60000).toISOString() : undefined });
    }
    const importedProjects = new Map((payload.projects ?? []).map(p => [p.id, p]));
    this.store.data.projects ??= [];
    for (const id of referenced) {
      const existing = this.store.data.projects.find(p => p.id === id);
      if (existing) continue;
      const stamp = new Date().toISOString();
      const record: ProjectRecord = importedProjects.get(id) ?? { id, name: id, description: '', status: 'active', createdAt: stamp, updatedAt: stamp };
      await mkdir(path.resolve(this.root, 'workspaces', id), { recursive: true, mode: 0o700 });
      this.store.data.projects.push({ ...record });
    }
    let chats = 0, schedules = 0, files = 0;
    const restored = new Set<string>();
    for (const s of payload.chats) {
      if (this.store.data.conversations!.some(x => x.id === s.id) || this.store.data.purgedSessions?.includes(s.id)) continue;
      await this.chats.restore(s.id, s.turns);
      this.store.data.conversations!.push({ id: s.id, project: s.project, updatedAt: s.updatedAt, title: s.title ? redact(s.title, this.secrets) : undefined });
      (this.store.data.resumeDisabled ??= []).push(s.id); restored.add(s.id); chats++;
    }
    for (const [from, to] of Object.entries(payload.bindings ?? {})) if (restored.has(from) && restored.has(to) && !this.store.data.bindings?.[from]) (this.store.data.bindings ??= Object.create(null))[from] = to;
    await this.memory.merge(memoryEntries);
    for (const s of payload.schedules) if (!this.store.data.schedules!.some(x => x.id === s.id)) { this.store.data.schedules!.push({ ...s, enabled: false }); schedules++; }
    for (const f of payload.files) {
      const base = path.resolve(this.root, 'workspaces'); await mkdir(base, { recursive: true });
      let current = base;
      for (const part of [f.project, ...f.path.split('/').slice(0, -1)]) {
        current = path.join(current, part); await mkdir(current, { recursive: true });
        if ((await lstat(current)).isSymbolicLink()) throw new Error('Refusing restore through a symlink.');
      }
      const destination = path.join(current, path.basename(f.path));
      try { await writeFile(destination, Buffer.from(f.base64, 'base64'), { flag: 'wx', mode: 0o600 }); files++; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    await this.store.save();
    await new ProjectCatalog(this.root, this.store, this.secrets).initialize();
    return { chats, schedules, files };
  }
}
