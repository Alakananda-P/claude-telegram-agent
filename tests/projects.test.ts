import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/state.js';
import { Automation } from '../src/automation.js';
import { SessionCatalog } from '../src/sessions.js';
import { ChatArchive } from '../src/chats.js';
import { ProjectCatalog } from '../src/projects.js';
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-projects-'));
  const store = await StateStore.open(path.join(dir, 'bot/state.json'));
  const catalog: ProjectCatalog = new ProjectCatalog(dir, store, ['private-fixture-key']);
  return { dir, store, catalog };
}

test('legacy project discovery and display-name edits preserve files, sessions and stable directory IDs', async () => {
  const { dir, store, catalog } = await setup();
  await mkdir(path.join(dir, 'workspaces/tally-bills'), { recursive: true });
  await writeFile(path.join(dir, 'workspaces/tally-bills/bill.txt'), 'Original bill');
  store.data.sessions['tally-bills'] = 'saved-chat';
  store.data.conversations!.push({ id: 'saved-chat', project: 'tally-bills', updatedAt: new Date().toISOString(), title: 'Invoices' });
  await catalog.initialize();
  assert.equal((await catalog.list()).total, 2);
  const first = await catalog.list({ limit: 1 }); assert.equal(first.projects.length, 1); assert.equal(first.nextOffset, 1);
  assert.equal((await catalog.list({ offset: 1, limit: 1 })).projects.length, 1);
  const original = await catalog.workspace('tally-bills');
  await catalog.rename('tally-bills', 'Office Bills 2026');
  await catalog.update('tally-bills', { description: 'Supplier bills for the office.' });
  assert.equal(await catalog.workspace('tally-bills'), original);
  assert.equal(await readFile(path.join(original, 'bill.txt'), 'utf8'), 'Original bill');
  assert.equal(store.data.sessions['tally-bills'], 'saved-chat');
  assert.equal(store.data.conversations![0].project, 'tally-bills');
  const reopened = new ProjectCatalog(dir, await StateStore.open(store.file), []);
  assert.equal((await reopened.get('tally-bills')).name, 'Office Bills 2026');
  assert.equal((await reopened.list({ query: 'supplier' })).total, 1);
});

test('archive pauses future execution and restore keeps cancelled work for explicit review', async () => {
  const { dir, store, catalog } = await setup();
  const p = await catalog.create({ name: 'Billing App', id: 'billing' });
  await writeFile(path.join(await catalog.workspace(p.id), 'app.py'), 'print(42)');
  const automation = new Automation(store);
  const task = await automation.enqueue({ kind: 'agent', project: p.id, chatKey: 'draft-billing', prompt: 'Generate a report' });
  const schedule = await automation.createSchedule({ kind: 'agent', name: 'Report', project: p.id, prompt: 'Generate a report', intervalMinutes: 60 });
  await catalog.archive(p.id);
  assert.equal((await catalog.get(p.id)).status, 'archived');
  assert.equal(task.status, 'cancelled'); assert.equal(schedule.enabled, false);
  await assert.rejects(automation.retryTask(task.id), /project.*archived|restore.*project/i);
  await assert.rejects(automation.changeSchedule(schedule.id, 'resume'), /project.*archived|restore.*project/i);
  await catalog.restore(p.id);
  assert.equal(schedule.enabled, false); assert.equal(task.status, 'cancelled');
  assert.equal(await readFile(path.join(dir, 'workspaces/billing/app.py'), 'utf8'), 'print(42)');
  assert.equal((await catalog.get(p.id)).status, 'active');
});

test('project Trash hides its chats and restore does not extend an individually deleted chat deadline', async () => {
  const { dir, store, catalog } = await setup();
  await catalog.create({ name: 'Bills', id: 'bills' });
  const now = new Date();
  store.data.conversations!.push({ id: 'chat-a', project: 'bills', title: 'Bills', updatedAt: now.toISOString() },
    { id: 'chat-b', project: 'bills', title: 'Old', updatedAt: now.toISOString(), trashedAt: now.toISOString(), purgeAt: new Date(+now + 60000).toISOString() });
  const chats = new SessionCatalog(store, new ChatArchive(path.join(dir, 'bot/chats'), []), []);
  await catalog.trash('bills', now);
  assert.equal((await catalog.list()).projects.some(p => p.id === 'bills'), false);
  assert.equal(chats.list().sessions.length, 0);
  await assert.rejects(chats.read('chat-a'), /project.*Trash|restore.*project/i);
  assert.equal(chats.trashList().length, 0);
  assert.equal((await catalog.get('bills')).purgeAt, new Date(+now + 48 * 3600000).toISOString());
  await catalog.restore('bills', new Date(+now + 1000));
  assert.equal(chats.list().sessions.length, 1);
  assert.equal(store.data.conversations![1].purgeAt, new Date(+now + 60000).toISOString());
});

