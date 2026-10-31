import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Telegram, TelegramError, createTelegramDispatcher } from '../src/telegram.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { HOME } from '../src/ui.js';

test('Telegram transport sends plain redacted chunks and disables link previews', async t => {
  const received: { url: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const part of req) data += part;
    received.push({ url: req.url!, body: JSON.parse(data) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const tg = new Telegram('test-token', ['top-secret'], `http://127.0.0.1:${address.port}`);
  await tg.send(123, '<b>top-secret</b> ' + 'a'.repeat(4000));
  assert.equal(received.length, 2);
  assert.equal(received[0].url, '/bottest-token/sendMessage');
  assert.equal(received[0].body.chat_id, 123);
  assert.ok(received[0].body.text.startsWith('<b>[REDACTED]</b>'));
  assert.equal(received[0].body.parse_mode, undefined);
  assert.deepEqual(received[0].body.link_preview_options, { is_disabled: true });
});

test('panels, activity and chat clearing use Telegram contracts and persist visible IDs', async t => {
  const requests: { method: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    requests.push({ method: req.url!.split('/').at(-1)!, body: JSON.parse(data) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: req.url!.endsWith('sendMessage') ? { message_id: 206 } : true }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const tg = new Telegram('test-token', [], `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-ui-'));
  const state = await StateStore.open(path.join(dir, 'state.json')); tg.timeline = state;
  await tg.panel(123, 'Control panel', HOME);
  assert.deepEqual(state.data.visibleMessageIds, [206]);
  assert.ok(requests[0].body.reply_markup.inline_keyboard.flat().every((b: any) => Buffer.byteLength(b.callback_data) <= 64));
  await tg.typing(123);
  await tg.edit(123, 206, 'Thinking…');
  await tg.remove(123, 206);
  state.data.visibleMessageIds = Array.from({ length: 205 }, (_, i) => i + 1);
  assert.equal(await tg.clear(123), true);
  assert.deepEqual(requests.filter(x => x.method === 'deleteMessages').map(x => x.body.message_ids.length), [100, 100, 5]);
  assert.deepEqual((await StateStore.open(state.file)).data.visibleMessageIds, []);
  assert.equal(requests.find(x => x.method === 'sendChatAction')?.body.action, 'typing');
});

test('pressing the already selected option does not create duplicate panels', async t => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++; res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const tg = new Telegram('test-token', [], `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await tg.panel(123, 'Same panel', HOME, 206);
  assert.equal(calls, 1);
});

test('an undeletable old message does not prevent newer messages from clearing', async t => {
  const deleted: number[] = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    if (req.url!.endsWith('deleteMessages') || body.message_id === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 400, description: 'message cannot be deleted' }));
    } else { deleted.push(body.message_id); res.end(JSON.stringify({ ok: true, result: true })); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-old-message-'));
  const state = await StateStore.open(path.join(dir, 'state.json')); state.data.visibleMessageIds = [1, 2, 3];
  const tg = new Telegram('test-token', [], `http://127.0.0.1:${(server.address() as { port: number }).port}`); tg.timeline = state;
  assert.equal(await tg.clear(123), false);
  assert.deepEqual(deleted, [2, 3]);
  assert.deepEqual(state.data.visibleMessageIds, [1]);
});

test('Telegram errors expose only safe status codes, never token-bearing server text', async t => {
  const server = createServer((req, res) => { res.writeHead(401); res.end(JSON.stringify({ ok: false, error_code: 401, description: 'top-secret' })); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const tg = new Telegram('test-token', [], `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await assert.rejects(tg.call('getMe'), e => e instanceof TelegramError && e.code === 401 && !e.message.includes('top-secret'));
});

test('transport failures expose only a fixed network category, never a token URL', async t => {
  const server = createServer(req => req.socket.destroy());
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const tg = new Telegram('private-test-token', [], `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await assert.rejects(tg.call('getMe'), e => e instanceof TelegramError && e.code === 0
    && ['UND_ERR_SOCKET', 'ECONNRESET', 'NETWORK'].includes(e.networkCode ?? '')
    && !JSON.stringify(e).includes('private-test-token'));
});

test('Telegram transport explicitly resolves IPv4 on a host without an IPv6 route', async t => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ ok: true, result: true })));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  let family: unknown;
  const dispatcher = createTelegramDispatcher((_host, options, callback) => {
    family = options.family;
    if (options.family !== 4) return callback(Object.assign(new Error('No IPv6 route'), { code: 'ENETUNREACH' }), '', 0);
    callback(null, '127.0.0.1', 4);
  });
  t.after(() => dispatcher.close());
  const tg = new Telegram('test-token', [], `http://telegram-network.test:${(server.address() as { port: number }).port}`, dispatcher);
  assert.equal(await tg.call('getMe'), true);
  assert.equal(family, 4);
});

test('IPv4 transport preserves document upload and file download payloads', async t => {
  const uploaded: string[] = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    if (req.url!.endsWith('sendDocument')) {
      assert.match(req.headers['content-type']!, /multipart\/form-data/);
      uploaded.push(data);
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    } else if (req.url!.endsWith('getFile')) {
      res.end(JSON.stringify({ ok: true, result: { file_path: 'documents/sample.txt', file_size: 8 } }));
    } else res.end('contents');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const tg = new Telegram('test-token', [], `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await tg.sendFile(123, 'sample.txt', Buffer.from('contents'));
  assert.match(uploaded[0], /sample\.txt/);
  assert.match(uploaded[0], /contents/);
  assert.equal((await tg.download('file-id')).toString(), 'contents');
});
