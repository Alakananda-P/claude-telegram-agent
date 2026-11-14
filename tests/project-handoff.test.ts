import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Controller, type Messenger } from '../src/controller.js';
import { AgentSafetyError, type Runner, type AgentRequest } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import type { ProjectToolContext } from '../src/project-tools.js';

const message = (text: string) => ({ from: { id: 123 }, chat: { id: 123, type: 'private' }, text });
async function setup(run: Runner['run']) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-project-handoff-'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dir });
  const store = await StateStore.open(path.join(dir, 'bot/state.json')), replies: string[] = [];
  const sender: Messenger = { async send(_id, text) { replies.push(text); }, async sendFile() {}, async download() { return Buffer.alloc(0); },
    async temporary() { return 5; }, async edit() {}, async remove() {}, async typing() {} };
  const bot = new Controller(config, store, sender, { run });
  return { bot, store, dir, replies, config };
}
function projects(request: AgentRequest): ProjectToolContext {
  const context = request.projects;
  assert.ok(context, 'Claude has no project lifecycle tools'); return context;
}

test('a successful switch continues only remaining work in the real destination cwd and saved chat with the same deadline', async () => {
  const calls: AgentRequest[] = []; let deadline: string | undefined;
  const fixture = await setup(async (request, emit) => {
    calls.push(request); const context = projects(request);
    if (calls.length === 1) {
      await context.catalog.create({ id: 'invoice-app', name: 'Invoice App' });
      fixture.store.data.conversations!.push({ id: 'existing-invoice-chat', project: 'invoice-app', updatedAt: new Date().toISOString() });
      fixture.store.data.sessions['invoice-app'] = 'existing-invoice-chat';
      deadline = fixture.store.data.tasks![0].deadlineAt; assert.ok(deadline);
      await context.requestSwitch('invoice-app', 'Create marker.txt containing PROJECT_HANDOFF_OK.');
      assert.equal(context.pending(), true); assert.equal(fixture.store.data.project, 'default');
    } else {
      assert.equal(request.cwd, path.join(fixture.dir, 'workspaces/invoice-app'));
      assert.equal(request.session, 'existing-invoice-chat');
      assert.match(request.prompt, /Create marker.txt/); assert.ok(!request.prompt.includes('DO_NOT_REPLAY_ORIGINAL'));
      assert.equal(fixture.store.data.tasks![1].deadlineAt, deadline);
      await writeFile(path.join(request.cwd, 'marker.txt'), 'PROJECT_HANDOFF_OK');
    }
    const session = calls.length === 1 ? 'source-chat' : 'existing-invoice-chat';
    await emit({ type: 'session', id: session }); return { text: 'Done', session, cumulativeCost: 0 };
  });
  await fixture.bot.handle(message('Create a project, switch to it and write a marker. DO_NOT_REPLAY_ORIGINAL')); await fixture.bot.idle();
  assert.equal(calls.length, 2); assert.equal(fixture.store.data.project, 'invoice-app');
  assert.equal(await readFile(path.join(fixture.dir, 'workspaces/invoice-app/marker.txt'), 'utf8'), 'PROJECT_HANDOFF_OK');
  await assert.rejects(lstat(path.join(fixture.dir, 'workspaces/default/marker.txt')), { code: 'ENOENT' });
  assert.ok(fixture.store.data.tasks!.every(t => t.status === 'completed'));
});

for (const outcome of ['failure', 'stop', 'cancel-switch', 'destination-archived'] as const) test(`a pending project switch is not applied after ${outcome}`, async () => {
  let calls = 0, requested = false;
  const fixture = await setup(async request => {
    calls++; const context = projects(request); await context.catalog.create({ id: 'target', name: 'Target' });
    await context.requestSwitch('target', 'Do the remaining work once.');
    requested = true;
    if (outcome === 'failure') throw new AgentSafetyError();
    if (outcome === 'stop') await fixture.bot.handle(message('/stop'));
    if (outcome === 'cancel-switch') await context.cancelSwitch();
    if (outcome === 'destination-archived') await context.catalog.archive('target');
    return { text: 'Source turn finished', session: 'source-chat', cumulativeCost: 0 };
  });
  await fixture.bot.handle(message('Switch project')); await fixture.bot.idle();
  assert.equal(requested, true); assert.equal(calls, 1); assert.equal(fixture.store.data.project, 'default'); assert.equal(fixture.store.data.tasks!.length, 1);
});

