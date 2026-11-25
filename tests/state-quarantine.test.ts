import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { loadConfig } from '../src/config.js';
import { Controller } from '../src/controller.js';
import type { Message } from '../src/safety.js';
import type { Runner } from '../src/agent.js';
import type { TranscriptionService } from '../src/transcription.js';

const message = (text: string): Message => ({ from: { id: 123 }, chat: { id: 123, type: 'private' }, text });

async function running(transcriber?: TranscriptionService) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-quarantine-'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dataDir });
  const store = await StateStore.open(path.join(dataDir, 'bot', 'state.json'));
  const replies: string[] = [];
  let began!: () => void; let release!: () => void;
  const ready = new Promise<void>(r => { began = r; }); const waiting = new Promise<void>(r => { release = r; });
  const runner: Runner = { async run(_r, emit) { await emit({ type: 'session', id: 'long-chat' }); began(); await waiting; return { session: 'long-chat', text: 'Done', cumulativeCost: 0 }; } };
  const sender = { async send(_c: number, t: string) { replies.push(t); }, async temporary() { return 9; }, async edit() {}, async remove() {}, async typing() {},
    async panel(_c: number, t: string) { replies.push(t); }, async acknowledge() {}, async download() { return Buffer.from('ogg'); } };
  const bot = new Controller(config, store, sender as never, runner, undefined, undefined, undefined, transcriber);
  return { bot, store, replies, ready, release, dataDir };
}

test('H3: an oversized steer is refused before it is saved, so the bot still starts', async () => {
  const { bot, store, replies, ready, release, dataDir } = await running();
  try {
    await bot.handle(message('Long task')); await ready;
    await (bot as unknown as { launch(p: string, cwd: string): Promise<void> }).launch('x'.repeat(30001), path.join(dataDir, 'workspaces', 'default'));
    assert.equal(store.data.tasks!.length, 1);
    assert.equal(store.data.tasks![0].steers?.length ?? 0, 0, 'nothing oversized is stored');
    assert.ok(replies.some(r => /too long/i.test(r)), replies.join(' | '));
  } finally { release(); await bot.idle(); }
  await StateStore.open(store.file);
});

test('H3: an oversized voice steer transcript never reaches the saved record', async () => {
  const { bot, store, ready, release } = await running({ async transcribe() { return { text: 'y'.repeat(30001), hasSpeech: true, transcriptFile: 'uploads/t.txt' } as never; } });
  try {
    await bot.handle(message('Long task')); await ready;
    await bot.handle({ ...message(''), voice: { file_id: 'v1', duration: 3, mime_type: 'audio/ogg' } } as Message);
    for (let i = 0; i < 100 && store.data.tasks![0].steers?.[0]?.status !== 'failed'; i++) await new Promise(r => setTimeout(r, 10));
    const steer = store.data.tasks![0].steers![0];
    assert.equal(steer.status, 'failed'); assert.ok(steer.text.length <= 30000 && steer.displayText.length <= 30000);
  } finally { release(); await bot.idle(); }
  await StateStore.open(store.file);
});

test('H3: open() moves invalid task and steer records to a quarantine file instead of refusing to start', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-quarantine-open-')); const file = path.join(dir, 'state.json');
  const now = new Date().toISOString();
  const good = { id: 'good', project: 'default', chatKey: 'chat-a', kind: 'agent', status: 'completed', prompt: 'ok', createdAt: now,
    steers: [{ id: 's-ok', text: 'fine', displayText: 'fine', status: 'answered' }, { id: 's-big', text: 'z'.repeat(30001), displayText: 'z', status: 'failed' }] };
  const broken = { id: 'bad', status: 'queued', project: '../outside', prompt: 'run' };
  await writeFile(file, JSON.stringify({ version: 1, offset: 5, project: 'default', sessions: {}, active: null, lastJob: null, tasks: [good, broken] }));
  const store = await StateStore.open(file);
  assert.deepEqual(store.data.tasks!.map(t => t.id), ['good'], 'malformed work is never kept or executed');
  assert.deepEqual(store.data.tasks![0].steers!.map(s => s.id), ['s-ok']);
  assert.equal(store.data.offset, 5);
  const saved = (await readdir(dir)).filter(f => f.startsWith('state.json.quarantine-'));
  assert.equal(saved.length, 1);
  const quarantined = JSON.parse(await readFile(path.join(dir, saved[0]), 'utf8'));
  assert.deepEqual(quarantined.map((q: { kind: string }) => q.kind).sort(), ['steer', 'task']);
  assert.ok(store.quarantinedAtStart?.endsWith(saved[0]));
  const sent: string[] = [];
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dir });
  await new Controller(config, store, { async send(_c: number, t: string) { sent.push(t); } } as never, { async run() { throw new Error('unused'); } }).restartNotice();
  assert.equal(sent.length, 1); assert.match(sent[0], /quarantine/); assert.match(sent[0], /not run/);
});

test('M1: a corrupt chat archive makes /history answer with an error instead of throwing', async () => {
  const { bot, store, replies, dataDir, release } = await running(); release();
  store.data.conversations = [{ id: 'chat-x', project: 'default', updatedAt: new Date().toISOString(), title: 'Broken' }]; store.data.sessions.default = 'chat-x';
  const { createHash } = await import('node:crypto'); const { mkdir } = await import('node:fs/promises');
  const chats = path.join(dataDir, 'bot', 'chats'); await mkdir(chats, { recursive: true });
  await writeFile(path.join(chats, createHash('sha256').update('chat-x').digest('hex') + '.json'), '{not json');
  await bot.handle(message('/history chat-x'));
  await bot.callback({ id: 'cb', from: { id: 123 }, message: { ...message(''), message_id: 7 }, data: 'history chat-x 0' });
  assert.ok(replies.filter(r => /still running/i.test(r)).length >= 2, replies.join(' | '));
});

test('M6: a failing purge does not pause new tasks; a real state save failure still does', async () => {
  const { bot, store, replies, release } = await running(); release();
  const internals = bot as unknown as { sessions: { purgeExpired(): Promise<number> }; persistenceFailed: boolean };
  internals.sessions.purgeExpired = async () => { throw Object.assign(new Error('resource busy'), { code: 'EBUSY' }); };
  bot.start(); await new Promise(r => setTimeout(r, 30));
  assert.equal(internals.persistenceFailed, false);
  await bot.handle(message('New task after a purge error')); await bot.idle();
  assert.ok(!replies.some(r => /State storage failed/.test(r)), replies.join(' | '));
  assert.equal(store.data.tasks!.at(-1)!.status, 'completed');
  await bot.stop();
  const { StateSaveError } = await import('../src/state.js');
  const second = await running(); second.release();
  (second.bot as unknown as { sessions: { purgeExpired(): Promise<number> } }).sessions.purgeExpired = async () => { throw new StateSaveError(new Error('ENOSPC')); };
  second.bot.start(); await new Promise(r => setTimeout(r, 30));
  assert.equal((second.bot as unknown as { persistenceFailed: boolean }).persistenceFailed, true);
  await second.bot.stop();
});
