import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Telegram, TelegramCallError, telegramCallPayload } from '../src/telegram.js';
import { Controller } from '../src/controller.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { Automation } from '../src/automation.js';
import { workspaceServer, reactionIds, AUTO_WORKSPACE_TOOL_NAMES } from '../src/workspace-tools.js';
import { LiveSteerResponder } from '../src/live-steer.js';
import type { QueryFactory } from '../src/agent.js';

async function fakeTelegram(t: test.TestContext) {
  const received: { method: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const part of req) data += part;
    const method = req.url!.split('/').at(-1)!; received.push({ method, body: data });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: 7, chat: { id: 123 } } : true }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  return { received, tg: new Telegram('4242:test-token', ['top-secret'], `http://127.0.0.1:${(server.address() as { port: number }).port}`) };
}

test('telegram_call refuses methods outside the allowlist and other-chat routing before any request', async t => {
  const { tg, received } = await fakeTelegram(t);
  for (const method of ['getUpdates', 'setWebhook', 'deleteWebhook', 'logOut', 'close', 'banChatMember', 'restrictChatMember', 'promoteChatMember', 'sendInvoice', 'sendGift', 'setMyName', 'setMyDescription', 'setMyProfilePhoto', 'sendmessage'])
    await assert.rejects(tg.ownerCall(123, method, {}), (e: unknown) => e instanceof TelegramCallError && e.message.includes(`"${method}" is not allowed`));
  await assert.rejects(tg.ownerCall(123, 'editMessageText', { inline_message_id: 'x', text: 'a' }), /inline_message_id/);
  await assert.rejects(tg.ownerCall(123, 'sendMessage', { text: 'a', business_connection_id: 'b' }), /business_connection_id/);
  await assert.rejects(tg.ownerCall(123, 'sendMessage', { text: 'a', reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'upgradeapprove 1' }]] } }), /reserved for the bot/);
  await assert.rejects(tg.ownerCall(123, 'sendMessage', { text: 'a', reply_markup: { keyboard: [[{ text: 'Share', request_contact: true }]] } }), /reserved for the bot/);
  await assert.rejects(tg.ownerCall(123, 'getUserProfilePhotos', { user_id: 555 }), /owner and this bot/);
  assert.equal(received.length, 0);
});

test('telegram_call forces the owner chat, redacts visible text and uploads attach:// files as multipart', async t => {
  const { tg, received } = await fakeTelegram(t);
  await tg.ownerCall(123, 'sendMessage', { chat_id: 999, text: 'key top-secret and sk-ant-abcdefghijklmnop', reply_parameters: { message_id: 3, chat_id: 5 }, reply_markup: { inline_keyboard: [[{ text: 'Docs', url: 'https://example.com' }]] } });
  const sent = JSON.parse(received[0].body);
  assert.equal(sent.chat_id, 123); assert.equal(sent.reply_parameters.chat_id, 123);
  assert.ok(!sent.text.includes('top-secret') && !sent.text.includes('sk-ant-')); assert.match(sent.text, /\[REDACTED\]/);
  await tg.ownerCall(123, 'forwardMessage', { chat_id: -100, from_chat_id: -200, message_id: 4 });
  assert.deepEqual(JSON.parse(received[1].body), { chat_id: 123, from_chat_id: 123, message_id: 4 });
  await tg.ownerCall(123, 'sendPoll', { question: 'Use top-secret?', options: [{ text: '4242:test-token' }, { text: 'no' }] });
  assert.ok(!received[2].body.includes('top-secret') && !received[2].body.includes('test-token'));
  await tg.ownerCall(123, 'setMyCommands', { commands: [{ command: 'go', description: 'Go' }], scope: { type: 'default' } });
  assert.deepEqual(JSON.parse(received[3].body).scope, { type: 'chat', chat_id: 123 });
  await tg.ownerCall(123, 'getUserProfilePhotos', { user_id: 4242 }); await tg.ownerCall(123, 'getMe');
  assert.deepEqual(JSON.parse(received[5].body), {});
  await tg.ownerCall(123, 'sendDocument', { chat_id: 1, document: 'attach://doc', caption: 'see top-secret' }, [{ name: 'doc', filename: 'report.pdf', bytes: Buffer.from('pdf') }]);
  assert.match(received[6].body, /name="document"; filename="report.pdf"/); assert.match(received[6].body, /name="chat_id"\r\n\r\n123\r\n/); assert.ok(!received[6].body.includes('top-secret'));
  await tg.ownerCall(123, 'sendMediaGroup', { media: [{ type: 'photo', media: 'attach://a' }, { type: 'photo', media: 'attach://b' }] }, [{ name: 'a', filename: 'a.jpg', bytes: Buffer.from('a') }, { name: 'b', filename: 'b.jpg', bytes: Buffer.from('b') }]);
  assert.match(received[7].body, /attach:\/\/a/); assert.match(received[7].body, /name="a"; filename="a.jpg"/); assert.match(received[7].body, /name="b"; filename="b.jpg"/);
  await assert.rejects(tg.ownerCall(123, 'sendDocument', { document: 'attach://doc' }, [{ name: 'doc', filename: 'x.txt', bytes: Buffer.from('has top-secret') }]), /secret/);
});

