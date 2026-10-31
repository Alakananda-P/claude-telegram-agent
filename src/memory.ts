import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redact } from './safety.js';

export class SharedMemory {
  readonly file: string;
  private writing: Promise<void> = Promise.resolve();
  constructor(dataDir: string, private secrets: string[]) { this.file = path.join(dataDir, 'memory', 'MEMORY.md'); }
  private async ensure(): Promise<void> {
    const dir = path.dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('Invalid memory directory.');
    try { await writeFile(this.file, '', { flag: 'wx', mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const stat = await lstat(this.file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64_000) throw new Error('Invalid or oversized memory file.');
  }
  async read(): Promise<string> {
    await this.ensure();
    return redact(await readFile(this.file, 'utf8'), this.secrets).slice(0, 16_000);
  }
  async remember(text: string): Promise<void> {
    await this.mutate(current => {
      const safe = redact(text.trim(), this.secrets);
      if (!safe || safe.includes('[REDACTED]')) throw new Error('Do not store credentials in memory.');
      if (current.split('\n').some(line => line.replace(/^- /, '').trim() === safe)) return current;
      return `${current.trimEnd()}\n- ${safe}\n`.trimStart();
    });
  }
  async replace(oldText: string, newText: string): Promise<void> {
    await this.mutate(current => {
      if (!oldText || current.split(oldText).length !== 2) throw new Error('Memory excerpt missing or ambiguous; read it again first.');
      const safe = redact(newText, this.secrets);
      if (safe.includes('[REDACTED]')) throw new Error('Do not store credentials in memory.');
      return current.replace(oldText, () => safe);
    });
  }
  private async mutate(change: (current: string) => string): Promise<void> {
    const task = this.writing.then(async () => {
      await this.ensure();
      const current = await readFile(this.file, 'utf8');
      const next = redact(change(current), this.secrets);
      if (next.length > 16000) throw new Error('Memory is full; tidy it before adding more.');
      await writeFile(this.file, next, { mode: 0o600 });
    });
    this.writing = task.catch(() => {});
    await task;
  }
  async clear(): Promise<void> { await this.ensure(); await writeFile(this.file, '', { mode: 0o600 }); }
}
