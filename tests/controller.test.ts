import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatArchive } from '../src/chats.js';
import { Controller, extendedDeadline } from '../src/controller.js';
import { AgentSafetyError, type Runner, type AgentRequest } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import type { Message } from '../src/safety.js';
import type { Buttons } from '../src/ui.js';
import { parseModels } from '../src/models.js';
import { TranscriptionError, type TranscriptionService } from '../src/transcription.js';

const message = (text: string): Message => ({ from: { id: 123 }, chat: { id: 123, type: 'private' }, text });
const photo = (id: string, group?: string): Message => ({ ...message(''), media_group_id: group, photo: [{ file_id: id + '-small', width: 100, height: 100 }, { file_id: id + '-large', width: 1200, height: 900 }] });
const video = (id: string, group?: string): Message => ({ ...message(''), media_group_id: group, video: { file_id: id, width: 640, height: 360, duration: 2, file_size: 8, thumbnail: { file_id: id + '-thumb' } } } as Message);
async function setup(runner?: Runner, transcriber?: TranscriptionService) {
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
    async queueClear() { screens.push([...replies]); replies.length = 0; },
    async panel(_chat: number, text: string, buttons: Buttons, editId?: number) { replies.push(text); panels.push({ text, buttons, editId }); },
    async acknowledge(id: string) { acknowledgements.push(id); },
    async sendFile(_chat: number, name: string, bytes: Uint8Array) { files.push(name); replies.push(Buffer.from(bytes).toString()); },
    async download(fileId: string) { downloads.push(fileId); return Buffer.from('uploaded'); } };
  const agent: Runner = runner ?? { async run(request, emit) {
    calls.push(request); await emit({ type: 'session', id: 'session-' + calls.length });
    return { text: 'Task complete', session: 'session-' + calls.length, cumulativeCost: 0.1 };
  } };
  return { bot: new Controller(config, store, sender, agent, undefined, undefined, undefined, transcriber), store, replies, calls, config, dataDir, deleted, indicators, screens, panels, acknowledgements, downloads, files, sender };
}

const voice = (): Message => ({ ...message(''), voice: { file_id: 'voice-original', duration: 3, mime_type: 'audio/ogg' } });

test('Projects menus paginate named projects and provide archive, Trash, restore and owner-only permanent deletion', async () => {
  const { bot, panels, store, dataDir } = await setup();
  for (let i = 0; i < 10; i++) await bot.projects.create({ id: 'project-' + i, name: 'Office ' + i, description: 'Supplier invoices' });
  await bot.handle(message('/projects'));
  assert.match(panels.at(-1)!.text, /11/); assert.ok(panels.at(-1)!.buttons.flat().some(b => /Next/.test(b.text)));
  const callback = async (data: string, owner = 123) => bot.callback({ id: 'project-callback', from: { id: owner }, message: { ...message(''), message_id: 800 }, data });
  const next = panels.at(-1)!.buttons.flat().find(b => /Next/.test(b.text))!;
  await callback(next.callback_data); assert.match(panels.at(-1)!.text, /Page 2/);
  await callback('pinfo project-0'); assert.match(panels.at(-1)!.text, /Office 0/);
  assert.ok(panels.at(-1)!.buttons.flat().some(b => /Archive/.test(b.text)));
  await callback('parchive project-0'); await callback('parchok project-0');
  assert.equal((await bot.projects.get('project-0')).status, 'archived');
  await callback('prestore project-0'); assert.equal((await bot.projects.get('project-0')).status, 'active');
  await callback('ptrash project-0'); await callback('ptrashok project-0');
  assert.equal((await bot.projects.get('project-0')).status, 'trashed');
  await writeFile(path.join(dataDir, 'workspaces/project-0/proof.txt'), 'preserved until owner confirms');
  await callback('ppurge project-0');
  const confirm = panels.at(-1)!.buttons.flat().find(b => b.callback_data.startsWith('ppurgeok ')); assert.ok(confirm);
  await callback(confirm.callback_data, 999); assert.equal((await bot.projects.get('project-0')).status, 'trashed');
  await callback('ppurgeok deadbeef'); assert.equal((await bot.projects.get('project-0')).status, 'trashed');
  await callback(confirm.callback_data); assert.equal((await bot.projects.get('project-0')).status, 'purged');
  await assert.rejects(readFile(path.join(dataDir, 'workspaces/project-0/proof.txt')), { code: 'ENOENT' });
  assert.equal(store.data.memoryEnabled, true);
  assert.ok(panels.flatMap(p => p.buttons.flat()).every(b => Buffer.byteLength(b.callback_data) <= 64));
});