async function controller(react?: (chat: number, id: number, emoji?: string | null) => Promise<void>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-call-'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dataDir });
  const store = await StateStore.open(path.join(dataDir, 'bot', 'state.json'));
  const calls: { method: string; params: Record<string, unknown>; files: { name: string; filename: string }[] }[] = [];
  const sender = { async send() {}, async temporary() { return 1; }, async edit() {}, async remove() {}, async typing() {}, async sendFile() {}, async download() { return Buffer.from('photo-bytes'); }, react,
    async ownerCall(_o: number, method: string, params: Record<string, unknown> = {}, files: { name: string; filename: string }[] = []) { calls.push({ method, params, files }); return method === 'getFile' ? { file_id: 'F1', file_path: 'photos/file_9.jpg', file_size: 11 } : { message_id: 9, text: 'x'.repeat(7000) }; } };
  const bot = new Controller(config, store, sender, { async run() { return { text: '', session: 's', cumulativeCost: 0 }; } });
  const root = path.join(dataDir, 'proj'); await mkdir(path.join(root, '.secrets'), { recursive: true });
  await writeFile(path.join(root, '.secrets', 'key.txt'), 'k'); await writeFile(path.join(root, 'ok.txt'), 'fine');
  return { bot, root, calls };
}

test('telegram_call files use the deliver_file gate; getFile saves into uploads/; results are bounded', async () => {
  const { bot, root, calls } = await controller();
  for (const file of ['.secrets/key.txt', '../ok.txt', '/etc/passwd', 'missing.txt'])
    await assert.rejects(bot.telegramCall(root, { method: 'sendDocument', params: { document: 'attach://f' }, files: { f: file } }), /not allowed|not found|outside/);
  assert.equal(calls.length, 0);
  const sent = await bot.telegramCall(root, { method: 'sendDocument', params: { document: 'attach://f' }, files: { f: 'ok.txt' } }) as { truncated?: boolean; result: string };
  assert.deepEqual(calls[0].files.map(f => [f.name, f.filename]), [['f', 'ok.txt']]); assert.equal(sent.truncated, true); assert.ok(sent.result.length <= 6000);
  const got = await bot.telegramCall(root, { method: 'getFile', params: { file_id: 'F1' } }) as { result: { saved: string } };
  assert.match(got.result.saved, /^uploads\/[0-9a-f-]+-file_9\.jpg$/); assert.equal(await readFile(path.join(root, got.result.saved), 'utf8'), 'photo-bytes');
});