test('self-deletion is deferred until the task and its source artifacts finish', async () => {
  const fixture = await setup(async request => {
    const context = projects(request); await context.requestClose('default', 'trash');
    assert.equal((await context.catalog.get('default')).status, 'active');
    return { text: 'Project moved to Trash after this turn.', session: 'source-chat', cumulativeCost: 0 };
  });
  await fixture.bot.handle(message('Delete this project')); await fixture.bot.idle();
  assert.equal(fixture.store.data.projects!.find(p => p.id === 'default')!.status, 'trashed');
  assert.notEqual(fixture.store.data.project, 'default');
  assert.ok((await lstat(path.join(fixture.dir, 'workspaces/default'))).isDirectory());
  assert.equal(fixture.store.data.tasks![0].status, 'completed');
});

test('a newer owner instruction cancels a pending switch and reaches the same active conversation', async () => {
  let release!: () => void, requested!: () => void, calls = 0;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { requested = r; });
  const fixture = await setup(async (request, emit, abort) => {
    calls++; const context = projects(request); await context.catalog.create({ id: 'other', name: 'Other' });
    await context.requestSwitch('other', 'Old continuation'); requested(); await gate;
    await request.steering!.settled(abort.signal);
    assert.equal(context.pending(), false);
    assert.match(request.steering!.messages[0].text, /Stay here/);
    assert.match(request.steering!.messages[0].text, /pending project change was cancelled/);
    const ids = request.steering!.messages.map(m => m.id); request.steering!.acknowledge(ids); await emit({ type: 'steered', ids });
    return { text: 'Staying in the current project.', session: 'source-chat', cumulativeCost: 0 };
  });
  await fixture.bot.handle(message('Switch projects')); await ready;
  await fixture.bot.handle(message('Stay here and change the plan')); release(); await fixture.bot.idle();
  assert.equal(calls, 1); assert.equal(fixture.store.data.project, 'default');
  assert.equal(fixture.store.data.tasks![0].steers![0].status, 'answered');
});

test('a switch without a continuation selects the target for the next owner message only', async () => {
  let calls = 0;
  const fixture = await setup(async request => {
    calls++; const context = projects(request);
    if (calls === 1) { await context.catalog.create({ id: 'new-work', name: 'New Work' }); await context.requestSwitch('new-work'); }
    else assert.equal(request.cwd, path.join(fixture.dir, 'workspaces/new-work'));
    return { text: 'Done', session: 'chat-' + calls, cumulativeCost: 0 };
  });
  await fixture.bot.handle(message('Switch only')); await fixture.bot.idle(); assert.equal(calls, 1);
  assert.equal(fixture.store.data.project, 'new-work');
  await fixture.bot.handle(message('Now continue here')); await fixture.bot.idle(); assert.equal(calls, 2);
});

test('an expired inherited deadline cannot launch a continuation in another project', async () => {
  let calls = 0;
  const fixture = await setup(async request => {
    calls++; const context = projects(request); await context.catalog.create({ id: 'target', name: 'Target' });
    await context.requestSwitch('target', 'Remaining work');
    fixture.store.data.tasks![0].deadlineAt = new Date(Date.now() - 1000).toISOString();
    return { text: 'Time used', session: 'source-chat', cumulativeCost: 0 };
  });
  await fixture.bot.handle(message('Switch and continue')); await fixture.bot.idle();
  assert.equal(calls, 1); assert.equal(fixture.store.data.project, 'default');
  assert.match(fixture.replies.join('\n'), /time limit/);
});
