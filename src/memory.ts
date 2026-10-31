import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redact } from './safety.js';

export class SharedMemory {
  readonly file: string;
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
    const current = await this.read();
    const safe = redact(text.trim(), this.secrets);
    if (!safe || safe.includes('[REDACTED]')) throw new Error('Do not store credentials in memory.');
    if (current.length + safe.length > 16_000) throw new Error('Memory is full; ask Claude to tidy it first.');
    await writeFile(this.file, `${current.trimEnd()}\n- ${safe}\n`.trimStart(), { mode: 0o600 });
  }
  async clear(): Promise<void> { await this.ensure(); await writeFile(this.file, '', { mode: 0o600 }); }
}
