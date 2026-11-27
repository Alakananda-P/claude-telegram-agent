import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Telegram, type ProfileChange } from '../src/telegram.js';
import { Controller } from '../src/controller.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import type { Buttons } from '../src/ui.js';

async function fakeTelegram(t: test.TestContext) {
  const received: { method: string; body: string }[] = [];
  const results: Record<string, unknown> = { getMe: { id: 42, first_name: 'Myra', username: 'myra_bot' }, getMyName: { name: 'Myra' }, getMyDescription: { description: 'Helper' }, getMyShortDescription: { short_description: 'Short' }, getUserProfilePhotos: { total_count: 2, photos: [] } };
  const server = createServer(async (req, res) => {
    let data = ''; for await (const part of req) data += part;
    const method = req.url!.split('/').at(-1)!; received.push({ method, body: data });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: results[method] ?? true }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  return { received, tg: new Telegram('test-token', ['top-secret'], `http://127.0.0.1:${(server.address() as { port: number }).port}`) };
}

test('bot profile reads name, descriptions and photo count from the Bot API', async t => {
  const { tg, received } = await fakeTelegram(t);
  assert.deepEqual(await tg.botProfile(), { id: 42, username: 'myra_bot', name: 'Myra', description: 'Helper', shortDescription: 'Short', photoCount: 2 });
  assert.deepEqual(JSON.parse(received.find(r => r.method === 'getUserProfilePhotos')!.body), { user_id: 42, limit: 1 });
});

test('profile setters validate lengths and upload JPG/MP4 as static/animated profile photos', async t => {
  const { tg, received } = await fakeTelegram(t);
  await assert.rejects(tg.setMyName('x'.repeat(65)), /64/);
  await assert.rejects(tg.setMyShortDescription('x'.repeat(121)), /120/);
  await assert.rejects(tg.setMyDescription('x'.repeat(513)), /512/);
  await assert.rejects(tg.setMyProfilePhoto('a.png', new Uint8Array([1])), /jpg/);
  await assert.rejects(tg.setMyProfilePhoto('a.jpg', Buffer.from('xx top-secret')), /secret/);
  assert.equal(received.length, 0);
  const done = await tg.applyProfile({ name: 'Myra', shortDescription: '', photo: { name: 'me.JPG', bytes: Buffer.from('jpeg') } });
  assert.deepEqual(done, ['name', 'short description', 'photo']);
  assert.deepEqual(JSON.parse(received[0].body), { name: 'Myra' });
  const upload = received.find(r => r.method === 'setMyProfilePhoto')!.body;
  assert.match(upload, /"type":"static","photo":"attach:\/\/file"/); assert.match(upload, /name="file"; filename="profile.jpg"/);
  await tg.setMyProfilePhoto('loop.mp4', Buffer.from('mp4'));
  assert.match(received.at(-1)!.body, /"type":"animated","animation":"attach:\/\/file"/);
  await tg.removeMyProfilePhoto(); assert.equal(received.at(-1)!.method, 'removeMyProfilePhoto');
});

test('set_bot_profile applies only after the owner taps Approve', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-agent-profile-'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dataDir });
  const store = await StateStore.open(path.join(dataDir, 'bot', 'state.json'));
  const replies: string[] = [], panels: { text: string; buttons: Buttons }[] = [], applied: ProfileChange[] = [];
  const sender = { async send(_c: number, text: string) { replies.push(text); }, async temporary() { return 1; }, async edit() {}, async remove() {}, async typing() {},
    async panel(_c: number, text: string, buttons: Buttons) { panels.push({ text, buttons }); }, async sendFile() {}, async download() { return Buffer.from(''); },
    async botProfile() { return { id: 1, name: 'A', description: '', shortDescription: '', photoCount: 0 }; }, async applyProfile(change: ProfileChange) { applied.push(change); return ['name']; } };
  const bot = new Controller(config, store, sender, { async run() { return { text: '', session: 's', cumulativeCost: 0 }; } });
  const root = path.join(dataDir, 'proj'); await mkdir(root); await writeFile(path.join(root, 'me.jpg'), 'jpeg');
  await assert.rejects(bot.requestProfileChange(root, { photo_file: 'me.png' }), /jpg/);
  await assert.rejects(bot.requestProfileChange(root, { photo_file: '../me.jpg' }), /not allowed/);
  await assert.rejects(bot.requestProfileChange(root, {}), /at least one/);
  const first = await bot.requestProfileChange(root, { name: 'Myra', photo_file: 'me.jpg' });
  assert.match(panels.at(-1)!.text, /Name: Myra[\s\S]*me\.jpg/); assert.equal(applied.length, 0);
  const callback = (data: string) => bot.callback({ id: 'cb', from: { id: 123 }, message: { from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '', message_id: 5 }, data });
  await callback('profileno ' + first.id); assert.equal(applied.length, 0); assert.match(replies.at(-1)!, /cancelled/);
  const second = await bot.requestProfileChange(root, { name: 'Myra', photo_file: 'me.jpg' });
  assert.deepEqual(panels.at(-1)!.buttons[0].map(b => b.callback_data), ['profileok ' + second.id, 'profileno ' + second.id]);
  await callback('profileok ' + second.id);
  assert.equal(applied.length, 1); assert.equal(applied[0].name, 'Myra'); assert.equal(Buffer.from(applied[0].photo!.bytes).toString(), 'jpeg');
  await callback('profileok ' + second.id); assert.equal(applied.length, 1);
});
