import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Telegram, createTelegramDispatcher } from '../src/telegram.js';
import { StateStore } from '../src/state.js';
import { HOME } from '../src/ui.js';
import { Controller } from '../src/controller.js';
import { loadConfig } from '../src/config.js';

async function setup(t: test.TestContext) {
  const requests: { method: string; body: any }[] = []; let sequence = 100;
  let failDeletion = false;
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const method = req.url!.split('/').at(-1)!;
    const body = req.headers['content-type']?.includes('json') ? JSON.parse(data) : {};
    requests.push({ method, body });
    if (method === 'getFile') { res.end(JSON.stringify({ ok: true, result: { file_path: 'fixture.jpg' } })); return; }
    if (method === 'fixture.jpg') { res.end('original-upload'); return; }
    if (method === 'deleteMessage' && failDeletion) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error_code: 500 })); return; }
    res.end(JSON.stringify({ ok: true, result: method.startsWith('send') ? { message_id: ++sequence } : true }));
  });
  const dispatcher = createTelegramDispatcher();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await dispatcher.destroy(); server.closeAllConnections(); server.close(); });
  const store = await StateStore.open(path.join(await mkdtemp(path.join(tmpdir(), 'tg-cleanup-')), 'state.json'));
  const tg = new Telegram('test-token', [], `http://127.0.0.1:${(server.address() as { port: number }).port}`, dispatcher); tg.timeline = store;
  return { tg, store, requests, fail: (value: boolean) => { failDeletion = value; } };
}
test('idle cleanup deletes only marked UI and keeps conversation messages and delivered files', async t => {
  const { tg, store, requests } = await setup(t);
  await tg.send(123, 'Permanent answer');
  await tg.panel(123, 'Menu', HOME);
  await tg.notice(123, 'Queued', 'task-one');
  await tg.sendFile(123, 'result.txt', Buffer.from('Finished work'));
  store.data.visibleMessageIds!.push(99); // owner chat message, never a UI record
  const expiry = Math.max(...store.data.uiMessages!.map(m => m.expiresAt));
  await tg.cleanup(123, expiry + 1);
  assert.deepEqual(requests.filter(r => r.method === 'deleteMessage').map(r => r.body.message_id).sort(), [102, 103]);
  assert.deepEqual(store.data.visibleMessageIds!.sort(), [101, 104, 99].sort());
});

const ownerMessage = (text: string) => ({ chat: { id: 123, type: 'private' }, from: { id: 123 }, text });
const uploadPhoto = (id: string, group?: string) => ({ ...ownerMessage(''), media_group_id: group, photo: [{ file_id: id, width: 100, height: 100 }] });
const uploadVideo = (id: string) => ({ ...ownerMessage(''), video: { file_id: id, file_name: 'clip.mp4', width: 320, height: 240, duration: 1 } });
function photoController(store: StateStore, tg: Telegram, prompts: string[] = []) {
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: path.dirname(store.file) });
  return new Controller(config, store, tg, { async run(request, emit) {
    prompts.push(request.prompt); await emit({ type: 'session', id: 'photo-session' });
    return { text: 'Photo report complete', session: 'photo-session', cumulativeCost: 0 };
  } });
}

