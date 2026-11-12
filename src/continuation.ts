import { open } from 'node:fs/promises';
import type { Task } from './automation.js';
import { safeFile, redact } from './safety.js';

/** Extract only durable final results from successful tasks, never failed turns,
 * raw attachments, SDK transcripts, tool output or hidden reasoning. */
export async function completedWorkSummary(root: string, tasks: Task[], secrets: string[]): Promise<string> {
  const notes: string[] = [];
  for (const task of tasks.filter(t => t.kind === 'agent' && t.status === 'completed' && !t.failureKind).slice(-3)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(task.id)) continue;
    try {
      const file = await open(await safeFile(root, `result-${task.id}.txt`), 'r');
      let text: string;
      try { const bytes = Buffer.alloc(8192); const read = await file.read(bytes, 0, bytes.length, 0); text = bytes.subarray(0, read.bytesRead).toString('utf8'); }
      finally { await file.close(); }
      const excerpt = redact(text, secrets).replace(/```[\s\S]*?(?:```|$)/g, '[code omitted]').replace(/\s+/g, ' ').trim().slice(0, 700);
      if (excerpt) notes.push(excerpt);
    } catch { /* Missing/unsafe legacy results are not invented from failed history. */ }
  }
  return notes.length ? 'Earlier completed work:\n' + notes.map(t => '• ' + t).join('\n\n') : 'No verified completed-work summary is available. Project files and shared memory are still available.';
}
