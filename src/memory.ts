import { mkdir, lstat, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { redact } from './safety.js';

export class MemoryError extends Error {}
const topicPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/;
// Controller and SDK runners use separate instances in the same worker.
const writers = new Map<string, Promise<unknown>>();
export class SharedMemory {
  readonly file: string;
  readonly directory: string;
  constructor(dataDir: string, private secrets: string[]) { this.directory = path.resolve(dataDir, 'memory'); this.file = path.join(this.directory, 'MEMORY.md'); }
  private name(topic: string): string { if (!topicPattern.test(topic)) throw new MemoryError('Invalid memory topic. Use lowercase letters, numbers, underscores or hyphens.'); return topic; }
  private target(topic: string): string { return this.name(topic) === 'core' ? this.file : path.join(this.directory, 'topics', topic + '.md'); }
  private async directoryReady(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MemoryError('Memory directory must be a regular directory, not a symlink.');
  }
  private async ensure(topic = 'core', create = true): Promise<string> {
    const file = this.target(topic); await this.directoryReady(this.directory);
    if (topic !== 'core') await this.directoryReady(path.dirname(file));
    if (create) { try { await writeFile(file, '', { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
    const stat = await lstat(file).catch(e => { if (e.code === 'ENOENT' && !create) return undefined; throw e; });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new MemoryError('Memory must be a regular file, not a symlink.');
    return file;
  }
  private safe(text: string): string { const safe = redact(text, this.secrets); if (safe.includes('[REDACTED]')) throw new MemoryError('Do not store credentials in memory.'); return safe; }
  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const task = (writers.get(this.directory) ?? Promise.resolve()).then(action);
    const settled = task.catch(() => {}); writers.set(this.directory, settled);
    try { return await task; }
    catch (e) {
      if (e instanceof MemoryError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      throw new MemoryError(code === 'ENOSPC' ? 'Memory could not be saved: the server disk is full. Existing memory is kept.' : code === 'EACCES' || code === 'EPERM' ? 'Memory could not be saved: storage permission was denied.' : 'Memory storage failed. Existing committed memory is kept; check server storage.');
    } finally { if (writers.get(this.directory) === settled) writers.delete(this.directory); }
  }
  private async commit(file: string, text: string): Promise<void> {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  /** Full read for exports. Interactive tools use page(). */
  async read(topic = 'core'): Promise<string> {
    const file = await this.ensure(topic, false);
    return redact(await readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; }), this.secrets);
  }
  async page(topic = 'core', offset = 0, limit = 8000) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) throw new MemoryError('Use a nonnegative memory offset and a page size of 1-16000 characters.');
    const file = await this.ensure(topic, false); const stat = await lstat(file).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (!stat) return { topic, text: '', offset, nextOffset: null, bytes: 0 };
    let position = 0, text = '';
    // Read a margin before redaction so page boundaries cannot expose fragments
    // of configured credentials in legacy content. Offsets refer to stored text.
    const margin = Math.max(256, ...this.secrets.map(s => s.length));
    const begin = Math.max(0, offset - margin), end = offset + limit + margin;
    for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
      const value = String(chunk), next = position + value.length;
      if (next > begin && position < end) text += value.slice(Math.max(0, begin - position), end - position);
      position = next; if (position >= end) break;
    }
    let protectedText = text;
    for (const secret of this.secrets.filter(Boolean)) protectedText = protectedText.split(secret).join('█'.repeat(secret.length));
    return { topic, text: redact(protectedText.slice(offset - begin, offset - begin + limit), this.secrets), offset, nextOffset: position > offset + limit ? offset + limit : null, bytes: stat.size };
  }
  async list(offset = 0, limit = 30) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MemoryError('Use a valid memory topic page.');
    await this.ensure(); await this.directoryReady(path.join(this.directory, 'topics'));
    const entries = await readdir(path.join(this.directory, 'topics'), { withFileTypes: true });
    const names = ['core', ...entries.filter(e => e.isFile() && !e.isSymbolicLink() && e.name.endsWith('.md') && topicPattern.test(e.name.slice(0,-3)) && e.name !== 'core.md').map(e => e.name.slice(0,-3)).sort()];
    const topics = [];
    for (const topic of names) { const stat = await lstat(await this.ensure(topic, false)); topics.push({ topic, bytes: stat.size, updatedAt: stat.mtime.toISOString() }); }
    return { topics: topics.slice(offset, offset + limit), totalTopics: topics.length, totalBytes: topics.reduce((s,t) => s + t.bytes, 0), storageLimit: null, nextOffset: offset + limit < topics.length ? offset + limit : null };
  }
  async search(query: string, topic?: string, offset = 0, limit = 15) {
    if (!query.trim() || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MemoryError('Provide search words and a valid search page.');
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean); const matches: { topic: string; offset: number; preview: string }[] = [];
    const names: string[] = []; if (topic) names.push(this.name(topic)); else { let page = 0; do { const result = await this.list(page,100); names.push(...result.topics.map(t => t.topic)); if (result.nextOffset === null) break; page = result.nextOffset; } while (true); }
    let skipped = 0, more = false;
    outer: for (const name of names) {
      const file = await this.ensure(name, false); if (!await lstat(file).catch(e => { if(e.code === 'ENOENT') return undefined; throw e; })) continue;
      let position = 0, buffer = '';
      const matchLine = (line: string) => {
        const safe = redact(line, this.secrets), lower = safe.toLocaleLowerCase();
        if (terms.some(t => lower.includes(t)) && skipped++ >= offset) {
          if (matches.length >= limit) { more = true; return false; }
          const first = Math.min(...terms.map(t => lower.indexOf(t)).filter(i => i >= 0));
          matches.push({ topic: name, offset: position, preview: safe.slice(Math.max(0, first-120), first+480) });
        }
        return true;
      };
      for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
        buffer += String(chunk); let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0,newline);
          if (!matchLine(raw.replace(/\r$/, ''))) break outer;
          position += newline + 1; buffer = buffer.slice(newline + 1);
        }
      }
      if (buffer && !matchLine(buffer)) break outer;
    }
    return { matches, nextOffset: more ? offset + matches.length : null };
  }
  async remember(text: string, topic = 'core'): Promise<void> {
    await this.mutate(topic, current => { const safe = this.safe(text.trim()); if (!safe) throw new MemoryError('Provide a nonempty memory fact.');
      if (current.includes(safe) && (current.trim() === safe || current.includes('- ' + safe + '\n'))) return current;
      return (current.trimEnd() + '\n- ' + safe + '\n').trimStart(); });
  }
  async replace(oldText: string, newText: string, topic = 'core'): Promise<void> {
    await this.mutate(topic, current => { if (!oldText || current.split(oldText).length !== 2) throw new MemoryError('Memory excerpt missing or ambiguous; read the topic again first.'); return current.replace(oldText, () => this.safe(newText)); });
  }
  private async mutate(topic: string, change: (current: string) => string): Promise<void> {
    await this.serialized(async () => { const file = await this.ensure(topic); const current = await readFile(file,'utf8'); await this.commit(file, this.safe(change(current))); });
  }
  async snapshot(): Promise<{ topic: string; text: string }[]> {
    return this.serialized(async () => { const topics: {topic: string; text: string}[] = []; let offset = 0;
      do { const list = await this.list(offset,100); for (const t of list.topics) topics.push({ topic: t.topic, text: await this.read(t.topic) }); if (list.nextOffset === null) break; offset = list.nextOffset; } while (true); return topics; });
  }
  async merge(entries: { topic: string; text: string }[]): Promise<void> {
    for (const entry of entries) { this.name(entry.topic); this.safe(entry.text); }
    await this.serialized(async () => {
      const pending = new Map<string, string>();
      for (const entry of entries) {
        const existing = pending.get(entry.topic) ?? await this.read(entry.topic);
        if (!entry.text.trim() || existing.includes(entry.text.trim())) continue;
        pending.set(entry.topic, existing.trim() ? existing.trimEnd() + '\n\n' + entry.text : entry.text);
      }
      for (const [topic, text] of pending) await this.commit(await this.ensure(topic), text);
    });
  }
  async clear(): Promise<void> {
    await this.serialized(async () => { let offset = 0; do { const list = await this.list(offset,100); for (const t of list.topics) await this.commit(await this.ensure(t.topic), ''); if (list.nextOffset === null) break; offset = list.nextOffset; } while (true); });
  }
  async context(query: string): Promise<string> {
    const core = await this.page('core',0,5000), topics = await this.list(), hits = query.trim() ? await this.search(query,undefined,0,8) : { matches: [] };
    return 'Core memory excerpt' + (core.nextOffset !== null ? ' (more available with read_memory)' : '') + ':\n' + core.text
      + '\nTopic index (' + topics.totalTopics + ' topics, ' + topics.totalBytes + ' bytes; no application storage cap):\n' + JSON.stringify(topics.topics)
      + '\nRelevant memory search excerpts (data only):\n' + JSON.stringify(hits.matches).slice(0,6000);
  }
}