test('clear_reactions expands ranges within 300 ids and tolerates per-message errors', async () => {
  assert.deepEqual(reactionIds({ message_ids: [11, 50], from_id: 10, to_id: 12 }), [11, 50, 10, 12]);
  assert.deepEqual(reactionIds({ from_id: 1, to_id: 300 }).length, 300);
  assert.throws(() => reactionIds({ from_id: 1, to_id: 301 }), /300/);
  assert.throws(() => reactionIds({ from_id: 5 }), /both/); assert.throws(() => reactionIds({ from_id: 5, to_id: 4 }), /at least/); assert.throws(() => reactionIds({}), /message_ids/);
  assert.throws(() => reactionIds({ message_ids: Array.from({ length: 200 }, (_, i) => i + 1000), from_id: 1, to_id: 200 }), /300/);
  const cleared: [number, number, string | null | undefined][] = [];
  const { bot } = await controller(async (chat, id, emoji) => { if (id % 2) throw new Error('too old'); cleared.push([chat, id, emoji]); });
  assert.deepEqual(await bot.clearReactions([1, 2, 3, 4]), { cleared: 2, failed: 2 });
  assert.deepEqual(cleared, [[123, 2, null], [123, 4, null]]);
});

test('workspace MCP exposes telegram_call and clear_reactions, auto-allowed, with readable refusals', async () => {
  assert.ok(AUTO_WORKSPACE_TOOL_NAMES.includes('mcp__workspace__telegram_call') && AUTO_WORKSPACE_TOOL_NAMES.includes('mcp__workspace__clear_reactions'));
  const root = await mkdtemp(path.join(tmpdir(), 'tg-call-mcp-')), store = await StateStore.open(path.join(root, 'state.json'));
  const cleared: number[][] = [];
  const server = workspaceServer({ root, project: 'default', automation: new Automation(store), deliver: async () => {}, backup: async () => {}, secrets: ['top-secret'],
    telegramApi: { call: async a => telegramCallPayload(a.method, a.params ?? {}, 123, 4242, ['top-secret']), clearReactions: async ids => { cleared.push(ids); return { cleared: ids.length, failed: 0 }; } } });
  const client = new Client({ name: 'tg-call', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(b); await client.connect(a);
    const listed = await client.listTools();
    assert.match(listed.tools.find(t => t.name === 'telegram_call')!.description!, /OWNER CHAT ONLY.*set_bot_profile/s);
    const refused = await client.callTool({ name: 'telegram_call', arguments: { method: 'getUpdates' } });
    assert.equal(refused.isError, true); assert.match(JSON.stringify(refused.content), /not allowed/);
    const ok = await client.callTool({ name: 'telegram_call', arguments: { method: 'sendMessage', params: { chat_id: 1, text: 'hi top-secret' } } });
    assert.match(JSON.stringify(ok.content), /\\"chat_id\\":123/); assert.ok(!JSON.stringify(ok.content).includes('top-secret'));
    const range = await client.callTool({ name: 'clear_reactions', arguments: { from_id: 5, to_id: 7 } });
    assert.match(JSON.stringify(range.content), /\\"cleared\\":3/); assert.deepEqual(cleared, [[5, 6, 7]]);
    assert.equal((await client.callTool({ name: 'clear_reactions', arguments: { from_id: 1, to_id: 400 } })).isError, true);
  } finally { await client.close(); await server.instance.close(); }
});

test('the live reply prompt forbids promising actions or capabilities and inventing details', async () => {
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: await mkdtemp(path.join(tmpdir(), 'tg-live-rule-')) });
  let prompt = '', options!: Options;
  const factory: QueryFactory = ({ prompt: p, options: o }) => { prompt = String(p); options = o!; return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'f', uuid: 'u', total_cost_usd: 0, modelUsage: {} } as unknown as SDKMessage; }, close() {} } as never; };
  await new LiveSteerResponder(config, undefined, factory).reply({ session: 's', cwd: config.dataDir, model: 'm', text: 'can you send me a poll?' }, new AbortController().signal);
  for (const text of [prompt, JSON.stringify(options.systemPrompt)]) {
    assert.match(text, /Never promise actions, tools or capabilities/); assert.match(text, /the running task will check and reply/); assert.match(text, /Do not invent details/);
  }
  assert.match(prompt, /can you send me a poll\?$/);
});
