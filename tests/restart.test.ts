import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { loadConfig } from '../src/config.js';
import { Controller } from '../src/controller.js';

test('after an unexpected restart the owner learns which task stopped and the likely reason', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-restart-'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dataDir });
  const file = path.join(dataDir, 'bot', 'state.json');
  const before = await StateStore.open(file); const now = new Date().toISOString();
  before.data.tasks!.push({ id: 'task-r', project: 'default', chatKey: 'chat-a', kind: 'agent', status: 'running', prompt: 'Render the dinner video with captions and music', displayPrompt: 'Render the dinner video with captions and music', createdAt: now, startedAt: now, interactive: true },
    { id: 'task-q', project: 'default', chatKey: 'chat-a', kind: 'agent', status: 'queued', prompt: 'later', createdAt: now });
  before.data.conversations = [{ id: 'chat-a', project: 'default', updatedAt: now, title: 'Dinner video edit' }];
  before.data.active = { id: 'task-r', project: 'default', startedAt: now }; await before.save();
  const store = await StateStore.open(file);
  assert.deepEqual(store.interruptedAtStart, ['task-r']);
  const sent: string[] = [];
  const bot = new Controller(config, store, { async send(_c: number, t: string) { sent.push(t); }, async temporary() { return 1; }, async edit() {}, async remove() {}, async typing() {} } as never, { async run() { throw new Error('unused'); } });
  await bot.restartNotice();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Render the dinner video/); assert.match(sent[0], /Dinner video edit/);
  assert.match(sent[0], /memory/i); assert.match(sent[0], /2 GB/); assert.match(sent[0], /\/queue/);
  const quiet = await StateStore.open(file); sent.length = 0;
  await new Controller(config, quiet, { async send(_c: number, t: string) { sent.push(t); } } as never, { async run() { throw new Error('unused'); } }).restartNotice();
  assert.deepEqual(sent, [], 'a normal start says nothing');
});
