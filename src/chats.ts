import { mkdir, readFile, writeFile, rename, unlink, readdir, lstat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { redact } from './safety.js';

export interface ChatTurn { role: 'user' | 'assistant'; text: string; file?: { id: string; name: string } }
export class ChatArchive {
  private writing: Promise<void> = Promise.resolve();
  constructor(private dir: string, private secrets: string[]) {}
  private file(id: string): string { return path.join(this.dir, createHash('sha256').update(id).digest('hex') + '.json'); }
  async read(id: string): Promise<ChatTurn[]> {
    try {
      const data = JSON.parse(await readFile(this.file(id), 'utf8'));
      if (!Array.isArray(data) || !data.every(x => ['user', 'assistant'].includes(x.role) && typeof x.text === 'string')) throw new Error('Invalid chat archive');
      return data;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Cannot read saved chat.'); }
  }
  private async write(id: string, turns: ChatTurn[]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(id);
    await writeFile(file + '.tmp', JSON.stringify(turns), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
  async append(id: string, turn: ChatTurn): Promise<void> {
    const task = this.writing.then(async () => {
      const turns = await this.read(id);
      turns.push({ ...turn, text: redact(turn.text, this.secrets) });
      await this.write(id, turns);
    });
    this.writing = task.catch(() => {});
    await task;
  }
  async bind(from: string, to: string): Promise<void> {
    if (from === to) return;
    await this.writing;
    const existing = await this.read(to);
    const incoming = await this.read(from);
    if (incoming.length) await this.write(to, [...existing, ...incoming]);
    if (from.startsWith('draft-')) await unlink(this.file(from)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  async resetDraft(project: string): Promise<void> { await this.writing; await unlink(this.file('draft-' + project)).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  async purge(id: string, transcriptRoot?: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid session ID.');
    await this.writing;
    await unlink(this.file(id)).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (!transcriptRoot) return;
    const dirs = await readdir(transcriptRoot, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const root = path.resolve(transcriptRoot);
    for (const dir of dirs.filter(x => x.isDirectory() && !x.isSymbolicLink())) {
      for (const name of [id + '.jsonl', id]) {
        const target = path.resolve(root, dir.name, name);
        if (!target.startsWith(root + path.sep)) throw new Error('Invalid transcript path.');
        const stat = await lstat(target).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
        if (stat?.isSymbolicLink()) throw new Error('Refusing a transcript symlink.');
        if (stat) await rm(target, { recursive: stat.isDirectory(), force: true });
      }
    }
  }
  async restore(id: string, turns: ChatTurn[]): Promise<void> {
    await this.writing;
    if ((await this.read(id)).length) return;
    await this.write(id, turns.map(t => ({ role: t.role, text: redact(t.text, this.secrets), ...(t.file ? { file: t.file } : {}) })));
  }

  /** Import only ordinary user/final assistant text from main transcripts.
   * Never replay reasoning blocks, tool results, sidechains or synthetic prompts. */
  async importHistory(root: string, excluded: string[] = []): Promise<{ id: string; project: string; updatedAt: string }[]> {
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const found: { id: string; project: string; updatedAt: string }[] = [];
    for (const projectDir of projects.filter(x => x.isDirectory() && !x.isSymbolicLink())) {
      const dir = path.join(root, projectDir.name);
      for (const file of await readdir(dir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const id = file.name.slice(0, -6);
        if (excluded.includes(id)) continue;
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
        const turns: ChatTurn[] = [];
        const seen = new Set<string>();
        let project: string | undefined;
        let updatedAt = new Date(0).toISOString();
        const lines = createInterface({ input: createReadStream(path.join(dir, file.name)), crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            let row: any;
            try { row = JSON.parse(line); } catch { continue; }
            if (row.isSidechain || row.isMeta || row.parent_tool_use_id) continue;
            const cwd = typeof row.cwd === 'string' ? row.cwd.replace(/\\/g, '/') : '';
            const match = /\/workspaces\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,47})\/?$/.exec(cwd);
            if (match) project = match[1];
            if (Number.isFinite(Date.parse(row.timestamp)) && row.timestamp > updatedAt) updatedAt = row.timestamp;
            if (!['user', 'assistant'].includes(row.type) || !row.message) continue;
            const content = row.message.content;
            if (Array.isArray(content) && content.some((b: any) => b.type === 'tool_use' || b.type === 'tool_result')) continue;
            const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '';
            const key = row.uuid ?? row.message.id;
            if (!text || (key && seen.has(key))) continue;
            if (key) seen.add(key);
            turns.push({ role: row.type, text: redact(text, this.secrets) });
          }
        } finally { lines.close(); }
        if (!project) continue;
        if ((await this.read(id)).length === 0 && turns.length) await this.write(id, turns);
        found.push({ id, project, updatedAt });
      }
    }
    return found;
  }
}
