import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../src/controller.js';
import type { Runner, AgentRequest } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import type { Message } from '../src/safety.js';

const message = (text: string): Message => ({ from: { id: 123 }, chat: { id: 123, type: 'private' }, text });
async function setup(runner?: Runner) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-agent-controller-'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dataDir });
  const store = await StateStore.open(path.join(dataDir, 'bot', 'state.json'));
  const replies: string[] = [];
  const calls: AgentRequest[] = [];
  const sender = { async send(_chat: number, text: string) { replies.push(text); },
    async sendFile(_chat: number, _name: string, bytes: Uint8Array) { replies.push(Buffer.from(bytes).toString()); },
    async download(_fileId: string) { return Buffer.from('uploaded'); } };
  const agent: Runner = runner ?? { async run(request, emit) {
    calls.push(request); await emit({ type: 'session', id: 'session-' + calls.length });
    return { text: 'Task complete', session: 'session-' + calls.length, cumulativeCost: 0.1 };
  } };
  return { bot: new Controller(config, store, sender, agent), store, replies, calls, config, dataDir };
}

test('unauthorized messages do not produce replies, uploads or jobs', async () => {
  const { bot, replies, calls } = await setup();
  await bot.handle({ ...message('do work'), from: { id: 666 } });
  await bot.handle({ ...message('/status'), chat: { id: -1, type: 'group' } });
  assert.deepEqual(replies, []); assert.deepEqual(calls, []);
});

test('session resumes by project, /new keeps files and new projects are isolated', async () => {
  const { bot, calls, store } = await setup();
  await bot.handle(message('first')); await bot.idle();
  await bot.handle(message('second')); await bot.idle();
  assert.equal(calls[1].session, 'session-1');
  await bot.handle(message('/project other'));
  await bot.handle(message('third')); await bot.idle();
  assert.equal(calls[2].session, undefined);
  assert.ok(calls[2].cwd.endsWith(path.join('workspaces', 'other')));
  await bot.handle(message('/new'));
  assert.equal(store.data.sessions.other, undefined);
  assert.equal(store.data.sessions.default, 'session-2');
});

test('busy task rejects overlap, /status stays responsive and /stop aborts', async () => {
  let calls = 0;
  const runner: Runner = { async run(_request, _emit, abort) {
    calls++;
    await new Promise<void>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(new Error('cancel')), { once: true }));
    throw new Error('unreachable');
  } };
  const { bot, replies, store } = await setup(runner);
  await bot.handle(message('first'));
  await bot.handle(message('second'));
  await bot.handle(message('/project forbidden'));
  await bot.handle(message('/status'));
  assert.equal(calls, 1);
  assert.equal(store.data.project, 'default');
  assert.ok(replies.some(r => /busy/i.test(r)));
  assert.ok(replies.some(r => /running/i.test(r)));
  await bot.handle(message('/stop')); await bot.idle();
  assert.equal(store.data.lastJob?.status, 'cancelled');
  assert.equal(store.data.active, null);
});

test('work continues beyond the former daily cap without budget reservations', async () => {
  const { bot, store, calls, replies } = await setup();
  for (let i = 0; i < 7; i++) {
    await bot.handle(message(`Task ${i}`)); await bot.idle();
  }
  assert.equal(calls.length, 7);
  assert.equal(store.data.lastJob?.status, 'completed');
  assert.equal(Object.hasOwn(store.data, 'daily'), false);
  assert.equal(Object.hasOwn(store.data.lastJob!, 'reserved'), false);
  await bot.handle(message('/status'));
  assert.match(replies.at(-1)!, /Spending cap: none/);
  assert.ok(!replies.some(r => /reserved budget|daily.*budget.*reached/i.test(r)));
});

test('document uploads use unique safe paths and caption starts work', async () => {
  const { bot, calls, dataDir } = await setup();
  const m = { ...message(''), document: { file_id: 'file-1', file_name: '../../hello.py', file_size: 8 }, caption: 'Read this file' };
  await bot.handle(m); await bot.idle();
  const uploads = path.join(dataDir, 'workspaces', 'default', 'uploads');
  const names = await readdir(uploads);
  assert.equal(names.length, 1);
  assert.equal(await readFile(path.join(uploads, names[0]), 'utf8'), 'uploaded');
  assert.ok(calls[0].prompt.includes('uploads/'));
  assert.ok(calls[0].prompt.includes('Read this file'));
});

test('failed model runs release busy state without leaking exception data', async () => {
  const { bot, store, replies } = await setup({ async run() { throw new Error('test-only-secret'); } });
  await bot.handle(message('first')); await bot.idle();
  assert.equal(store.data.active, null);
  assert.equal(store.data.lastJob?.status, 'failed');
  assert.ok(!replies.join('').includes('test-only-secret'));
});

test('project names matching Object prototype properties start without a phantom session', async () => {
  const { bot, calls } = await setup();
  await bot.handle(message('/project constructor'));
  await bot.handle(message('first')); await bot.idle();
  assert.equal(calls[0].session, undefined);
});

test('timeout still aborts bounded work without a spending cap', async () => {
  const runner: Runner = { async run(_request, _emit, abort) {
    await new Promise<void>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    throw new Error('unreachable');
  } };
  const { bot, config, store, replies } = await setup(runner);
  config.timeoutMs = 20;
  await bot.handle(message('work')); await bot.idle();
  assert.equal(store.data.lastJob?.status, 'cancelled');
  assert.ok(replies.some(r => r.includes('time limit')));
});