test('project buttons redact full legacy metadata before truncation', async () => {
  const { bot, store, config, panels } = await setup(); await bot.projects.create({ id: 'legacy', name: 'Legacy' });
  store.data.projects!.find(p => p.id === 'legacy')!.name = 'Q'.repeat(30) + config.apiKey;
  await bot.handle(message('/projects'));
  assert.ok(!JSON.stringify(panels.at(-1)!.buttons).includes(config.apiKey.slice(0, 4)));
});

const speech = { text: 'Please read the attached bill', language: 'eng', durationSeconds: 3, provider: 'ElevenLabs' as const, model: 'scribe_v2' as const, cached: false, hasSpeech: true, transcriptFile: 'transcripts/voice.txt', metadataFile: 'transcripts/voice.json' };

test('queue previews mask complete credentials before truncation and schedule buttons mask private names', async () => {
  const { bot, config, panels } = await setup(); await bot.automation.setPaused(true);
  await bot.automation.enqueue({ kind: 'agent', project: 'default', chatKey: 'chat', prompt: 'Q'.repeat(96) + config.apiKey + ' rest' });
  await bot.handle(message('/queue'));
  assert.match(panels.at(-1)!.text, /REDACTED/);
  assert.ok(!panels.at(-1)!.text.includes('Q'.repeat(96) + config.apiKey.slice(0, 4)));
  await bot.automation.createSchedule({ name: 'password: "private button words"', kind: 'reminder', project: 'default', prompt: 'Review invoices', intervalMinutes: 60 });
  await bot.handle(message('/schedules'));
  assert.ok(!JSON.stringify(panels.at(-1)).includes('private button words'));
  assert.ok(!JSON.stringify(panels.at(-1)!.buttons).includes('private but'));
  await bot.automation.createSchedule({ name: 'ghp_' + 'A'.repeat(36), kind: 'reminder', project: 'default', prompt: 'Review invoices', intervalMinutes: 60 });
  await bot.handle(message('/schedules'));
  assert.ok(!JSON.stringify(panels.at(-1)!.buttons).includes('ghp_'));
});

test('voice executes spoken instructions immediately, consumes pending photos and persists actual text', async () => {
  let transcriptions = 0;
  const { bot, downloads, calls, store, indicators, dataDir } = await setup(undefined, { async transcribe(_root, file) { transcriptions++; assert.match(file, /voice\.ogg$/); return speech; } });
  await bot.handle(photo('bill')); await bot.handle(voice()); await bot.idle();
  assert.equal(transcriptions, 1); assert.deepEqual(downloads, ['bill-large', 'voice-original']);
  assert.equal(calls.length, 1); assert.match(calls[0].prompt, /Please read the attached bill/); assert.match(calls[0].prompt, /photo\.jpg/);
  assert.equal(store.data.tasks![0].voiceInput, undefined); assert.match(store.data.tasks![0].displayPrompt!, /Please read/);
  assert.ok(indicators.some(t => /Transcribing/.test(t)));
  const saved = await new ChatArchive(path.join(dataDir, 'bot/chats'), []).read('session-1'); assert.ok(saved.some(t => t.role === 'user' && t.text.includes('Please read the attached bill')));
  assert.ok(calls[0].workspace?.transcribe);
});

