import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KeyPool, messageProbe, type KeyProbe } from '../src/key-pool.js';
import { StateStore } from '../src/state.js';
import { loadConfig } from '../src/config.js';
import { ResilientRunner } from '../src/recovery.js';
import { AgentApiError } from '../src/agent.js';
import { UsageLedger } from '../src/usage.js';

async function setup(probe: KeyProbe = async () => ({ ok: true })) {
  const dir = await mkdtemp(path.join(tmpdir(), 'key-pool-'));
  const store = await StateStore.open(path.join(dir, 'state.json'));
  const keys = ['sk-ant-one', 'sk-ant-two', 'sk-ant-three', 'sk-ant-four', 'sk-ant-five'];
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: keys[0], ANTHROPIC_BACKUP_KEYS: JSON.stringify(keys.slice(1)), DATA_DIR: dir });
  let now = Date.parse('2026-11-01T00:00:00Z');
  const pool = new KeyPool(config, store, probe, () => now);
  await pool.initialize();
  return { pool, config, store, keys, advance: (ms: number) => { now += ms; } };
}

test('five-key routing is immediate, sticky and persists every failure and recovery', async () => {
  const { pool, config, store, keys } = await setup(); const calls: string[] = [];
  const runner = new ResilientRunner(config, store, c => ({ async run() {
    calls.push(c.apiKey);
    if (c.apiKey !== keys[4]) throw new AgentApiError('billing_error', 'Insufficient credit with secret details');
    return { session: 'chat', text: 'OK', cumulativeCost: 0 };
  } }), 0, pool);
  await runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController());
  await runner.run({ prompt: 'Again', cwd: '.' }, () => {}, new AbortController());
  assert.deepEqual(calls, [...keys, keys[4]]);
  const reopened = await StateStore.open(store.file);
  assert.equal(Object.values(reopened.data.keyRecords!).filter(r => r.status === 'no_credit').length, 4);
  assert.equal(reopened.data.keyRecords![pool.list()[4].id].successes, 2);
  const raw = await readFile(store.file, 'utf8');
  for (const key of keys) assert.ok(!raw.includes(key));
  assert.ok(!raw.includes('secret details'));
});

test('failed keys recheck after 30 minutes, recover without changing active key, and keep history', async () => {
  let probes = 0;
  const { pool, store, advance } = await setup(async () => { probes++; return { ok: true }; });
  for (const r of pool.list()) await pool.success(r.id);
  const [first, second] = pool.list(); store.data.activeKeyId = second.id;
  await pool.failure(first.id, 'billing_error');
  await pool.checkDue(); assert.equal(probes, 0);
  advance(30 * 60_000); await pool.checkDue(); assert.equal(probes, 1);
  assert.equal(pool.list()[0].status, 'healthy'); assert.equal(store.data.activeKeyId, second.id);
  assert.ok(!store.data.disabledKeyIds!.includes(first.id));
  assert.ok(pool.list()[0].history.some(h => h.event === 'recovered'));
  await pool.checkDue(); assert.equal(probes, 1);
});

test('rate limits and account holds cannot rotate on a later task; successful recheck clears them', async () => {
  const { pool, advance } = await setup(); const first = pool.list()[0];
  await pool.begin(first.id); await pool.failure(first.id, 'account_on_hold');
  assert.throws(() => pool.available(), /account_on_hold/);
  advance(30 * 60_000); await pool.checkDue();
  assert.equal(pool.available()[0].id, first.id);
  await pool.failure(first.id, 'rate_limit');
  assert.throws(() => pool.available(), /rate_limit/);
});

test('healthy checks are six-hourly, serialized and do not run during a user task', async () => {
  let probes = 0;
  const { pool, advance, store } = await setup(async () => { probes++; return { ok: true }; });
  await Promise.all([pool.checkDue(), pool.checkDue()]); assert.equal(probes, 5);
  await pool.checkDue(); assert.equal(probes, 5);
  advance(6 * 60 * 60_000);
  store.data.active = { id: 'active', project: 'default', startedAt: new Date().toISOString() };
  await pool.checkDue(); assert.equal(probes, 5);
  store.data.active = null; await pool.checkDue(); assert.equal(probes, 10);
});

