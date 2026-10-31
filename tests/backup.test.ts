import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Backups } from '../src/backup.js';
import { StateStore } from '../src/state.js';
import { ChatArchive } from '../src/chats.js';
import { SharedMemory } from '../src/memory.js';
import { Automation } from '../src/automation.js';
const key = 'af'.repeat(32);
async function setup(secret = key) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-backup-')); const store = await StateStore.open(path.join(dir, 'bot', 'state.json'));
  const chats = new ChatArchive(path.join(dir, 'bot', 'chats'), ['private-secret']); const memory = new SharedMemory(dir, ['private-secret']);
  return { dir, store, chats, memory, backups: new Backups(dir, secret, store, chats, memory, ['private-secret']) };
}
test('encrypted backup restores chats, memory, paused schedules and files while preserving live offsets and current data', async () => {
  const source = await setup();
  source.store.data.conversations!.push({ id: 'saved-chat', project: 'default', title: 'Bills', updatedAt: new Date().toISOString() });
  await source.chats.append('saved-chat', { role: 'user', text: 'Prepare bills' }); await source.memory.remember('Use INR');
  await new Automation(source.store).createSchedule({ name: 'Morning', project: 'default', kind: 'reminder', prompt: 'Review bills', cron: '0 9 * * *' });
  await mkdir(path.join(source.dir, 'workspaces/default/output'), { recursive: true }); await writeFile(path.join(source.dir, 'workspaces/default/output/test.txt'), 'artifact');
  const encrypted = await source.backups.export(true); assert.equal(encrypted.includes(Buffer.from('Prepare bills')), false);
  const target = await setup(); target.store.data.offset = 1234; target.store.data.settings = { model: 'claude-sonnet-5-5', effort: 'high', fast: true };
  await target.memory.remember('Existing preference');
  assert.deepEqual(await target.backups.restore(encrypted), { chats: 1, schedules: 1, files: 1 });
  assert.equal(target.store.data.offset, 1234); assert.equal(target.store.data.schedules![0].enabled, false);
  assert.ok(target.store.data.resumeDisabled!.includes('saved-chat')); assert.match(await target.memory.read(), /Existing preference/);
  assert.equal((await target.chats.read('saved-chat'))[0].text, 'Prepare bills');
  assert.equal(await readFile(path.join(target.dir, 'workspaces/default/output/test.txt'), 'utf8'), 'artifact');
  assert.deepEqual(await target.backups.restore(encrypted), { chats: 0, schedules: 0, files: 0 });
  assert.equal((await StateStore.open(target.store.file)).data.offset, 1234);
});
test('tampered exports, wrong keys, unsafe paths and configured secrets fail closed', async () => {
  const source = await setup(); const encrypted = await source.backups.export(); const corrupt = Buffer.from(encrypted); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => source.backups.decode(corrupt), /authentication/);
  assert.throws(() => new Backups(source.dir, 'ab'.repeat(32), source.store, source.chats, source.memory, []).decode(encrypted), /authentication/);
  const data = source.backups.decode(encrypted); data.files.push({ project: 'default', path: '../../outside.txt', base64: Buffer.from('bad').toString('base64') });
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv); const bytes = Buffer.concat([cipher.update(gzipSync(JSON.stringify(data))), cipher.final()]);
  await assert.rejects(source.backups.restore(Buffer.concat([Buffer.from('CTAB1'), iv, cipher.getAuthTag(), bytes])), /Unsafe/);
  await new Automation(source.store).createSchedule({ name: 'Secret task', kind: 'agent', project: 'default', prompt: 'private-secret', intervalMinutes: 5 });
  await assert.rejects(source.backups.export(), /credential/);
});