test('audio files wait for a text prompt and expose callable transcription without executing recorded speech', async () => {
  let transcriptions = 0;
  const { bot, calls, panels } = await setup(undefined, { async transcribe() { transcriptions++; return speech; } });
  await bot.handle({ ...message(''), audio: { file_id: 'song', file_name: 'song.mp3', mime_type: 'audio/mpeg' } });
  assert.equal(calls.length, 0); assert.equal(transcriptions, 0); assert.match(panels.at(-1)!.text, /1 audio.*received/);
  await bot.handle(message('Summarize the recording')); await bot.idle(); assert.equal(calls.length, 1); assert.equal(transcriptions, 0);
  assert.equal((await calls[0].workspace!.transcribe!('uploads/song.mp3')).text, speech.text);
});

test('transcription failure makes no Claude call and explicit retry keeps voice input', async () => {
  let attempts = 0; const { bot, calls, replies, store } = await setup(undefined, { async transcribe() { attempts++; if (attempts === 1) throw new TranscriptionError('ElevenLabs quota exhausted.'); return speech; } });
  await bot.handle(voice()); await bot.idle(); assert.equal(calls.length, 0); assert.match(replies.join('\n'), /quota exhausted/);
  const task = store.data.tasks![0]; assert.equal(task.status, 'failed'); assert.ok(task.voiceInput);
  await bot.automation.retryTask(task.id); await bot.handle(message('/queue resume')); await bot.idle();
  assert.equal(calls.length, 1); assert.equal(attempts, 2); assert.match(calls[0].prompt, /Please read/);
});

test('silent or unauthorized voice notes never run Claude', async () => {
  let attempts = 0; const { bot, calls, downloads, replies } = await setup(undefined, { async transcribe() { attempts++; return { ...speech, hasSpeech: false, text: '[music]' }; } });
  await bot.handle({ ...voice(), from: { id: 666 } }); assert.equal(downloads.length, 0);
  await bot.handle(voice()); await bot.idle(); assert.equal(attempts, 1); assert.equal(calls.length, 0); assert.match(replies.join('\n'), /No speech/);
});

test('Stop aborts transcription and never starts Claude', async () => {
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  const { bot, calls, store, deleted } = await setup(undefined, { async transcribe(_root, _file, _language, signal) { started(); await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); return speech; } });
  await bot.handle(voice()); await ready; await bot.handle(message('/stop')); await bot.idle();
  assert.equal(calls.length, 0); assert.equal(store.data.tasks![0].status, 'cancelled'); assert.ok(deleted.length);
});

test('explicitly paused processing retains voice uploads without queueing new messages', async () => {
  const { bot, store } = await setup(); await bot.automation.setPaused(true);
  await bot.handle(voice()); const saved = await StateStore.open(store.file);
  assert.equal(saved.data.uploads![0].mediaType, 'voice'); assert.equal(saved.data.tasks!.length, 0);
  assert.equal(saved.data.batches![0].status, 'collecting');
});

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
test('/plan starts the task in plan mode; plain messages and retries keep their own mode', async () => {
  const { bot, calls, store } = await setup();
  await bot.handle(message('/plan sort the bills')); await bot.idle();
  await bot.handle(message('plain work')); await bot.idle();
  assert.equal(calls[0].prompt.includes('sort the bills'), true); assert.equal(calls[0].planMode, true);
  assert.equal(calls[1].planMode, undefined);
  assert.equal(store.data.tasks![0].planMode, true);
  assert.equal((await StateStore.open(store.file)).data.tasks![0].planMode, true);
  store.data.tasks![0].status = 'failed'; const retried = await bot.automation.retryTask(store.data.tasks![0].id);
  assert.equal(retried.planMode, true);
});

test('new messages steer the running conversation instead of becoming separate queued tasks', async () => {
  let release!: () => void; let began!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; }); const calls: AgentRequest[] = [];
  const { bot, store } = await setup({ async run(r, emit) { calls.push(r); if (calls.length === 1) { began(); await wait; } await emit({ type: 'session', id: 'same-chat' }); return { session: 'same-chat', text: 'Done', cumulativeCost: 0 }; } });
  await bot.handle(message('First')); await ready; await bot.handle(message('Second')); assert.equal(calls.length, 1); assert.equal(store.data.tasks!.length, 1);
  await calls[0].steering!.settled(new AbortController().signal);
  assert.equal(calls[0].steering!.messages[0].text, 'Second');
  release(); await bot.idle(); assert.equal(calls.length, 1); assert.ok(store.data.tasks!.every(t => t.status === 'completed'));
});

