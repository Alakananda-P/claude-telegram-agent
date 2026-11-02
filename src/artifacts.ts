import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { secretPath } from './safety.js';

const deliverable = /\.(xlsx?|csv|pdf|png|jpe?g|webp|docx|pptx|zip|txt|json|html)$/i;
export async function artifactSnapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = Object.create(null);
  let visited = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (++visited > 10000) return;
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink() || secretPath(name) || ['node_modules', '.venv', 'venv', 'uploads', 'transcripts', '.cache', 'backups'].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile() && deliverable.test(entry.name) && !/^result-[a-z0-9-]+\.txt$/i.test(entry.name)) {
        const s = await lstat(path.join(root, name));
        if (s.size <= 49_000_000) out[name] = `${s.size}:${s.mtimeMs}`;
      }
    }
  };
  await walk('', 0); return out;
}
export async function changedArtifacts(root: string, before: Record<string, string>): Promise<string[]> {
  const after = await artifactSnapshot(root);
  return Object.keys(after).filter(name => before[name] !== after[name]);
}
