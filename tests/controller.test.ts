import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller } from '../src/controller.js';
import type { Runner, AgentRequest } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import type { Message } from '../src/safety.js';
import type { Buttons } from '../src/ui.js';

const message = (text: string): Message => ({ from: { id: 123 }, chat: { id: 123, type: 'private' }, text });
const photo = (id: string, group?: string): Message => ({ ...message(''), media_group_id: group, photo: [{ file_id: id + '-small', width: 100, height: 100 }, { file_id: id + '-large', width: 1200, height: 900 }] });
const video = (id: string, group?: string): Message => ({ ...message(''), media_group_id: group, video: { file_id: id, width: 640, height: 360, duration: 2, file_size: 8, thumbnail: { file_id: id + '-thumb' } } } as Message);
async function setup(runner?: Runner) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-agent-controller-'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dataDir });
  const store = await StateStore.open(path.join(dataDir, 'bot', 'state.json'));
  const replies: string[] = [];
  const deleted: number[] = [];
  const indicators: string[] = [];
  const screens: string[][] = [];
  const panels: { text: string; buttons: Buttons; editId?: number }[] = [];
  const acknowledgements: string[] = [];
  const calls: AgentRequest[] = [];
  const downloads: string[] = []; const files: string[] = [];
  const sender = { async send(_chat: number, text: string) { replies.push(text); },
    async temporary(_chat: number, text: string) { indicators.push(text); return 99; },
    async edit(_chat: number, _id: number, text: string) { indicators.push(text); },
    async remove(_chat: number, id: number) { deleted.push(id); },
    async typing() {},
    async clear() { screens.push([...replies]); replies.length = 0; return true; },
    async panel(_chat: number, text: string, buttons: Buttons, editId?: number) { replies.push(text); panels.push({ text, buttons, editId }); },
    async acknowledge(id: string) { acknowledgements.push(id); },
    async sendFile(_chat: number, name: string, bytes: Uint8Array) { files.push(name); replies.push(Buffer.from(bytes).toString()); },
    async download(fileId: string) { downloads.push(fileId); return Buffer.from('uploaded'); } };
  const agent: Runner = runner ?? { async run(request, emit) {
    calls.push(request); await emit({ type: 'session', id: 'session-' + calls.length });
    return { text: 'Task complete', session: 'session-' + calls.length, cumulativeCost: 0.1 };
  } };
  return { bot: new Controller(config, store, sender, agent), store, replies, calls, config, dataDir, deleted, indicators, screens, panels, acknowledgements, downloads, files, sender };
}

test('unauthorized messages do not produce replies, uploads or jobs', async () => {
  const { bot, replies, calls } = await setup();
  await bot.handle({ ...message('do work'), from: { id: 666 } });
  await bot.handle({ ...message('/status'), chat: { id: -1, type: 'group' } });
  assert.deepEqual(replies, []); assert.deepEqual(calls, []);
});

test('key status menu and history callbacks are owner-only and never create model jobs', async () => {
  const { bot, panels, calls, store } = await setup();
  await bot.menu(); assert.ok(panels.at(-1)!.buttons.flat().some(b => b.callback_data === 'keys'));
  await bot.handle(message('/keys')); assert.match(panels.at(-1)!.text, /API key status/);
  const id = Object.keys(store.data.keyRecords!)[0];
  await bot.callback({ id: 'keyclick', from: { id: 123 }, message: { ...message(''), message_id: 55 }, data: `keyhistory ${id} 0` });
  assert.match(panels.at(-1)!.text, /History 1\/1/); assert.equal(panels.at(-1)!.editId, 55);
  const count = panels.length;
  await bot.callback({ id: 'intruder', from: { id: 666 }, message: { ...message(''), message_id: 55 }, data: 'keys' });
  assert.equal(panels.length, count); assert.equal(calls.length, 0);
});