test('steering during startup is prepared once even while a Telegram notice is being cleared', async () => {
  let waiting!: () => void; let release!: () => void; const reached = new Promise<void>(r => { waiting = r; }); const pause = new Promise<void>(r => { release = r; }); let count = 0;
  const { bot, sender } = await setup({ async run(request) { await request.steering!.settled(new AbortController().signal); count = request.steering!.messages.length; return { session: 'startup-chat', text: 'Done', cumulativeCost: 0 }; } });
  Object.assign(sender, { async dismiss(_chat: number, scope: string) { if (scope.startsWith('task-') && !count) { waiting(); await pause; } } });
  await bot.handle(message('First')); await reached;
  try { await bot.handle(message('Correction during startup')); } finally { release(); }
  await bot.idle(); assert.equal(count, 1);
});

test('voice and pending photos join the running task; final text is sent and archived only once', async () => {
  let release!: () => void; let began!: () => void; const ready = new Promise<void>(r => { began = r; }); const waiting = new Promise<void>(r => { release = r; }); let current!: AgentRequest;
  const { bot, store, replies, dataDir } = await setup({ async run(r, emit) {
    current = r; await emit({ type: 'session', id: 'steer-chat' }); await emit({ type: 'commentary', id: 'progress', text: 'I found the bill; checking totals.' }); began(); await waiting;
    const ids = r.steering!.messages.map(m => m.id); r.steering!.acknowledge(ids); await emit({ type: 'steered', ids });
    await emit({ type: 'commentary', id: 'final', text: 'Done with your correction.' }); return { session: 'steer-chat', text: 'Done with your correction.', cumulativeCost: 0 };
  } }, { async transcribe() { return { ...speech, text: 'Please make one CSV' }; } });
  try {
    await bot.handle(message('Read bills')); await ready; assert.ok(replies.includes('I found the bill; checking totals.'));
    await bot.handle(photo('bill')); await bot.handle(voice()); await current.steering!.settled(new AbortController().signal);
    assert.equal(store.data.tasks!.length, 1); assert.match(current.steering!.messages[0].text, /Please make one CSV/); assert.match(current.steering!.messages[0].text, /photo.jpg/);
  } finally { release(); await bot.idle(); }
  assert.equal(replies.filter(t => t === 'Done with your correction.').length, 1);
  const archive = await new ChatArchive(path.join(dataDir, 'bot/chats'), []).read('steer-chat');
  assert.equal(archive.filter(t => t.text === 'Done with your correction.').length, 1); assert.ok(archive.some(t => t.role === 'user' && t.text === 'Please make one CSV'));
  const reopened = await StateStore.open(store.file); assert.equal(reopened.data.tasks![0].steers![0].status, 'answered');
});

test('Stop remains responsive while a steering voice is transcribing', async () => {
  let started!: () => void; let speaking!: () => void;
  const ready = new Promise<void>(r => { started = r; }); const voiceReady = new Promise<void>(r => { speaking = r; });
  const { bot, store } = await setup({ async run(_request, _emit, abort) { started(); await new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); throw new Error('unreachable'); } }, { async transcribe(_root, _file, _language, signal) { speaking(); await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true })); return speech; } });
  await bot.handle(message('Long task')); await ready; await bot.handle(voice()); await voiceReady;
  await bot.handle(message('/stop')); await bot.idle(); assert.equal(store.data.tasks!.length, 1); assert.equal(store.data.tasks![0].status, 'cancelled'); assert.equal(store.data.tasks![0].steers![0].status, 'failed');
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