test('video receipt persists across restart, updates mixed counts and clears when the prompt is submitted', async t => {
  const { tg, store, requests } = await setup(t); const prompts: string[] = [];
  const original = photoController(store, tg, prompts); t.after(() => original.stop());
  await original.handle(uploadVideo('first-video')); await original.handle(uploadPhoto('image'));
  assert.equal(prompts.length, 0); assert.equal(store.data.uiMessages!.length, 1);
  const receiptId = store.data.uiMessages![0].id;
  const reopened = await StateStore.open(store.file); tg.timeline = reopened;
  const bot = photoController(reopened, tg, prompts); t.after(() => bot.stop());
  await bot.handle(uploadVideo('second-video'));
  await bot.handle({ ...ownerMessage(''), document: { file_id: 'video-as-file', file_name: 'third.MOV' } });
  const receipt = requests.findLast(r => r.method === 'editMessageText' && r.body.message_id === receiptId)!;
  assert.match(receipt.body.text, /1 image.*3 videos.*received/); assert.deepEqual(receipt.body.reply_markup.inline_keyboard, []);
  assert.equal(reopened.data.uiMessages!.length, 1); assert.equal(prompts.length, 0);
  await bot.handle(ownerMessage('Summarize all clips')); await bot.idle();
  assert.equal(prompts.length, 1); assert.equal((prompts[0].match(/uploads\//g) ?? []).length, 4);
  assert.ok(requests.some(r => r.method === 'deleteMessage' && r.body.message_id === receiptId));
});

test('photo and album receipts update one buttonless count and wait for instructions before submitting files', async t => {
  const { tg, store, requests } = await setup(t); const prompts: string[] = [];
  const bot = photoController(store, tg, prompts); t.after(() => bot.stop());
  await bot.handle(uploadPhoto('one')); await bot.handle(uploadPhoto('two'));
  await bot.handle(uploadPhoto('three', 'album')); await bot.handle(uploadPhoto('four', 'album'));
  await bot.handle({ ...ownerMessage(''), document: { file_id: 'five', file_name: 'bill.png' } });
  await bot.handle({ ...ownerMessage(''), document: { file_id: 'six', file_name: 'invoice.pdf' } });
  assert.equal(prompts.length, 0); assert.equal(store.data.tasks!.length, 0);
  assert.equal(store.data.uiMessages!.length, 1, 'all pending uploads share a receipt');
  const receipt = store.data.uiMessages![0];
  const edits = requests.filter(r => r.method === 'editMessageText' && r.body.message_id === receipt.id);
  assert.equal(edits.length, 5, 'each additional file updates the existing count');
  assert.match(edits.at(-1)!.body.text, /5 images.*1 file.*received/i);
  assert.deepEqual(edits.at(-1)!.body.reply_markup.inline_keyboard, []);
  assert.ok(!requests.some(r => r.method === 'sendMessage' && r.body.reply_markup?.inline_keyboard?.length));
  for (const upload of store.data.uploads!) assert.equal(await readFile(path.join(path.dirname(store.file), 'workspaces', 'default', upload.path), 'utf8'), 'original-upload');
  await bot.handle(ownerMessage('Make a bill table')); await bot.idle();
  assert.equal(prompts.length, 1); assert.match(prompts[0], /Make a bill table/);
  assert.equal((prompts[0].match(/uploads\//g) ?? []).length, 6);
  assert.ok(requests.some(r => r.method === 'deleteMessage' && r.body.message_id === receipt.id));
  assert.ok(requests.some(r => r.method === 'sendMessage' && r.body.text === 'Photo report complete'));
});

test('photo counts survive restarts and idle receipt expiry without forgetting pending uploads', async t => {
  const { tg, store, requests } = await setup(t); let bot = photoController(store, tg);
  await bot.handle(uploadPhoto('one')); await bot.handle(uploadPhoto('two')); await bot.stop();
  const receipt = store.data.uiMessages![0]; const reopened = await StateStore.open(store.file);
  tg.timeline = reopened; bot = photoController(reopened, tg); t.after(() => bot.stop());
  await bot.handle(uploadPhoto('three'));
  assert.equal(reopened.data.uiMessages!.length, 1); assert.equal(reopened.data.uiMessages![0].id, receipt.id);
  assert.match(requests.findLast(r => r.method === 'editMessageText')!.body.text, /3 images received/i);
  await tg.cleanup(123, Date.now() + 310000);
  assert.equal(reopened.data.uiMessages!.length, 0); assert.equal(reopened.data.tasks!.length, 0);
  await bot.handle(uploadPhoto('four'));
  assert.match(requests.findLast(r => r.method === 'sendMessage')!.body.text, /4 images received/i);
  assert.notEqual(reopened.data.uiMessages![0].id, receipt.id);
});

test('discard and partial processing refresh the pending photo total without consuming another batch', async t => {
  const { tg, store, requests } = await setup(t); const prompts: string[] = [];
  const bot = photoController(store, tg, prompts); t.after(() => bot.stop());
  await bot.handle(uploadPhoto('one')); await bot.handle(uploadPhoto('two', 'album')); await bot.handle(uploadPhoto('three', 'other-album'));
  const [single, album] = store.data.batches!; const receipt = store.data.uiMessages![0];
  await bot.callback({ id: 'discard', from: { id: 123 }, message: { ...ownerMessage(''), message_id: 77 }, data: 'discard ' + single.id });
  assert.match(requests.findLast(r => r.method === 'editMessageText' && r.body.message_id === receipt.id)!.body.text, /2 images received/i);
  await bot.handle(ownerMessage('/process ' + album.id)); await bot.idle();
  assert.equal(prompts.length, 1); assert.equal((prompts[0].match(/uploads\//g) ?? []).length, 1);
  assert.match(requests.findLast(r => r.method === 'editMessageText' && r.body.message_id === receipt.id)!.body.text, /1 image received/i);
  await bot.handle(ownerMessage('Use the last photo')); await bot.idle();
  assert.equal(prompts.length, 2); assert.equal((prompts[1].match(/uploads\//g) ?? []).length, 1);
  assert.ok(requests.some(r => r.method === 'deleteMessage' && r.body.message_id === receipt.id));
});

test('switching projects hides the previous photo count and counts only the selected project', async t => {
  const { tg, store, requests } = await setup(t); const bot = photoController(store, tg); t.after(() => bot.stop());
  await bot.handle(uploadPhoto('one')); await bot.handle(uploadPhoto('two')); const receipt = store.data.uiMessages![0];
  await bot.handle(ownerMessage('/project second'));
  assert.ok(requests.some(r => r.method === 'deleteMessage' && r.body.message_id === receipt.id));
  await bot.handle(uploadPhoto('three'));
  assert.match(requests.findLast(r => r.method === 'sendMessage')!.body.text, /1 image received/i);
  assert.equal(store.data.tasks!.length, 0); assert.equal(store.data.uploads!.length, 3);
});

test('explicit batch controls can process photos already waiting across separate albums', async t => {
  const { tg, store, requests } = await setup(t); const prompts: string[] = [];
  const bot = photoController(store, tg, prompts); t.after(() => bot.stop());
  await bot.handle(uploadPhoto('one', 'first')); await bot.handle(uploadPhoto('two', 'second'));
  await bot.handle(ownerMessage('/batch'));
  const controls = requests.findLast(r => r.method === 'sendMessage')!.body;
  assert.match(controls.text, /2 files/);
  const action = controls.reply_markup.inline_keyboard[0][0].callback_data;
  await bot.callback({ id: 'process', from: { id: 123 }, message: { ...ownerMessage(''), message_id: store.data.uiMessages!.at(-1)!.id }, data: action }); await bot.idle();
  assert.equal(prompts.length, 1); assert.equal((prompts[0].match(/uploads\//g) ?? []).length, 2);
  assert.ok(store.data.batches!.every(b => b.status === 'queued'));
});
test('navigation reuses a panel, refreshes inactivity and adopts an old clicked panel', async t => {
  const { tg, store, requests } = await setup(t);
  await tg.panel(123, 'Menu', HOME);
  store.data.uiMessages![0].expiresAt = Date.now() - 1;
  await tg.panel(123, 'Trash', HOME);
  assert.equal(requests.filter(r => r.method === 'sendMessage').length, 1);
  assert.equal(requests.find(r => r.method === 'editMessageText')!.body.message_id, 101);
  assert.ok(store.data.uiMessages![0].expiresAt > Date.now());
  await tg.panel(123, 'Older panel clicked', HOME, 55);
  assert.ok(requests.some(r => r.method === 'deleteMessage' && r.body.message_id === 101));
  assert.deepEqual(store.data.uiMessages!.map(m => m.id), [55]);
});
test('completed work dismisses only its related notices and respects a short reading delay', async t => {
  const { tg, store, requests } = await setup(t);
  await tg.notice(123, 'First queued', 'task-one'); await tg.notice(123, 'Second queued', 'task-two');
  await tg.dismiss(123, 'task-one', 2000);
  assert.equal(requests.filter(r => r.method === 'deleteMessage').length, 0);
  const due = store.data.uiMessages!.find(m => m.scope === 'task-one')!.expiresAt;
  await tg.cleanup(123, due + 1);
  assert.deepEqual(requests.filter(r => r.method === 'deleteMessage').map(r => r.body.message_id), [101]);
  assert.equal(store.data.uiMessages![0].scope, 'task-two');
});
test('cleanup survives restart and retries failed deletion without dropping its record', async t => {
  const { tg, store, requests, fail } = await setup(t);
  await tg.notice(123, 'Old notice', 'task-one');
  tg.timeline = await StateStore.open(store.file);
  const due = tg.timeline.data.uiMessages![0].expiresAt + 1; fail(true);
  await tg.cleanup(123, due); assert.equal(tg.timeline.data.uiMessages!.length, 1);
  assert.ok(tg.timeline.data.uiMessages![0].retryAt! > due);
  fail(false); await tg.cleanup(123, due + 120000);
  assert.equal(tg.timeline.data.uiMessages!.length, 0);
  assert.equal(requests.filter(r => r.method === 'deleteMessage').length, 2);
});

test('controller clears queued notices after work, expires completed Trash UI and retains the final answer', async t => {
  const { tg, store, requests } = await setup(t);
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: path.dirname(store.file) });
  const bot = new Controller(config, store, tg, { async run(_r, emit) { await emit({ type: 'session', id: 'test-session' }); return { text: 'Permanent completed report', session: 'test-session', cumulativeCost: 0 }; } });
  const handle = (text: string) => bot.handle({ chat: { id: 123, type: 'private' }, from: { id: 123 }, text });
  await handle('/menu'); store.data.queuePaused = true;
  await handle('Prepare the report');
  assert.ok(store.data.uiMessages!.some(m => m.scope === 'task-' + store.data.tasks![0].id));
  const queuedIds = store.data.uiMessages!.filter(m => m.kind === 'notice').map(m => m.id);
  await handle('/queue resume'); await bot.idle();
  assert.ok(queuedIds.every(id => requests.some(r => r.method === 'deleteMessage' && r.body.message_id === id)));
  assert.ok(requests.some(r => r.method === 'sendMessage' && r.body.text === 'Permanent completed report'));
  await handle('/delete test-session'); await handle('/trashmove test-session');
  const trash = store.data.uiMessages!.find(m => m.scope === 'controls')!;
  assert.ok(trash.expiresAt < Date.now() + 10000);
  await tg.cleanup(123, Date.now() + 310000);
  const finalRequest = requests.findIndex(r => r.method === 'sendMessage' && r.body.text === 'Permanent completed report');
  assert.ok(finalRequest >= 0);
  assert.equal(store.data.uiMessages!.length, 0);
  assert.ok(store.data.visibleMessageIds!.length >= 1);
  await bot.stop();
});

test('independent confirmation panels stay separate and a discarded batch closes only its own panel', async t => {
  const { tg, store, requests } = await setup(t);
  await tg.panel(123, 'Confirm first deletion', HOME, undefined, 'session-delete-one');
  await tg.panel(123, 'Confirm second deletion', HOME, undefined, 'session-delete-two');
  assert.equal(requests.filter(r => r.method === 'sendMessage').length, 2);
  await tg.dismiss(123, 'session-delete-one');
  assert.deepEqual(store.data.uiMessages!.map(m => m.scope), ['session-delete-two']);
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: path.dirname(store.file) });
  const bot = new Controller(config, store, tg, { async run() { throw new Error('No model should run'); } });
  const handle = (text: string) => bot.handle({ chat: { id: 123, type: 'private' }, from: { id: 123 }, text });
  await handle('/batch'); const batch = store.data.batches![0];
  const panel = store.data.uiMessages!.find(m => m.scope === 'batch-' + batch.id)!; assert.ok(panel);
  await handle('/discard ' + batch.id);
  assert.ok(requests.some(r => r.method === 'deleteMessage' && r.body.message_id === panel.id));
  assert.ok(store.data.uiMessages!.some(m => m.scope === 'session-delete-two'));
  await bot.stop();
});