test('largest direct photo is acknowledged and captionless upload attaches to the next task', async () => {
  const { bot, downloads, calls, indicators, panels, store } = await setup();
  await bot.handle(photo('bill')); assert.deepEqual(downloads, ['bill-large']); assert.equal(calls.length, 0);
  assert.ok(indicators.some(t => /Receiving photo/.test(t))); assert.match(panels.at(-1)!.text, /1 image received/); assert.deepEqual(panels.at(-1)!.buttons, []);
  await bot.handle(message('Make a bill table')); await bot.idle();
  assert.match(calls[0].prompt, /Make a bill table/); assert.match(calls[0].prompt, /uploads\/.+photo.jpg/); assert.equal(store.data.batches![0].status, 'queued');
});

test('direct video downloads the original, shows a receipt and waits for the next text prompt', async () => {
  const { bot, store, downloads, calls, indicators, panels, dataDir } = await setup();
  await bot.handle(video('clip'));
  assert.deepEqual(downloads, ['clip']); assert.equal(calls.length, 0);
  assert.ok(indicators.some(t => /Receiving video/.test(t)));
  assert.match(panels.at(-1)!.text, /1 video received/); assert.deepEqual(panels.at(-1)!.buttons, []);
  assert.equal(await readFile(path.join(dataDir, 'workspaces/default', store.data.uploads![0].path), 'utf8'), 'uploaded');
  await bot.handle(message('Summarize this clip')); await bot.idle();
  assert.equal(calls.length, 1); assert.match(calls[0].prompt, /uploads\/.+video\.mp4/);
});

test('video captions start work once and filenames stay inside uploads', async () => {
  const { bot, store, calls } = await setup();
  await bot.handle({ ...video('captioned'), video: { file_id: 'captioned', file_name: '../../clip.mp4' }, caption: 'Inspect this video' } as Message);
  await bot.idle(); assert.equal(calls.length, 1); assert.match(calls[0].prompt, /Inspect this video/);
  assert.match(store.data.uploads![0].path, /^uploads\/[a-zA-Z0-9-]+-clip\.mp4$/);
});