test('busy task accepts steering, blocks project changes, /status stays responsive and /stop cancels without replay', async () => {
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
  await bot.handle(message('/model sonnet'));
  await bot.handle(message('/status'));
  assert.equal(calls, 1);
  assert.equal(store.data.project, 'default');
  assert.ok(replies.some(r => /busy/i.test(r)));
  assert.ok(replies.some(r => /running/i.test(r)));
  await bot.handle(message('/stop')); await bot.idle();
  assert.equal(store.data.lastJob?.status, 'cancelled');
  assert.equal(store.data.active, null);
  assert.equal(store.data.queuePaused, true);
  assert.equal(store.data.tasks!.filter(t => t.status === 'queued').length, 0);
});

test('while a task runs the owner can switch chats and projects; work for another chat is queued, not refused', async () => {
  const prompts: string[] = []; let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const runner: Runner = { async run(request, emit) {
    prompts.push(request.prompt); await emit({ type: 'session', id: 'chat-' + prompts.length });
    if (prompts.length === 1) { started(); await hold; }
    return { text: 'Done ' + prompts.length, session: 'chat-' + prompts.length, cumulativeCost: 0 };
  } };
  const { bot, replies, store } = await setup(runner);
  await bot.handle(message('long job')); await ready;
  try {
    await bot.handle(message('/new'));
    assert.ok(!replies.some(r => /busy/i.test(r)), 'chat switching is not blocked');
    await bot.handle(message('quick question in the new chat'));
    assert.ok(replies.some(r => /queued/i.test(r)));
    assert.ok(!replies.some(r => /not queued/i.test(r)));
    const queued = store.data.tasks!.filter(t => t.status === 'queued');
    assert.equal(queued.length, 1); assert.match(queued[0].prompt, /quick question/);
    await bot.handle(message('/project side-work'));
    assert.equal(store.data.project, 'side-work');
  } finally { release(); await bot.idle(); }
  assert.equal(prompts.length, 2); assert.match(prompts[1], /quick question/);
  assert.equal(store.data.tasks!.filter(t => t.status === 'completed').length, 2);
});