test('individual chat expiry still runs while its parent project is in Trash', async () => {
  const { dir, store, catalog } = await setup(); await catalog.create({ id: 'hidden', name: 'Hidden' });
  const now = new Date();
  store.data.conversations!.push({ id: 'old-chat', project: 'hidden', updatedAt: now.toISOString(), trashedAt: new Date(+now - 48 * 3600000).toISOString(), purgeAt: new Date(+now + 1000).toISOString() });
  const chats = new SessionCatalog(store, new ChatArchive(path.join(dir, 'bot/chats'), []), []);
  await catalog.trash('hidden', now);
  assert.equal(await chats.purgeExpired(new Date(+now + 2000)), 1);
  assert.equal(store.data.conversations!.length, 0); assert.equal((await catalog.get('hidden')).status, 'trashed');
});

test('purge removes only its project and linked content while keeping memory, usage and tombstones', async () => {
  const { dir, store, catalog } = await setup();
  await catalog.create({ name: 'Discard', id: 'discard' });
  await catalog.create({ name: 'Keep', id: 'keep' });
  await writeFile(path.join(await catalog.workspace('discard'), 'result.txt'), 'remove me');
  await writeFile(path.join(await catalog.workspace('keep'), 'sentinel.txt'), 'keep me');
  await writeFile(path.join(dir, 'memory.md'), 'Keep shared memory');
  await writeFile(path.join(dir, 'bot/usage.jsonl'), 'Keep accounting');
  const archive = new ChatArchive(path.join(dir, 'bot/chats'), []);
  await archive.append('discard-chat', { role: 'user', text: 'Private discarded chat' });
  store.data.conversations!.push({ id: 'discard-chat', project: 'discard', updatedAt: new Date().toISOString() });
  const now = new Date(); await catalog.trash('discard', now);
  assert.equal(await catalog.purgeExpired(new Date(+now + 48 * 3600000 - 1)), 0);
  assert.equal(await catalog.purgeExpired(new Date(+now + 48 * 3600000 + 1)), 1);
  await assert.rejects(lstat(path.join(dir, 'workspaces/discard')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(dir, 'workspaces/keep/sentinel.txt'), 'utf8'), 'keep me');
  assert.equal(await readFile(path.join(dir, 'memory.md'), 'utf8'), 'Keep shared memory');
  assert.equal(await readFile(path.join(dir, 'bot/usage.jsonl'), 'utf8'), 'Keep accounting');
  assert.equal((await archive.snapshot('discard-chat')).length, 0);
  assert.ok(store.data.purgedSessions!.includes('discard-chat'));
  assert.equal((await catalog.get('discard')).status, 'purged');
  await assert.rejects(catalog.workspace('discard'), /deleted|purged/i);
  await assert.rejects(catalog.restore('discard'), /deleted|purged/i);
  await assert.rejects(catalog.create({ name: 'New', id: 'discard' }), /exist|reserved|reuse/i);
});

test('closing a busy project refuses running model and background work', async () => {
  const { store, catalog } = await setup(); await catalog.create({ name: 'Busy', id: 'busy' });
  const task = await new Automation(store).enqueue({ kind: 'agent', project: 'busy', chatKey: 'chat', prompt: 'Work' });
  task.status = 'running';
  await assert.rejects(catalog.trash('busy'), /running|busy/i);
  await catalog.assertIdle('busy', task.id);
  task.status = 'completed';
  store.data.backgroundJobs = [{ id: 'a'.repeat(16), project: 'busy', chatKey: 'chat', name: 'Monitor', script: 'job.mjs', args: [], runtime: 'node', status: 'running', timeoutMs: 60000, createdAt: new Date().toISOString() }];
  await assert.rejects(catalog.archive('busy'), /background|running|busy/i);
  assert.equal((await catalog.get('busy')).status, 'active');
});

test('project purge also removes unbound drafts and fresh summaries after a failed first turn', async () => {
  const { dir, store, catalog } = await setup(); await catalog.create({ name: 'Draft', id: 'drafted' });
  const archive = new ChatArchive(path.join(dir, 'bot/chats'), []);
  store.data.drafts!['drafted'] = 'draft-private';
  store.data.freshContexts = { 'draft-private': 'Private previous work' };
  await archive.append('draft-private', { role: 'user', text: 'Private first request' });
  await catalog.trash('drafted'); await catalog.purge('drafted');
  assert.deepEqual(await archive.snapshot('draft-private'), []);
  assert.equal(store.data.freshContexts['draft-private'], undefined);
  assert.ok(store.data.purgedSessions!.includes('draft-private'));
});

test('permanent project purge discovers orphan SDK transcripts and their helper files without touching another project', async () => {
  const { dir, catalog, store } = await setup(); await catalog.create({ id: 'private-app', name: 'Private App' });
  const root = await catalog.workspace('private-app'), sdk = path.join(dir, 'claude/projects/sdk-folder');
  await mkdir(path.join(sdk, 'orphan-session/subagents'), { recursive: true });
  await writeFile(path.join(sdk, 'orphan-session.jsonl'), JSON.stringify({ type: 'user', cwd: root, message: { role: 'user', content: 'Unbound private turn' } }) + '\n');
  await writeFile(path.join(sdk, 'orphan-session/subagents/helper.jsonl'), 'private helper trace');
  await writeFile(path.join(sdk, 'other-session.jsonl'), JSON.stringify({ cwd: path.join(dir, 'workspaces/default') }) + '\n');
  await catalog.trash('private-app'); await catalog.purge('private-app');
  await assert.rejects(lstat(path.join(sdk, 'orphan-session.jsonl')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(sdk, 'orphan-session')), { code: 'ENOENT' });
  assert.ok(store.data.purgedSessions!.includes('orphan-session'));
  assert.ok((await lstat(path.join(sdk, 'other-session.jsonl'))).isFile());
});