test('mixed photo/video album waits, keeps all originals and batches them once', async () => {
  const { bot, store, calls, panels } = await setup();
  await bot.handle({ ...video('clip-one', 'album'), caption: 'Compare these' });
  await bot.handle(photo('image', 'album')); await bot.handle(video('clip-two', 'album'));
  assert.equal(calls.length, 0); assert.equal(store.data.batches!.length, 1);
  assert.match(panels.at(-1)!.text, /1 image.*2 videos.*received/);
  await bot.handle(message('/process')); await bot.idle();
  assert.equal(calls.length, 1); assert.equal((calls[0].prompt.match(/uploads\//g) ?? []).length, 3);
});

test('round videos and animations are accepted without duplicate legacy document uploads', async () => {
  const { bot, downloads, store, panels, calls } = await setup();
  await bot.handle({ ...message(''), video_note: { file_id: 'round', length: 240, duration: 2 } } as Message);
  await bot.handle({ ...message(''), animation: { file_id: 'gif', mime_type: 'image/gif' }, document: { file_id: 'gif-legacy', file_name: 'duplicate.gif' } } as Message);
  assert.deepEqual(downloads, ['round', 'gif']); assert.equal(calls.length, 0);
  assert.equal(store.data.uploads![0].name, 'video-note.mp4'); assert.equal(store.data.uploads![1].name, 'animation.gif');
  assert.match(panels.at(-1)!.text, /1 video.*1 animation.*received/);
});

test('TypeScript documents remain files while explicit video MIME metadata is preserved', async () => {
  const { bot, panels, store } = await setup();
  await bot.handle({ ...message(''), document: { file_id: 'code', file_name: 'main.ts' } });
  await bot.handle({ ...message(''), document: { file_id: 'transport-video', file_name: 'clip.ts', mime_type: 'video/mp2t' } });
  assert.match(panels.at(-1)!.text, /1 video.*1 file.*received/);
  assert.equal(store.data.uploads![0].mediaType, undefined); assert.equal(store.data.uploads![1].mediaType, 'video');
});

test('oversized, failed and unauthorized videos never produce a false receipt or a model job', async () => {
  const { bot, sender, downloads, calls, store, replies, panels } = await setup();
  await bot.handle({ ...video('foreign'), from: { id: 999 } }); assert.equal(downloads.length, 0);
  await bot.handle({ ...video('oversized'), video: { file_id: 'oversized', file_size: 20_000_001 } } as Message);
  assert.match(replies.at(-1)!, /20 MB/); assert.equal(downloads.length, 0);
  sender.download = async () => { throw new Error('private-network-detail'); };
  await bot.handle(video('failed')); assert.match(replies.at(-1)!, /Upload could not be accepted/);
  assert.equal(store.data.uploads!.length, 0); assert.equal(panels.length, 0); assert.equal(calls.length, 0);
  assert.ok(!replies.join('').includes('private-network-detail'));
});
test('album waits for Process, preserves every photo and processes it once', async () => {
  const { bot, calls, store, panels } = await setup();
  await bot.handle({ ...photo('one', 'album-1'), caption: 'Read these bills' }); await bot.handle(photo('two', 'album-1')); await bot.handle(photo('three', 'album-1'));
  assert.equal(calls.length, 0); assert.equal(store.data.batches!.length, 1); assert.equal(store.data.batches![0].uploadIds.length, 3);
  assert.deepEqual(panels.at(-1)!.buttons, []);
  await bot.handle(message('/process')); await bot.idle();
  assert.equal(calls.length, 1); assert.equal((calls[0].prompt.match(/uploads\//g) ?? []).length, 3);
  await bot.handle(message('/process')); await bot.idle(); assert.equal(calls.length, 1);
});
test('download failure shows failure and creates no false upload or job', async () => {
  const { bot, sender, store, replies, calls } = await setup(); sender.download = async () => { throw new Error('private-network-detail'); };
  await bot.handle(photo('broken'));
  assert.equal(store.data.uploads!.length, 0); assert.equal(calls.length, 0); assert.match(replies.at(-1)!, /Upload could not be accepted/); assert.ok(!replies.join('').includes('private-network-detail'));
});
test('queued tasks run serially and resume the session created by the first task', async () => {
  let release!: () => void; let began!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; }); const calls: AgentRequest[] = [];
  const { bot, store } = await setup({ async run(r, emit) { calls.push(r); if (calls.length === 1) { began(); await wait; } await emit({ type: 'session', id: 'same-chat' }); return { session: 'same-chat', text: 'Done', cumulativeCost: 0 }; } });
  await bot.handle(message('First')); await ready; await bot.handle(message('Second')); assert.equal(calls.length, 1); assert.equal(store.data.tasks![1].status, 'queued');
  release(); await bot.idle(); assert.equal(calls.length, 2); assert.equal(calls[1].session, 'same-chat'); assert.ok(store.data.tasks!.every(t => t.status === 'completed'));
});
test('completed files send automatically and scheduled reminders work without a Claude call', async () => {
  const { bot, files, replies, store } = await setup({ async run(r, emit) { await emit({ type: 'session', id: 'artifact-chat' }); await mkdir(path.join(r.cwd, 'output')); await writeFile(path.join(r.cwd, 'output', 'bills.csv'), 'item,total\nMilk,50'); return { session: 'artifact-chat', text: 'Table ready', cumulativeCost: 0 }; } });
  await bot.handle(message('Create table')); await bot.idle(); assert.deepEqual(files, ['bills.csv']);
  const now = new Date('2030-01-01T00:00:00Z');
  await bot.automation.createSchedule({ name: 'Reminder', kind: 'reminder', prompt: 'Review total', project: 'default', at: '2030-01-01T00:01:00Z' }, now);
  await bot.tick(new Date('2030-01-01T00:01:01Z')); await bot.idle(); await bot.tick(new Date('2030-01-01T00:02:00Z')); await bot.idle();
  assert.equal(replies.filter(t => t.includes('Reminder\n\nReview total')).length, 1); assert.equal(store.data.sessions.default, 'artifact-chat');
});
test('session deletion waits for owner confirmation and restore keeps shared data', async () => {
  const { bot, store, panels } = await setup(); await bot.handle(message('Build report')); await bot.idle();
  const id = store.data.sessions.default;
  await bot.handle(message('/delete ' + id)); assert.equal(store.data.conversations![0].trashedAt, undefined); assert.ok(panels.at(-1)!.buttons.flat().some(b => b.callback_data === 'trashmove ' + id));
  await bot.handle(message('/trashmove ' + id)); assert.ok(store.data.conversations![0].trashedAt); assert.equal(store.data.sessions.default, undefined);
  await bot.handle(message('/session')); assert.match(panels.at(-1)!.text, /0 chats/);
  await bot.handle(message('/restore ' + id)); assert.equal(store.data.conversations![0].trashedAt, undefined); assert.equal(store.data.memoryEnabled, true);
});

test('active model can list, read and name chats; manual titles appear in session buttons', async () => {
  const runner: Runner = { async run(request, emit) {
    await emit({ type: 'session', id: 'chat-test' });
    assert.equal(request.sessions!.list().currentSession, 'chat-test');
    assert.equal(request.sessions!.list().total, 1);
    assert.equal((await request.sessions!.read('chat-test')).turns[0].text, 'Create a Tally import workbook');
    await request.sessions!.rename('chat-test', 'Tally workbook preparation');
    return { text: 'Done', session: 'chat-test', cumulativeCost: 0 };
  } };
  const { bot, panels, store } = await setup(runner);
  await bot.handle(message('Create a Tally import workbook')); await bot.idle();
  await bot.handle(message('/session'));
  assert.match(panels.at(-1)!.text, /Tally workbook preparation/);
  assert.ok(panels.at(-1)!.buttons.flat().some(b => b.text.includes('Tally workbook preparation')));
  await bot.handle(message('/rename October bill processing'));
  assert.equal(store.data.conversations![0].title, 'October bill processing');
  assert.equal(store.data.conversations![0].titleSource, 'manual');
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

test('busy task queues new work, blocks project changes, /status stays responsive and /stop pauses queue', async () => {
  let calls = 0;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const runner: Runner = { async run(_request, _emit, abort) {
    calls++;
    started();
    await new Promise<void>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(new Error('cancel')), { once: true }));
    throw new Error('unreachable');
  } };
  const { bot, replies, store } = await setup(runner);
  await bot.handle(message('first'));
  await ready;
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
  assert.equal(store.data.queuePaused, true);
  assert.equal(store.data.tasks!.filter(t => t.status === 'queued').length, 1);
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

test('model controls persist across restarts, validate choices, and reach each job', async () => {
  const { bot, calls, store, replies, dataDir } = await setup();
  await bot.handle(message('/model sonnet'));
  await bot.handle(message('/efforts medium'));
  await bot.handle(message('work')); await bot.idle();
  assert.equal(calls[0].settings?.model, 'claude-sonnet-5-5');
  assert.equal(calls[0].settings?.effort, 'medium');
  assert.equal(calls[0].settings?.fast, false);
  await bot.handle(message('/model opus'));
  await bot.handle(message('/efforts high'));
  await bot.handle(message('work')); await bot.idle();
  assert.equal(calls[1].settings?.model, 'claude-opus-5-5');
  assert.equal(calls[1].settings?.fast, true);
  await bot.handle(message('/model fable'));
  await bot.handle(message('fable task')); await bot.idle();
  assert.equal(calls[2].settings?.model, 'claude-fable-5-1');
  assert.equal(calls[2].settings?.fast, false);
  assert.equal(store.data.settings?.fast, true);
  await bot.handle(message('/efforts nonsense'));
  assert.match(replies.at(-1)!, /low.*medium.*high/i);
  const reopened = await StateStore.open(path.join(dataDir, 'bot', 'state.json'));
  assert.deepEqual(reopened.data.settings, store.data.settings);
});

test('temporary thinking is removed on success and failure, without job/cost banners', async () => {
  const success = await setup();
  await success.bot.handle(message('hello')); await success.bot.idle();
  assert.match(success.indicators[0], /Thinking/);
  assert.deepEqual(success.deleted, [99]);
  assert.deepEqual(success.replies, ['Task complete']);
  const failure = await setup({ async run() { throw new Error('private'); } });
  await failure.bot.handle(message('hello')); await failure.bot.idle();
  assert.deepEqual(failure.deleted, [99]);
  assert.ok(!failure.replies.join('').match(/Job [a-f0-9]|Started job|cumulative estimate/));
});

test('/new chat archives conversations; /session resumes them and shared memory stays enabled', async () => {
  const { bot, store, calls, replies, panels } = await setup();
  await bot.handle(message('first')); await bot.idle();
  await bot.handle(message('/new chat'));
  assert.equal(store.data.sessions.default, undefined);
  await bot.handle(message('second')); await bot.idle();
  await bot.handle(message('/session session-1'));
  await bot.handle(message('third')); await bot.idle();
  assert.equal(calls[2].session, 'session-1');
  await bot.handle(message('/session'));
  assert.match(replies.at(-1)!, /second/);
  assert.ok(panels.at(-1)!.buttons.flat().some(b => b.callback_data === 'session session-2'));
  await bot.handle(message('/memory'));
  assert.match(replies.at(-1)!, /ON/);
  await bot.handle(message('/memory off'));
  await bot.handle(message('fourth')); await bot.idle();
  assert.equal(calls[3].memoryEnabled, false);
});

test('new chat clears the screen; selecting an old session displays paginated saved previews', async () => {
  const { bot, replies, screens } = await setup();
  await bot.handle(message('My first question')); await bot.idle();
  await bot.handle(message('/new chat'));
  assert.ok(screens.length > 0);
  assert.ok(!replies.some(x => x === 'Task complete'));
  await bot.handle(message('Second conversation')); await bot.idle();
  await bot.handle(message('/session session-1'));
  assert.ok(replies.some(x => x.includes('You\nMy first question')));
  assert.ok(replies.some(x => x.includes('Claude\nTask complete')));
  assert.ok(replies.some(x => x.includes('Chat overview · Page 1/1')));
  assert.ok(!replies.some(x => x.includes('Second conversation')));
});

test('owner buttons edit panels in place; outsider callbacks cannot change settings', async () => {
  const { bot, store, panels, acknowledgements } = await setup();
  const callback = { id: 'cb1', from: { id: 123 }, message: { ...message(''), message_id: 88 }, data: 'model sonnet' };
  await bot.callback({ ...callback, from: { id: 666 } });
  assert.equal(store.data.settings, undefined);
  assert.equal(acknowledgements.length, 0);
  await bot.callback(callback);
  assert.equal((store.data.settings as { model: string } | undefined)?.model, 'claude-sonnet-5-5');
  assert.equal(panels.at(-1)?.editId, 88);
  assert.ok(panels.at(-1)?.buttons.flat().some(x => x.callback_data === 'model opus'));
  await bot.callback({ ...callback, data: 'run delete all files' });
  assert.equal(store.data.active, null);
});

test('memory survives new chats and project switches; OFF reaches the runner', async () => {
  const { bot, replies, calls } = await setup();
  await bot.handle(message('/memory remember Answer in Hindi'));
  await bot.handle(message('/new chat'));
  await bot.handle(message('/project other'));
  await bot.handle(message('/memory'));
  assert.match(replies.at(-1)!, /Answer in Hindi/);
  await bot.handle(message('/memory off'));
  await bot.handle(message('hello')); await bot.idle();
  assert.equal(calls.at(-1)?.memoryEnabled, false);
  await bot.handle(message('/memory clear'));
  assert.ok(!replies.at(-1)!.includes('Answer in Hindi'));
});