test('plan approval: the plan and buttons reach the owner; a tap approves and a text reply is plan feedback, not a steer', async () => {
  let steering: import('../src/steering.js').SteeringInput | undefined;
  const runner: Runner = { async run(request, emit, abort) {
    steering = request.steering; await emit({ type: 'session', id: 'plan-chat' });
    const first = await request.planApproval!('1. Read the bills\n2. Build the sheet', abort.signal);
    const second = await request.planApproval!('Revised plan', abort.signal);
    return { text: 'Decisions: ' + JSON.stringify([first, second]), session: 'plan-chat', cumulativeCost: 0 };
  } };
  const { bot, replies, panels } = await setup(runner);
  const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(check()); };
  const tokenOf = (n: number) => panels.filter(p => p.buttons.flat().some(b => b.callback_data.startsWith('planok ')))[n]?.buttons.flat().find(b => b.callback_data.startsWith('planok '))!.callback_data.split(' ')[1];
  await bot.handle(message('plan the bill work'));
  await until(() => !!tokenOf(0));
  assert.ok(replies.some(r => r.includes('1. Read the bills')));
  const tap = (data: string) => bot.callback({ id: 'plan-tap', from: { id: 123 }, message: { ...message(''), message_id: 801 }, data });
  await tap('planok ' + tokenOf(0));
  await until(() => !!tokenOf(1));
  await tap('planok ' + tokenOf(0)); assert.match(replies.at(-1)!, /no longer pending/i);
  await bot.handle(message('Use CSV, not Excel'));
  await bot.idle();
  assert.ok(replies.some(r => r.includes('Decisions: [{"approved":true},{"approved":false,"feedback":"Use CSV, not Excel"}]')));
  assert.equal(steering!.messages.length, 0);
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

test('each owner steer moves the task deadline forward, capped at three time limits from the start', async () => {
  let abortedAt = 0; let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const runner: Runner = { async run(_request, _emit, abort) {
    began();
    await new Promise<void>((_resolve, reject) => abort.signal.addEventListener('abort', () => { abortedAt = Date.now(); reject(new Error('aborted')); }, { once: true }));
    throw new Error('unreachable');
  } };
  const { bot, config, store } = await setup(runner);
  config.timeoutMs = 150;
  await bot.handle(message('work')); await started;
  const first = store.data.tasks![0].deadlineAt!;
  await new Promise(resolve => setTimeout(resolve, 100));
  const steeredAt = Date.now(); await bot.handle(message('one more thing')); await bot.idle();
  assert.ok(Date.parse(store.data.tasks![0].deadlineAt!) > Date.parse(first));
  assert.ok(abortedAt - steeredAt >= 140, 'the time limit restarts from the latest owner message');
  assert.equal(store.data.tasks![0].failureKind, 'timeout');
  const start = '2026-11-24T10:00:00.000Z', limit = 20 * 60_000;
  assert.equal(extendedDeadline(start, '2026-11-24T10:20:00.000Z', limit, Date.parse('2026-11-24T10:15:00.000Z')), '2026-11-24T10:35:00.000Z');
  assert.equal(extendedDeadline(start, '2026-11-24T10:50:00.000Z', limit, Date.parse('2026-11-24T10:55:00.000Z')), '2026-11-24T11:00:00.000Z');
  assert.equal(extendedDeadline(start, '2026-11-24T10:20:00.000Z', limit, Date.parse('2026-11-24T10:01:00.000Z')), '2026-11-24T10:21:00.000Z');
});

test('timeout still aborts bounded work without a spending cap', async () => {
  const runner: Runner = { async run(_request, _emit, abort) {
    abort.signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    throw new Error('unreachable');
  } };
  const { bot, config, store, replies } = await setup(runner);
  config.timeoutMs = 20;
  await bot.handle(message('work')); await bot.idle();
  assert.equal(store.data.lastJob?.status, 'cancelled');
  assert.ok(replies.some(r => r.includes('time limit')));
  assert.equal(store.data.tasks![0].failureKind, 'timeout');
  assert.equal((await StateStore.open(store.file)).data.tasks![0].failureKind, 'timeout');
});

test('/model buttons come from the model list by family; state only ever stores ids the previous version accepts', async () => {
  const { bot, calls, store, panels, config } = await setup();
  const page = JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures-models-2026-11-25.json'), 'utf8'));
  store.data.modelCatalog = { fetchedAt: new Date().toISOString(), models: parseModels(page) };
  config.modelFamilies.push('haiku');
  await bot.handle(message('/model'));
  const buttons = panels.at(-1)!.buttons.flat();
  assert.deepEqual(buttons.filter(b => b.callback_data.startsWith('model ')).map(b => [b.text.replace('✓ ', ''), b.callback_data]),
    [['Fable 5.2', 'model fable'], ['Opus 5.5', 'model opus'], ['Sonnet 5.5', 'model sonnet'], ['Haiku 5.5', 'model haiku']]);
  await bot.callback({ id: 'm', from: { id: 123 }, message: { ...message(''), message_id: 90 }, data: 'model haiku' });
  assert.deepEqual(store.data.settings && { model: store.data.settings.model, family: store.data.settings.family }, { model: 'claude-opus-5-5', family: 'haiku' });
  await bot.handle(message('haiku work')); await bot.idle();
  assert.equal(calls[0].settings?.model, 'claude-haiku-5-5');
  await bot.handle(message('/model claude-fable-5-2'));
  assert.equal(store.data.settings?.model, 'claude-fable-5-1'); assert.equal(store.data.settings?.family, undefined);
  const legacy = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'];
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.ok(legacy.includes(saved.settings.model)); assert.ok(saved.tasks.every((t: { settings?: { model: string } }) => !t.settings || legacy.includes(t.settings.model)));
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
  assert.equal(calls[2].settings?.model, 'claude-fable-5-2', 'the newest Fable runs');
  assert.equal(store.data.settings?.model, 'claude-fable-5-1', 'state keeps the old id so a rolled-back version still loads it');
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

test('fallback SDK versions appear once in the menu and selecting an old ID resumes the latest version', async () => {
  let count = 0; const requests: AgentRequest[] = [];
  const { bot, panels, store } = await setup({ async run(request, emit) {
    requests.push(request); count++;
    if (count === 1) { await emit({ type: 'session', id: 'original' }); await request.sessions!.rename('original', 'Invoice review', 'manual'); }
    await emit({ type: 'session', id: 'recovered' });
    return { session: 'recovered', text: 'Ready', cumulativeCost: 0 };
  } });
  await bot.handle(message('Review invoice')); await bot.idle();
  await bot.handle(message('/session'));
  assert.match(panels.at(-1)!.text, /1 chats/);
  assert.equal(panels.at(-1)!.buttons.flat().filter(b => b.callback_data.startsWith('session ')).length, 1);
  assert.match(panels.at(-1)!.text, /Invoice review/);
  await bot.handle(message('/new chat'));
  await bot.handle(message('/session original'));
  assert.equal(store.data.sessions.default, 'recovered');
  await bot.handle(message('Continue')); await bot.idle();
  assert.equal(requests[1].session, 'recovered');
});

test('/fresh seeds only verified successful work and waits for a new instruction without resuming the refused chat', async () => {
  const requests: AgentRequest[] = []; let n = 0;
  const { bot, store, panels, dataDir } = await setup({ async run(request, emit) {
    requests.push(request); n++; await emit({ type: 'session', id: n <= 2 ? 'source-session' : 'fresh-session' });
    if (n === 2) throw new AgentSafetyError('cyber');
    return { session: n <= 2 ? 'source-session' : 'fresh-session', text: n === 1 ? 'Completed the invoice workbook in output/invoice.xlsx.' : 'Continuing with the totals.', cumulativeCost: 0 };
  } });
  await bot.handle(message('Prepare invoice')); await bot.idle();
  await bot.handle(message('REFUSED_REQUEST_WITH_RAW_ATTACHMENT')); await bot.idle();
  assert.ok(panels.some(p => p.buttons.flat().some(b => b.callback_data === 'fresh')));
  await bot.handle(message('/fresh'));
  assert.equal(n, 2); assert.equal(store.data.sessions.default, undefined);
  assert.match(panels.at(-1)!.text, /invoice workbook/); assert.ok(!panels.at(-1)!.text.includes('REFUSED_REQUEST'));
  const reopened = await StateStore.open(store.file); assert.ok(Object.values(reopened.data.freshContexts ?? {}).some(c => c.includes('invoice workbook')));
  await bot.handle(message('Continue with totals')); await bot.idle();
  assert.equal(requests[2].session, undefined); assert.match(requests[2].prompt, /invoice workbook/);
  assert.ok(!requests[2].prompt.includes('REFUSED_REQUEST')); assert.ok(!requests[2].resumeContext?.includes('REFUSED_REQUEST'));
  assert.equal(store.data.memoryEnabled, true); assert.equal(store.data.sessions.default, 'fresh-session');
  const old = await new ChatArchive(path.join(dataDir, 'bot/chats'), []).read('source-session');
  assert.ok(old.some(t => t.text.includes('REFUSED_REQUEST'))); assert.ok(store.data.conversations!.some(c => c.id === 'source-session'));
});

test('background work remains alive after the model turn and a new chat, then notifies its source session', async () => {
  let jobId = '';
  const { bot, store, replies, dataDir } = await setup({ async run(request, emit) {
    await emit({ type: 'session', id: 'background-source' });
    await writeFile(path.join(request.cwd, 'monitor.mjs'), "setTimeout(() => console.log('BACKGROUND_AFTER_CHAT'), 600);");
    jobId = (await request.workspace!.background!.start({ name: 'Monitor', runtime: 'node', script: 'monitor.mjs' })).id;
    return { session: 'background-source', text: 'Monitor is running.', cumulativeCost: 0 };
  } });
  try {
    await bot.handle(message('Monitor the task in the background')); await bot.idle();
    assert.equal(bot.background.list()[0].status, 'running');
    await bot.handle(message('/new')); assert.equal(store.data.sessions.default, undefined);
    await bot.background.wait(jobId); await bot.background.tick();
    assert.ok(replies.some(r => r.includes('Monitor: completed')));
    const archive = await new ChatArchive(path.join(dataDir, 'bot/chats'), []).read('background-source');
    assert.ok(archive.some(t => t.text.includes('BACKGROUND_AFTER_CHAT')));
  } finally { await bot.stop(); }
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


test('message tools bind to the owner and keep reply targets and last-message cutoff across text and voice steering', async () => {
  let began!: () => void, release!: () => void; const started = new Promise<void>(r => { began = r; }); const wait = new Promise<void>(r => { release = r; });
  let request!: AgentRequest;
  const { bot, sender, store } = await setup({ async run(r) { request = r; began(); await wait; return { session: 'message-tools', text: 'Done', cumulativeCost: 0 }; } }, { async transcribe() { return speech; } });
  const lists: unknown[] = [], deletes: unknown[] = [], adopted: number[] = [];
  Object.assign(sender, {
    async rememberBotReply(_chat: number, m: Message) { adopted.push(m.message_id!); return true; },
    listBotMessages(chat: number, options: unknown) { lists.push({ chat, options }); return { messages: [], total: 0 }; },
    async deleteBotMessages(chat: number, ids: number[], signal: AbortSignal) { deletes.push({ chat, ids }); assert.equal(signal.aborted, false); return { deleted: ids, alreadyMissing: [], failed: [] }; }
  });
  const target: Message = { ...message('Old status'), message_id: 45, from: { id: 123456 }, date: Math.floor(Date.now() / 1000) };
  try {
    await bot.handle({ ...message('Remove this obsolete reply'), message_id: 50, reply_to_message: target }); await started;
    assert.match(request.prompt, /Telegram reply target: bot message ID 45/);
    await request.workspace!.telegram!.list({ limit: 2 });
    assert.deepEqual(lists[0], { chat: 123, options: { limit: 2, messageId: undefined, beforeMessageId: 50, includeUi: undefined } });
    await request.workspace!.telegram!.delete([45]); assert.deepEqual(deletes, [{ chat: 123, ids: [45] }]);
    await bot.handle({ ...voice(), message_id: 70, reply_to_message: { ...target, message_id: 65 } });
    await request.steering!.settled(new AbortController().signal);
    assert.match(request.steering!.messages[0].text, /Telegram reply target: bot message ID 65/);
    await request.workspace!.telegram!.list({ limit: 2 });
    assert.deepEqual(lists[1], { chat: 123, options: { limit: 2, messageId: undefined, beforeMessageId: 70, includeUi: undefined } });
    await request.workspace!.telegram!.list({ include_current_task: true });
    assert.deepEqual(lists[2], { chat: 123, options: { limit: undefined, messageId: undefined, beforeMessageId: undefined, includeUi: undefined } });
    await bot.handle({ ...message('Remove it'), from: { id: 666 }, reply_to_message: target }); assert.deepEqual(adopted, [45, 65]);
  } finally { release(); await bot.idle(); }
  const saved = await StateStore.open(store.file); assert.equal(saved.data.tasks![0].messageContext!.replyToMessageId, 45); assert.equal(saved.data.tasks![0].steers![0].messageContext!.replyToMessageId, 65);
});


test('safety refusal is recorded distinctly without pausing unrelated future requests', async () => {
  const {AgentSafetyError}=await import('../src/agent.js');
  const {bot,store,replies}=await setup({async run(_r,emit){await emit({type:'session',id:'refused-session'});throw new AgentSafetyError('cyber');}});
  await bot.handle(message('Current task'));await bot.idle();
  assert.equal(store.data.tasks![0].status,'failed');assert.equal(store.data.tasks![0].failureKind,'safety_refusal');assert.ok(!store.data.queuePaused);
  assert.match(replies.join('\n'),/safety system stopped/);
  const reopened=await StateStore.open(store.file);assert.equal(reopened.data.tasks![0].failureKind,'safety_refusal');
});
