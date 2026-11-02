import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Telegram, createTelegramDispatcher } from '../src/telegram.js';
import { StateStore } from '../src/state.js';

async function setup(t: test.TestContext) {
  const requests: { method: string; body: any }[] = []; let sequence = 100;
  const failures = new Map<number, { code: number; description: string }>();
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw || '{}');
    const method = req.url!.split('/').at(-1)!; requests.push({ method, body });
    const failure = failures.get(body.message_id);
    if (method === 'deleteMessage' && failure) { res.writeHead(failure.code); res.end(JSON.stringify({ ok: false, error_code: failure.code, description: failure.description })); return; }
    res.end(JSON.stringify({ ok: true, result: method.startsWith('send') ? { message_id: ++sequence, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id, type: 'private' }, text: body.text } : true }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const dispatcher = createTelegramDispatcher();
  t.after(async () => { await dispatcher.destroy(); server.closeAllConnections(); server.close(); });
  const store = await StateStore.open(path.join(await mkdtemp(path.join(tmpdir(), 'tg-message-tools-')), 'state.json'));
  const tg = new Telegram('123456:test-token', ['private-secret'], `http://127.0.0.1:${(server.address() as { port: number }).port}`, dispatcher); tg.timeline = store;
  return { tg, store, requests, failures };
}

test('sent message catalogue survives restart, redacts previews and excludes UI and later replies', async t => {
  const { tg, store } = await setup(t); await tg.send(123, 'First private-secret'); await tg.send(123, 'Second');
  await tg.panel(123, 'Menu', []); await tg.send(123, 'New progress after the request');
  tg.timeline = await StateStore.open(store.file);
  const list = tg.listBotMessages(123, { beforeMessageId: 103 });
  assert.deepEqual(list.messages.map(m => m.id), [102, 101]); assert.match(list.messages[1].preview, /REDACTED/);
  assert.equal(tg.listBotMessages(999).messages.length, 0);
  assert.deepEqual(tg.listBotMessages(123).messages.map(m => m.id), [104, 102, 101]);
});

test('deletion accepts only verified outgoing IDs and leaves saved history and owner messages intact', async t => {
  const { tg, store, requests } = await setup(t); await tg.send(123, 'Answer'); await tg.send(123, 'Keep this answer');
  store.data.visibleMessageIds!.push(77); store.data.sessions.default = 'saved-chat';
  const result = await tg.deleteBotMessages(123, [101, 77, 987, 101]);
  assert.deepEqual(result.deleted, [101]); assert.deepEqual(result.failed.map(m => m.id), [77, 987]);
  assert.deepEqual(requests.filter(r => r.method === 'deleteMessage').map(r => r.body.message_id), [101]);
  assert.ok(store.data.visibleMessageIds!.includes(77)); assert.equal(store.data.sessions.default, 'saved-chat');
  assert.deepEqual(tg.listBotMessages(123).messages.map(m => m.id), [102]);
});

test('old messages, rejected deletions and already-missing messages have distinct honest results', async t => {
  const { tg, store, failures } = await setup(t); await tg.send(123, 'Old'); await tg.send(123, 'Unavailable'); await tg.send(123, 'Already removed');
  store.data.botMessages![0].sentAt = Date.now() - 49 * 3600000;
  failures.set(102, { code: 400, description: "Bad Request: message can't be deleted" });
  failures.set(103, { code: 400, description: 'Bad Request: message to delete not found' });
  const result = await tg.deleteBotMessages(123, [101, 102, 103]);
  assert.deepEqual(result.deleted, []); assert.deepEqual(result.alreadyMissing, [103]);
  assert.deepEqual(result.failed.map(f => f.reason), ['too_old', 'telegram_rejected']);
  assert.ok(store.data.visibleMessageIds!.includes(102)); assert.ok(!store.data.visibleMessageIds!.includes(103));
});

test('replying to an older bot message adopts its exact ID without trusting another sender or chat', async t => {
  const { tg } = await setup(t);
  const reply = { message_id: 55, date: Math.floor(Date.now() / 1000), from: { id: 123456, is_bot: true }, chat: { id: 123, type: 'private' }, text: 'Old bot reply' };
  assert.equal(await tg.rememberBotReply(123, reply), true);
  assert.equal(await tg.rememberBotReply(123, { ...reply, message_id: 56, from: { id: 999 } }), false);
  assert.equal(await tg.rememberBotReply(123, { ...reply, message_id: 57, chat: { id: 999, type: 'private' } }), false);
  assert.deepEqual((await tg.deleteBotMessages(123, [55])).deleted, [55]);
});

test('an aborted delete does not send a Telegram mutation', async t => {
  const { tg, requests } = await setup(t); await tg.send(123, 'Keep');
  await assert.rejects(tg.deleteBotMessages(123, [101], AbortSignal.abort()));
  assert.equal(requests.filter(r => r.method === 'deleteMessage').length, 0);
});
