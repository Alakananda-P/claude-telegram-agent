import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { authorized, chunks, redact, safeFile, projectName } from '../src/safety.js';
import { StateStore } from '../src/state.js';

const env = { TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only-not-real' };

test('missing or invalid owner and invalid execution limits fail closed', () => {
  assert.throws(() => loadConfig({ ...env, TELEGRAM_OWNER_ID: '' }), /TELEGRAM_OWNER_ID/);
  assert.throws(() => loadConfig({ ...env, TELEGRAM_OWNER_ID: '-1' }), /TELEGRAM_OWNER_ID/);
  assert.throws(() => loadConfig({ ...env, MAX_TURNS: 'NaN' }), /MAX_TURNS/);
  assert.throws(() => loadConfig({ ...env, JOB_TIMEOUT_MINUTES: '0' }), /JOB_TIMEOUT_MINUTES/);
});

test('obsolete budget environment values are ignored rather than imposing a cap', () => {
  const c = loadConfig({ ...env, MAX_BUDGET_USD: 'NaN', DAILY_BUDGET_USD: '0' });
  assert.equal(Object.hasOwn(c, 'maxBudget'), false);
  assert.equal(Object.hasOwn(c, 'dailyBudget'), false);
  assert.equal(c.maxTurns, 50);
});

test('config preserves requested model, effort and actual auto mode', () => {
  const c = loadConfig(env);
  assert.equal(c.model, 'claude-opus-5-5');
  assert.equal(c.fast, true);
  assert.equal(c.effort, 'high');
  assert.equal(c.permissionMode, 'auto');
  assert.throws(() => loadConfig({ ...env, CLAUDE_PERMISSION_MODE: 'bypassPermissions' }), /auto/);
});

test('only owner private chat messages authorize', () => {
  const m = { from: { id: 123 }, chat: { id: 123, type: 'private' } };
  assert.equal(authorized(m, 123), true);
  assert.equal(authorized({ ...m, from: { id: 124 } }, 123), false);
  assert.equal(authorized({ ...m, chat: { id: -123, type: 'group' } }, 123), false);
  assert.equal(authorized({ chat: m.chat }, 123), false);
});

test('chunks preserve Unicode and redaction masks secrets and token URLs', () => {
  const text = 'x'.repeat(3499) + '😀' + 'y'.repeat(4000);
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(x => x.length <= 3500 && !/[\uD800-\uDBFF]$/.test(x)));
  assert.equal(redact('secret-value and sk-ant-api03-abcdef', ['secret-value']), '[REDACTED] and [REDACTED]');
  assert.ok(!redact('https://api.telegram.org/bot12345:abcdefghijklmnopqrst/getMe', []).includes('abcdefghijklmnopqrst'));
});

test('file bridge rejects traversal, secrets, directories and missing files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-agent-files-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'hello.py'), 'print(1)');
  await writeFile(path.join(root, '.env'), 'SECRET=never');
  assert.equal(await safeFile(root, 'src/hello.py'), path.join(root, 'src', 'hello.py'));
  for (const p of ['../secret', '.env', 'src', '/etc/passwd', 'absent', '.git/config', 'key.pem']) {
    await assert.rejects(safeFile(root, p));
  }
});

test('project names cannot escape workspace', () => {
  assert.equal(projectName('my-app'), 'my-app');
  for (const p of ['../escape', 'a/b', '.env', '', 'has spaces']) assert.throws(() => projectName(p));
});

test('atomic state persists sessions and marks interrupted work on restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-agent-state-'));
  const file = path.join(root, 'state.json');
  const store = await StateStore.open(file);
  store.data.offset = 44;
  store.data.sessions.default = 'session-123';
  store.data.active = { id: 'job-1', project: 'default', startedAt: '2026-10-30T10:00:00Z' };
  await store.save();
  const reopened = await StateStore.open(file);
  assert.equal(reopened.data.offset, 44);
  assert.equal(reopened.data.sessions.default, 'session-123');
  assert.equal(reopened.data.active, null);
  assert.equal(reopened.data.lastJob?.status, 'interrupted');
  assert.equal(Object.hasOwn(reopened.data, 'daily'), false);
  await writeFile(file, '{bad');
  await assert.rejects(StateStore.open(file), /state/i);
});

test('legacy budget state migrates without losing offset or conversation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-agent-legacy-state-'));
  const file = path.join(root, 'state.json');
  await writeFile(file, JSON.stringify({ version: 1, offset: 44, project: 'default',
    sessions: { default: 'session-123' }, daily: { date: '2026-10-30', spent: 999 },
    active: { id: 'old-job', project: 'default', startedAt: '2026-10-30T10:00:00Z', reserved: 2 }, lastJob: null }));
  const store = await StateStore.open(file);
  assert.equal(store.data.offset, 44);
  assert.equal(store.data.sessions.default, 'session-123');
  assert.equal(store.data.lastJob?.status, 'interrupted');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(Object.hasOwn(saved, 'daily'), false);
  assert.equal(Object.hasOwn(saved.lastJob, 'reserved'), false);
});
