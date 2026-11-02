import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ResilientRunner } from '../src/recovery.js';
import { AgentApiError, type AgentRequest, type Runner } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SteeringInput } from '../src/steering.js';

async function setup(factory: (key: string) => Runner) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-recovery-'));
  const store = await StateStore.open(path.join(dir, 'state.json'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'sk-ant-primary', ANTHROPIC_BACKUP_KEYS: '["sk-ant-backup"]', DATA_DIR: dir });
  return { store, runner: new ResilientRunner(config, store, c => factory(c.apiKey), 1) };
}
test('credit failure switches approved key before actions, drops signed resume and persists selection', async () => {
  const calls: { key: string; request: AgentRequest }[] = [];
  const { runner, store } = await setup(key => ({ async run(request, emit) {
    calls.push({ key, request });
    if (key.endsWith('primary')) throw new AgentApiError('billing_error', 'Credits exhausted');
    await emit({ type: 'session', id: 'fresh-session' }); return { session: 'fresh-session', text: 'Done', cumulativeCost: 0 };
  } }));
  await runner.run({ prompt: 'Continue', cwd: '.', session: 'old', resumeContext: 'user: prepare bills' }, () => {}, new AbortController());
  assert.equal(calls.length, 2); assert.equal(calls[1].request.session, undefined); assert.match(calls[1].request.prompt, /prepare bills/);
  const reopened = await StateStore.open(store.file); assert.equal(reopened.data.disabledKeyIds!.length, 1);
  assert.equal(reopened.data.sessionCredentials!['fresh-session'], createHash('sha256').update('sk-ant-backup').digest('hex').slice(0, 16));
});
test('no automatic replay after tools or output have started', async () => {
  let calls = 0;
  const { runner } = await setup(() => ({ async run(_r, emit) { calls++; await emit({ type: 'effect' }); throw new AgentApiError('authentication_failed', 'Rejected'); } }));
  await assert.rejects(runner.run({ prompt: 'Pay invoice', cwd: '.' }, () => {}, new AbortController()), /no automatic replay/i);
  assert.equal(calls, 1);
});

test('pre-effect key recovery retains steering input for the fresh attempt', async () => {
  const steering = new SteeringInput(); const update = steering.add('Use the corrected date'); const received: string[] = [];
  const { runner } = await setup(key => ({ async run(request, _emit, abort) {
    const input = request.steering!.stream(request.prompt, abort.signal); await input.next(); const next = (await input.next()).value!; received.push(next.uuid!); await input.return(undefined);
    if (key.endsWith('primary')) throw new AgentApiError('billing_error', 'No credits');
    steering.acknowledge([update.id]); steering.finish(); return { session: 'recovered', text: 'Corrected', cumulativeCost: 0 };
  } }));
  await runner.run({ prompt: 'Process bill', cwd: '.', steering }, () => {}, new AbortController()); assert.deepEqual(received, [update.id, update.id]);
});
test('rate limits retry the same key once and never rotate keys', async () => {
  const calls: string[] = [];
  const { runner, store } = await setup(key => ({ async run() { calls.push(key); throw new AgentApiError('rate_limit', 'Limited'); } }));
  await assert.rejects(runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController()), /Limited/);
  assert.deepEqual(calls, ['sk-ant-primary', 'sk-ant-primary']); assert.deepEqual(store.data.disabledKeyIds, []);
});
test('account holds and unclassified failures are never bypassed with another account', async () => {
  let calls = 0;
  const { runner } = await setup(() => ({ async run() { calls++; throw new AgentApiError('account_on_hold', 'Account hold'); } }));
  await assert.rejects(runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController()), /Account hold/); assert.equal(calls, 1);
});
test('restored archives start a fresh SDK session with bounded historical context', async () => {
  let actual: AgentRequest | undefined;
  const { runner, store } = await setup(() => ({ async run(request) { actual = request; return { session: 'fresh', text: 'Done', cumulativeCost: 0 }; } }));
  store.data.resumeDisabled = ['restored'];
  await runner.run({ cwd: '.', prompt: 'Continue', session: 'restored', resumeContext: 'past conversation' }, () => {}, new AbortController());
  assert.equal(actual!.session, undefined); assert.match(actual!.prompt, /past conversation/);
});