test('an interrupted project purge can be retried without reusing its ID or deleting siblings', async () => {
  const { dir, catalog, store } = await setup(); await catalog.create({ id: 'retry-purge', name: 'Retry' });
  await writeFile(path.join(await catalog.workspace('default'), 'sentinel.txt'), 'keep');
  await catalog.trash('retry-purge');
  const save = store.save.bind(store); let failed = false;
  store.save = async () => {
    if (!failed && store.data.projects!.some(p => p.id === 'retry-purge' && p.status === 'purging')) { failed = true; throw new Error('disk fixture failure'); }
    return save();
  };
  await assert.rejects(catalog.purge('retry-purge'), /disk fixture/);
  await catalog.purgeExpired(); assert.equal((await catalog.get('retry-purge')).status, 'purged');
  assert.equal(await readFile(path.join(dir, 'workspaces/default/sentinel.txt'), 'utf8'), 'keep');
});

test('serialized project updates and duplicate creation survive restart without losing metadata', async () => {
  const { dir, store, catalog } = await setup(); await catalog.create({ name: 'App', id: 'app' });
  await Promise.all([catalog.rename('app', 'Invoice App'), catalog.update('app', { description: 'Saved description' })]);
  const results = await Promise.allSettled([catalog.create({ name: 'Second', id: 'second' }), catalog.create({ name: 'Second', id: 'second' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const reopened: ProjectCatalog = new ProjectCatalog(dir, await StateStore.open(store.file), []);
  assert.equal((await reopened.get('app')).name, 'Invoice App');
  assert.equal((await reopened.get('app')).description, 'Saved description');
});

test('project names and file listings keep credentials out and reject directory traversal', async () => {
  const { dir, store, catalog } = await setup();
  await assert.rejects(catalog.create({ name: 'private-fixture-key' }), /credential|secret|private/i);
  await assert.rejects(catalog.create({ name: 'Bad', id: '../outside' }), /project|ID|name|path/i);
  const p = await catalog.create({ name: 'Office', id: 'office' });
  await catalog.update(p.id, { description: 'Readable project details' });
  await assert.rejects(catalog.update(p.id, { description: 'password: hidden-value' }), /credential|secret|private/i);
  store.data.projects!.find(x => x.id === p.id)!.description = 'Legacy private-fixture-key';
  assert.ok(!JSON.stringify(await catalog.get(p.id)).includes('private-fixture-key'));
  const root = await catalog.workspace(p.id); await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, '.env'), 'private-fixture-key'); await writeFile(path.join(root, 'src/main.py'), 'print(1)');
  assert.ok(!(await catalog.listFiles(p.id)).files.some(f => f.path === '.env'));
  assert.deepEqual((await catalog.listFiles(p.id, { path: 'src' })).files.map(f => f.path), ['src/main.py']);
  await assert.rejects(catalog.listFiles(p.id, { path: '../office' }), /path|relative|directory/i);
  assert.equal(await readFile(path.join(dir, 'workspaces/office/.env'), 'utf8'), 'private-fixture-key');
});

test('expired project Trash cannot be restored or silently recreated as an empty workspace', async () => {
  const { catalog } = await setup(); await catalog.create({ name: 'Old', id: 'old' });
  const now = new Date(); await catalog.trash('old', now);
  await assert.rejects(catalog.restore('old', new Date(+now + 48 * 3600000 + 1)), /expired|deadline|48.hour/i);
  await assert.rejects(catalog.workspace('old'), /Trash|restore|trashed/i);
});

test('a missing registered workspace is reported instead of silently recreating lost files', async () => {
  const { dir, catalog } = await setup(); await catalog.create({ name: 'Missing', id: 'missing' });
  const { rm } = await import('node:fs/promises');
  const target = path.join(dir, 'workspaces/missing');
  assert.equal(path.dirname(path.resolve(target)), path.resolve(dir, 'workspaces'));
  await rm(target, { recursive: true });
  await assert.rejects(catalog.workspace('missing'), /missing|backup/i);
});

test('project purge rejects a symlink root and never follows nested links', { skip: process.platform === 'win32' }, async () => {
  const { dir, catalog } = await setup(); const outside = path.join(dir, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'sentinel'), 'keep');
  await catalog.create({ name: 'Nested', id: 'nested' });
  await symlink(outside, path.join(await catalog.workspace('nested'), 'link'));
  await catalog.trash('nested'); await catalog.purge('nested');
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
  await symlink(outside, path.join(dir, 'workspaces/escape'));
  await assert.rejects(catalog.workspace('escape', true), /symlink|directory/i);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
});
