import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { secretPath } from './safety.js';

const deliverable = /\.(xlsx?|csv|pdf|png|jpe?g|webp|docx|pptx|zip|txt|md|json|html)$/i;
// Filename screening for automatic delivery only, not a content classifier.
export const privateDocument = (name: string) => name.split('/').some(part => /(?:^|[._ -])(?:aadhaar|aadhar|adhaar|passport|pan(?:[_ -]?card)?|voter[_ -]?id|driving[_ -]?licen[cs]e|identity|id[_ -]?proof|api[_ -]?keys?|access[_ -]?tokens?|passwords?|secrets?)(?:[._ -]|$)/i.test(part));
export async function artifactSnapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = Object.create(null);
  let visited = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (++visited > 10000) return;
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink() || secretPath(name) || ['node_modules', '.venv', 'venv', 'uploads', 'transcripts', '.cache', 'backups'].includes(entry.name)) continue;
      // Private-looking or oversized deliverables are tracked as "skip" entries so the owner can be told.
      if (privateDocument(name)) { if (entry.isFile() && deliverable.test(entry.name)) { const s = await lstat(path.join(root, name)); out[name] = `skip-private:${s.size}:${s.mtimeMs}`; } continue; }
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile() && deliverable.test(entry.name) && !/^result-[a-z0-9-]+\.txt$/i.test(entry.name)) {
        const s = await lstat(path.join(root, name));
        out[name] = (s.size <= 49_000_000 ? '' : 'skip-large:') + `${s.size}:${s.mtimeMs}`;
      }
    }
  };
  // Automatic delivery is restricted to the dedicated deliverables directory.
  try {
    const output = await lstat(path.join(root, 'output'));
    if (!output.isDirectory() || output.isSymbolicLink()) return out;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out; throw error; }
  await walk('output', 0); return out;
}
/** Changed output files: those to send, plus a count of private-looking ones and the names of oversized ones (not sent). */
export async function changedArtifactReport(root: string, before: Record<string, string>): Promise<{ files: string[]; skippedPrivate: number; tooLarge: string[] }> {
  const after = await artifactSnapshot(root);
  const changed = Object.keys(after).filter(name => before[name] !== after[name]);
  return { files: changed.filter(name => !after[name].startsWith('skip-')), skippedPrivate: changed.filter(name => after[name].startsWith('skip-private:')).length, tooLarge: changed.filter(name => after[name].startsWith('skip-large:')) };
}
export async function changedArtifacts(root: string, before: Record<string, string>): Promise<string[]> {
  return (await changedArtifactReport(root, before)).files;
}
