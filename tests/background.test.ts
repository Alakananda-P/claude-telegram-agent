import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BackgroundJobs, type BackgroundJob } from '../src/background.js';
import { StateStore } from '../src/state.js';
import { loadConfig } from '../src/config.js';
import { setTimeout as delay } from 'node:timers/promises';

async function setup(notify: (job: BackgroundJob) => Promise<void> = async () => {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-background-'));
  const root = path.join(dir, 'workspaces/default'); await mkdir(root, { recursive: true });
  const store = await StateStore.open(path.join(dir, 'bot/state.json'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'sk-ant-background-secret-test-value', DATA_DIR: dir });
  const jobs = new BackgroundJobs(config, store, notify);
  const script = async (name: string, code: string) => { await writeFile(path.join(root, name), code); return name; };
  const start = (file: string, timeoutMs = 60000) => jobs.start({ name: 'Monitor test', project: 'default', chatKey: 'old-chat', root, runtime: 'node', script: file, timeoutMs });
  return { dir, root, config, store, jobs, script, start };
}

test('a real background process outlives the submitting function and delivers completion once', async () => {
  const notices: string[] = []; const { jobs, start, script, store } = await setup(async job => { notices.push(job.id); });
  try {
    const file = await script('monitor.mjs', "setTimeout(() => console.log('BACKGROUND_DONE'), 180);");
    const job = await start(file); assert.equal(job.status, 'running');
    await jobs.wait(job.id); await jobs.tick(); await jobs.tick();
    assert.deepEqual(notices, [job.id]); assert.equal(jobs.list()[0].status, 'completed');
    assert.match((await jobs.read(job.id)).text, /BACKGROUND_DONE/);
    assert.equal((await StateStore.open(store.file)).data.backgroundJobs![0].status, 'completed');
  } finally { await jobs.stop(); }
});

test('background stderr and split credentials are redacted and child processes inherit no service secrets', async () => {
  const { jobs, config, store, start, script } = await setup();
  const old = process.env.TELEGRAM_BOT_TOKEN; process.env.TELEGRAM_BOT_TOKEN = config.token;
  try {
    const file = await script('failure.mjs', `console.log('SERVICE_SECRET_PRESENT=' + Boolean(process.env.TELEGRAM_BOT_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.RENDER_API_KEY));process.stdout.write(${JSON.stringify(config.apiKey.slice(0, 12))});console.error('interleaved progress');setTimeout(() => {process.stdout.write(${JSON.stringify(config.apiKey.slice(12))});console.error(${JSON.stringify(config.apiKey)});process.exitCode=7;},80);`);
    const job = await start(file); await jobs.wait(job.id); const output = await jobs.read(job.id);
    assert.equal(jobs.list()[0].status, 'failed'); assert.equal(jobs.list()[0].exitCode, 7);
    assert.match(output.text, /SERVICE_SECRET_PRESENT=false/); assert.ok(!output.text.includes(config.apiKey));
    assert.ok(!output.text.includes(config.apiKey.slice(12)));
    assert.match(output.text, /REDACTED/); assert.ok(!(await readFile(store.file, 'utf8')).includes(config.apiKey));
  } finally { if (old === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = old; await jobs.stop(); }
});

test('shutdown racing with a persisted start cannot leave a child process running', async () => {
  const { jobs, store, start, script } = await setup();
  const file = await script('race.mjs', 'setInterval(() => {}, 1000);');
  let release!: () => void, reserved!: () => void;
  const gate = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { reserved = r; });
  const save = store.save.bind(store); let once = false;
  store.save = async () => { if (!once && store.data.backgroundJobs?.some(j => j.status === 'starting')) { once = true; reserved(); await gate; } return save(); };
  const starting = start(file).catch(() => undefined); await entered;
  const stopping = jobs.stop(); release(); await starting; await stopping;
  assert.ok(jobs.list().every(j => !['running', 'starting'].includes(j.status)));
});

test('background cancellation and its own timeout stop real processes without waiting for a model turn', async () => {
  const { jobs, start, script } = await setup();
  try {
    const file = await script('waiting.mjs', 'setInterval(() => {}, 1000);');
    const cancelled = await start(file); await jobs.cancel(cancelled.id);
    assert.equal(jobs.list().find(j => j.id === cancelled.id)!.status, 'cancelled');
    const timeout = await start(file, 1000); await jobs.wait(timeout.id);
    assert.equal(jobs.list().find(j => j.id === timeout.id)!.status, 'timed_out');
  } finally { await jobs.stop(); }
});

test('background jobs enforce concurrency, safe script paths and secret-free arguments', async () => {
  const { jobs, root, dir, config, start, script } = await setup();
  try {
    const file = await script('waiting.mjs', 'setInterval(() => {}, 1000);');
    await assert.rejects(start('../waiting.mjs'));
    await writeFile(path.join(root, '.env.mjs'), ''); await assert.rejects(start('.env.mjs'));
    await symlink(root, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(start('linked/waiting.mjs'));
    await assert.rejects(jobs.start({ name: 'Secret', project: 'default', chatKey: 'chat', root, runtime: 'node', script: file, args: [config.apiKey] }));
    await assert.rejects(jobs.start({ name: 'Wrong root', project: 'default', chatKey: 'chat', root: dir, runtime: 'node', script: file }));
    await start(file); await start(file); await assert.rejects(start(file), /two|2|concurrency/i);
  } finally { await jobs.stop(); }
});

test('restart marks old processes interrupted without replay and retries failed completion delivery', async () => {
  const { jobs, store, script, start, config } = await setup();
  const file = await script('done.mjs', "console.log('done');"); const job = await start(file); await jobs.wait(job.id);
  const saved = store.data.backgroundJobs![0]; saved.status = 'running'; delete saved.notifiedAt; await store.save();
  const reopened = await StateStore.open(store.file); assert.equal(reopened.data.backgroundJobs![0].status, 'interrupted');
  let attempts = 0; const restored = new BackgroundJobs(config, reopened, async () => { if (++attempts === 1) throw new Error('network'); });
  try { await restored.tick(); assert.equal(reopened.data.backgroundJobs![0].notifiedAt, undefined); await restored.tick(Date.now() + 31_000); await restored.tick(Date.now() + 31_000); assert.equal(attempts, 2); }
  finally { await restored.stop(); await jobs.stop(); }
});

test('background output is bounded and readable in pages', async () => {
  const { jobs, start, script } = await setup();
  try {
    const file = await script('verbose.mjs', "process.stdout.write('x'.repeat(300000));");
    const job = await start(file); await jobs.wait(job.id);
    const page = await jobs.read(job.id, 0, 1000); assert.equal(page.text.length, 1000); assert.equal(page.nextOffset, 1000);
    assert.equal(page.job.truncated, true); assert.ok(page.totalCharacters < 263000);
  } finally { await jobs.stop(); }
});

test('Linux cancellation stops descendants in the owned process group', { skip: process.platform === 'win32' }, async () => {
  const { jobs, root, start, script } = await setup(); const marker = path.join(root, 'orphan.txt');
  try {
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphan'), 700);`;
    const file = await script('tree.mjs', `import {spawn} from 'node:child_process';spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});console.log('CHILD_STARTED');setInterval(()=>{},1000);`);
    const job = await start(file);
    for (let n = 0; n < 60 && !(await jobs.read(job.id)).text.includes('CHILD_STARTED'); n++) await delay(20);
    assert.match((await jobs.read(job.id)).text, /CHILD_STARTED/); await jobs.cancel(job.id); await delay(850);
    await assert.rejects(readFile(marker), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally { await jobs.stop(); }
});