test('all five failed keys stop after one attempt each, with no retry loop or model changes', async () => {
  const { pool, config, store } = await setup(); let calls = 0;
  const runner = new ResilientRunner(config, store, c => ({ async run() { calls++; assert.equal(c.model, config.model); throw new AgentApiError('server_error', 'Unavailable'); } }), 60_000, pool);
  await assert.rejects(runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController()), /All eligible/);
  assert.equal(calls, 5); assert.ok(pool.list().every(r => r.status === 'cooldown'));
  await assert.rejects(runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController()), /No eligible/);
  assert.equal(calls, 5);
});

test('owner refresh never blindly marks failed keys healthy and cannot hammer the API', async () => {
  let probes = 0; const { pool } = await setup(async () => { probes++; return { ok: false, kind: 'billing_error' }; });
  await pool.checkDue(); assert.equal(probes, 5);
  await pool.requestChecks(); await pool.checkDue(); assert.equal(probes, 5);
  assert.ok(pool.list().every(r => r.status === 'no_credit'));
});

test('a probe finishing after a task begins cannot overwrite its failure state', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const { pool, store } = await setup(async () => { await wait; return { ok: true }; });
  const checking = pool.checkDue();
  store.data.active = { id: 'job', project: 'default', startedAt: new Date().toISOString() };
  await pool.begin(pool.list()[0].id); await pool.failure(pool.list()[0].id, 'billing_error');
  release(); await checking;
  assert.equal(pool.list()[0].status, 'no_credit');
});

test('provider checks classify authentication, billing, restrictions and non-JSON outages safely', async () => {
  for (const [status, error, kind] of [[401, 'bad secret', 'authentication_failed'], [400, 'Your credit balance is too low', 'billing_error'], [403, 'Account on hold', 'account_on_hold'], [429, 'Limit', 'rate_limit'], [529, 'Overload', 'overloaded']] as const) {
    const probe = messageProbe(undefined, (async () => new Response(JSON.stringify({ error: { message: error } }), { status })) as typeof fetch);
    assert.deepEqual(await probe('private', new AbortController().signal), { ok: false, kind });
  }
  const probe = messageProbe(undefined, (async () => new Response('bad gateway', { status: 502 })) as typeof fetch);
  assert.equal((await probe('private', new AbortController().signal)).kind, 'server_error');
});

test('successful health checks add durable tokens and cost once without partial accounting', async () => {
  const { store } = await setup(); const ledger = await UsageLedger.open(path.join(path.dirname(store.file), 'usage.jsonl'));
  let id = 0;
  const probe = messageProbe(ledger, (async (_url: unknown, init: RequestInit) => {
    const payload = JSON.parse(init.body as string); assert.equal(payload.max_tokens, 1); assert.equal(payload.messages[0].content, 'Reply OK.');
    return new Response(JSON.stringify({ id: 'probe-' + ++id, model: 'claude-sonnet-5-5', usage: { input_tokens: 14, output_tokens: 1 } }));
  }) as typeof fetch);
  await probe('private', new AbortController().signal); await probe('private', new AbortController().signal);
  const reopened = await UsageLedger.open(ledger.file);
  assert.equal(reopened.totals().models['claude-sonnet-5-5'].inputTokens, 28);
  assert.ok(reopened.totals().costUSD > 0); assert.equal(reopened.totals().partial, false);
});

test('key history survives re-open, has usable pages, and never exposes key values', async () => {
  const { pool, config, store, keys } = await setup(); const id = pool.list()[0].id;
  for (let i = 0; i < 5; i++) { await pool.failure(id, 'billing_error'); await pool.success(id); }
  const reopened = new KeyPool(config, await StateStore.open(store.file));
  const view = reopened.panel(id, 0); assert.match(view.text, /History 1\/2/);
  assert.ok(view.buttons.flat().some(b => b.text === 'Older'));
  assert.match(reopened.panel(id, 1).text, /added/);
  for (const key of keys) assert.ok(!JSON.stringify(view).includes(key));
});
