// Bounded deployment smoke checks. Uses a fresh temporary directory, never the
// live state store or Telegram polling. Optional network check sends/deletes only
// its own temporary message. Run: node dist/acceptance.js [--telegram].
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { StateStore } from './state.js';
import { Automation } from './automation.js';
import { ChatArchive } from './chats.js';
import { SharedMemory } from './memory.js';
import { Backups } from './backup.js';
import { editImage, validateBill } from './images.js';
import { SessionCatalog } from './sessions.js';
import { Telegram } from './telegram.js';
import { loadConfig, configSecrets } from './config.js';

export async function acceptance(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-acceptance-'));
  const store = await StateStore.open(path.join(root, 'bot', 'state.json')); const automation = new Automation(store);
  const chats = new ChatArchive(path.join(root, 'bot', 'chats'), []); const memory = new SharedMemory(root, []);
  await mkdir(path.join(root, 'workspaces', 'default', 'uploads'), { recursive: true });
  const workspace = path.join(root, 'workspaces', 'default');
  const image = await sharp({ create: { width: 160, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  await writeFile(path.join(workspace, 'uploads', 'sample.png'), image);
  const output = await editImage(workspace, 'uploads/sample.png', { crop: { left: 0, top: 0, width: 80, height: 50 }, rotate: 90, contrast: true, deskew: true });
  assert.equal(output.width, 50); assert.equal(output.height, 80); assert.deepEqual(await readFile(path.join(workspace, 'uploads/sample.png')), image);
  assert.equal(validateBill([{ label: 'Synthetic item', quantity: 2, rate: 10, amount: 20 }], 20).ready, true);
  assert.equal(validateBill([], 0, 0, 0, ['Unclear date']).ready, false);
  const now = new Date();
  await automation.createSchedule({ name: 'Synthetic reminder', kind: 'reminder', project: 'default', prompt: 'Smoke test', intervalMinutes: 1 }, now);
  await automation.tick(new Date(+now + 61000)); await automation.tick(new Date(+now + 62000)); assert.equal(store.data.tasks!.length, 1);
  await automation.claim(); const reopened = await StateStore.open(store.file); assert.equal(reopened.data.tasks![0].status, 'interrupted');
  store.data.tasks![0].status = 'completed';
  store.data.conversations!.push({ id: 'smoke-chat', project: 'default', title: 'Synthetic test', updatedAt: now.toISOString() });
  await chats.append('smoke-chat', { role: 'user', text: 'Synthetic bill' }); await memory.remember('Synthetic preference');
  const backups = new Backups(root, randomBytes(32).toString('hex'), store, chats, memory, []);
  const encrypted = await backups.export(true); assert.equal(backups.decode(encrypted).chats.length, 1);
  const sessions = new SessionCatalog(store, chats, []); await sessions.trash('smoke-chat', now); assert.equal(await sessions.purgeExpired(new Date(+now + 48 * 3600000)), 1);
  assert.deepEqual(await chats.read('smoke-chat'), []); assert.ok(await memory.read());
  await backups.restore(encrypted); assert.equal(store.data.conversations!.length, 0, 'A backup must not resurrect a purged chat');
  console.log('Feature acceptance passed: images, bill arithmetic, scheduler deduplication, restart recovery, encrypted backup, Trash and tombstones.');
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/acceptance.js')) {
  try {
    await acceptance();
    if (process.argv.includes('--telegram')) {
      const config = loadConfig(); const telegram = new Telegram(config.token, configSecrets(config));
      await telegram.call('getMe'); const id = await telegram.temporary(config.owner, 'Deployment verification…'); await telegram.remove(config.owner, id);
      console.log('Telegram acceptance passed: authenticated API, message delivery and deletion. No polling started.');
    }
  } catch { console.error('Acceptance failed; inspect the failed check in an isolated test run. No live state was modified.'); process.exitCode = 1; }
}
