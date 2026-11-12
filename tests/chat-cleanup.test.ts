import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Telegram } from '../src/telegram.js';
import { StateStore } from '../src/state.js';
import { Controller } from '../src/controller.js';
import { loadConfig } from '../src/config.js';
import type { Message } from '../src/safety.js';

const message = (text: string, id: number): Message => ({ message_id: id, from: { id: 123 }, chat: { id: 123, type: 'private' }, text });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t: test.TestContext, deletion: (method: string, body: any) => Promise<{ status?: number; description?: string; retry?: number }> = async () => ({})) {
  const root = await mkdtemp(path.join(tmpdir(), 'chat-cleanup-'));
  const store = await StateStore.open(path.join(root, 'bot/state.json'));
  const requests: { method: string; body: any }[] = []; let nextId = 1000;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const method = req.url!.split('/').at(-1)!, body = JSON.parse(raw); requests.push({ method, body });
    const response = method.startsWith('delete') ? await deletion(method, body) : {};
    res.writeHead(response.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response.status ? { ok: false, error_code: response.status, description: response.description, parameters: { retry_after: response.retry } }
      : { ok: true, result: method.startsWith('send') ? { message_id: nextId++, chat: { id: 123 }, date: Math.floor(Date.now() / 1000), text: body.text } : true }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const telegram = new Telegram('test-token', [], `http://127.0.0.1:${(server.address() as { port: number }).port}`); telegram.timeline = store;
  return { root, store, telegram, requests };
}

test('new chat, session navigation and following commands respond while old-message deletion is blocked', async t => {
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  const { root, store, telegram, requests } = await fixture(t, async (_method, body) => {
    if ((body.message_ids ?? [body.message_id]).some((id: number) => id === 1 || id === 2)) { entered.resolve(); await release.promise; }
    return {};
  });
  store.data.visibleMessageIds = [1, 2];
  store.data.sessions.default = 'saved-session';
  store.data.conversations = [{ id: 'saved-session', project: 'default', title: 'Kept chat', updatedAt: new Date().toISOString() }];
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: root });
  const bot = new Controller(config, store, telegram, { async run(_request, emit) { await emit({ type: 'session', id: 'another-session' }); return { text: 'Verified reply', session: 'another-session', cumulativeCost: 0 }; } });
  const fast = async (work: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('command waited for old-message deletion')), 1000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await fast(bot.handle(message('/new', 10)));
    assert.ok(requests.some(r => r.body.text?.includes('New chat ready')));
    const cleanup = telegram.cleanup(123); await entered.promise;
    await fast(bot.handle(message('/model', 11)));
    await fast(bot.handle(message('/token', 12)));
    await fast(bot.handle(message('/session saved-session', 13)));
    assert.ok(requests.some(r => r.body.text?.startsWith('Model\n')));
    assert.ok(requests.some(r => r.body.text?.includes('Usage records')));
    assert.ok(requests.some(r => r.body.text?.includes('Chat overview')));
    assert.equal(store.data.sessions.default, 'saved-session');
    await fast(bot.handle(message('Hello', 14))); await fast(bot.idle());
    assert.ok(requests.some(r => r.body.text === 'Verified reply'));
    release.resolve(); await cleanup;
    assert.ok(store.data.conversations.some(s => s.id === 'saved-session'));
  } finally { release.resolve(); await bot.stop(); }
});

test('permanently undeletable messages are retired across restarts; missing messages are forgotten', async t => {
  const { store, telegram, requests } = await fixture(t, async (method, body) => method === 'deleteMessages'
    ? { status: 400, description: "message can't be deleted" }
    : body.message_id === 1 ? { status: 400, description: "message can't be deleted for everyone" }
    : body.message_id === 2 ? { status: 400, description: 'message to delete not found' } : {});
  store.data.visibleMessageIds = [1, 2, 3];
  await telegram.queueClear(123); await telegram.cleanup(123);
  assert.deepEqual(store.data.visibleMessageIds, [1]);
  const restored = await StateStore.open(store.file); telegram.timeline = restored;
  const before = requests.length; await telegram.queueClear(123); await telegram.cleanup(123);
  assert.equal(requests.length, before, 'a permanent rejection must not be retried by another chat switch');
});

test('background cleanup preserves new replies and cleanup queued during an in-flight deletion', async t => {
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  const { store, telegram, requests } = await fixture(t, async () => { entered.resolve(); await release.promise; return {}; });
  store.data.visibleMessageIds = [1, 2];
  await telegram.queueClear(123);
  const cleanup = telegram.cleanup(123); await entered.promise;
  await telegram.panel(123, 'First new menu', []);
  await telegram.queueClear(123);
  await telegram.panel(123, 'Latest menu', []);
  release.resolve(); await cleanup;
  assert.deepEqual(store.data.visibleMessageIds, [1000, 1001]);
  assert.deepEqual(requests.filter(r => r.method === 'deleteMessages').map(r => r.body.message_ids), [[2, 1]]);
  const restored = await StateStore.open(store.file); telegram.timeline = restored;
  await telegram.cleanup(123);
  assert.deepEqual(restored.data.visibleMessageIds, [1001]);
  assert.ok(!requests.filter(r => r.method.startsWith('delete')).some(r => (r.body.message_ids ?? [r.body.message_id]).includes(1001)));
});

test('transient cleanup failures survive restart and respect retry backoff', async t => {
  let fail = true;
  const { store, telegram, requests } = await fixture(t, async () => fail ? { status: 503, description: 'temporary outage' } : {});
  store.data.visibleMessageIds = [4];
  const now = Date.now(); await telegram.queueClear(123); await telegram.cleanup(123, now);
  assert.deepEqual(store.data.visibleMessageIds, [4]);
  const restored = await StateStore.open(store.file); telegram.timeline = restored;
  const before = requests.length; await telegram.cleanup(123, now + 100);
  assert.equal(requests.length, before);
  fail = false; await telegram.cleanup(123, now + 600000);
  assert.deepEqual(restored.data.visibleMessageIds, []);
});

test('unknown deletion errors remain retryable rather than being permanently retired', async t => {
  let fail = true;
  const { store, telegram } = await fixture(t, async () => fail ? { status: 400, description: 'unknown request rejection' } : {});
  store.data.visibleMessageIds = [5]; const now = Date.now();
  await telegram.queueClear(123); await telegram.cleanup(123, now);
  assert.deepEqual(store.data.visibleMessageIds, [5]);
  assert.ok(!store.data.undeletableMessageIds?.includes(5));
  fail = false; await telegram.cleanup(123, now + 600000);
  assert.deepEqual(store.data.visibleMessageIds, []);
});

test('known old bot messages skip futile deletion calls and old callbacks cannot reuse queued panels', async t => {
  const { store, telegram, requests } = await fixture(t);
  await telegram.panel(123, 'Old panel', []);
  store.data.botMessages![0].sentAt = Date.now() - 49 * 3600000;
  await telegram.queueClear(123);
  await telegram.panel(123, 'New panel', [], 1000);
  assert.equal(requests.filter(r => r.method === 'sendMessage').length, 2);
  assert.equal(requests.filter(r => r.method === 'editMessageText').length, 0);
  await telegram.cleanup(123);
  assert.equal(requests.filter(r => r.method.startsWith('delete')).length, 0);
  assert.deepEqual(store.data.visibleMessageIds, [1000, 1001]);
  await telegram.queueClear(123); await telegram.cleanup(123);
  assert.deepEqual(requests.filter(r => r.method === 'deleteMessages').map(r => r.body.message_ids), [[1001]]);
});
