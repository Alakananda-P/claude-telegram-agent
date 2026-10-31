import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Telegram, TelegramError } from '../src/telegram.js';

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

test('Telegram errors expose only safe status codes, never token-bearing server text', async t => {
  const server = createServer((req, res) => { res.writeHead(401); res.end(JSON.stringify({ ok: false, error_code: 401, description: 'top-secret' })); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const tg = new Telegram('test-token', [], `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await assert.rejects(tg.call('getMe'), e => e instanceof TelegramError && e.code === 401 && !e.message.includes('top-secret'));
});
