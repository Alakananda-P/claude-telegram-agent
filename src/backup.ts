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

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const project = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/);
const date = z.string().datetime();
const schema = z.object({ version: z.literal(1), createdAt: date, memory: z.string().max(64000),
  chats: z.array(z.object({ id, project, updatedAt: date, title: z.string().max(96).optional(), turns: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(1000000) })).max(100000) })).max(10000),
  schedules: z.array(z.object({ id, name: z.string().min(1).max(80), kind: z.enum(['agent', 'reminder', 'backup']), prompt: z.string().min(1).max(10000), project, timezone: z.string(), at: z.string().optional(), cron: z.string().optional(), intervalMinutes: z.number().int().positive().optional(), nextRun: date })).max(10000),
  files: z.array(z.object({ project, path: z.string().max(512), base64: z.string().max(60000000) })).max(10000),
});
export class Backups {
  constructor(private root: string, private key: string | undefined, private store: StateStore, private chats: ChatArchive, private memory: SharedMemory, private secrets: string[]) {}
  private cipherKey(): Buffer { if (!this.key || !/^[a-f0-9]{64}$/i.test(this.key)) throw new Error('Backup encryption key is not configured.'); return Buffer.from(this.key, 'hex'); }
  async export(includeFiles = false): Promise<Buffer> {
    const chats = [];
    for (const s of this.store.data.conversations ?? []) if (!s.trashedAt) chats.push({ id: s.id, project: s.project, updatedAt: s.updatedAt, title: s.title, turns: (await this.chats.read(s.id)).map(t => ({ role: t.role, text: t.text })) });
    const files: { project: string; path: string; base64: string }[] = []; let total = 0;
    if (includeFiles) {
      const base = path.join(this.root, 'workspaces');
      for (const p of await readdir(base, { withFileTypes: true }).catch(() => [])) {
        if (!p.isDirectory() || p.isSymbolicLink() || !project.safeParse(p.name).success) continue;
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
    const payload = schema.parse({ version: 1, createdAt: new Date().toISOString(), memory: await this.memory.read(), chats, schedules: this.store.data.schedules ?? [], files });
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
    const existing = await this.memory.read();
    const mergeMemory = payload.memory.trim() && !existing.includes(payload.memory.trim());
    if (mergeMemory && ((existing + payload.memory).length + 4 > 16000 || redact(payload.memory, this.secrets).includes('[REDACTED]'))) throw new Error('Review memory before restoring; the merged memory is oversized or contains redacted secrets.');
    for (const s of payload.schedules) {
      const scratch = { data: { tasks: [], schedules: [] }, save: async () => {} } as unknown as StateStore;
      await new Automation(scratch).createSchedule({ ...s, at: s.at ? new Date(Date.now() + 60000).toISOString() : undefined });
    }
    let chats = 0, schedules = 0, files = 0;
    for (const s of payload.chats) {
      if (this.store.data.conversations!.some(x => x.id === s.id) || this.store.data.purgedSessions?.includes(s.id)) continue;
      await this.chats.restore(s.id, s.turns);
      this.store.data.conversations!.push({ id: s.id, project: s.project, updatedAt: s.updatedAt, title: s.title ? redact(s.title, this.secrets) : undefined });
      (this.store.data.resumeDisabled ??= []).push(s.id); chats++;
    }
    if (mergeMemory) await this.memory.remember(payload.memory);
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
    await this.store.save(); return { chats, schedules, files };
  }
}
