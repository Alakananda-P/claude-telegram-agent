import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ResilientRunner } from '../src/recovery.js';
import { AgentApiError, ClaudeRunner, type AgentRequest, type Runner } from '../src/agent.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SteeringInput } from '../src/steering.js';

async function setup(factory: (key: string) => Runner) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-recovery-'));
  const store = await StateStore.open(path.join(dir, 'state.json'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'sk-ant-primary', ANTHROPIC_BACKUP_KEYS: '["sk-ant-backup"]', DATA_DIR: dir });
  return { store, runner: new ResilientRunner(config, store, c => factory(c.apiKey), 1) };
}

test('SDK teardown aborts only its attempt, so an authentication failure still reaches the approved backup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-real-teardown-')), store = await StateStore.open(path.join(dir, 'state.json'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'sk-ant-primary', ANTHROPIC_BACKUP_KEYS: '["sk-ant-backup"]', DATA_DIR: dir });
  const used: string[] = [], owner = new AbortController();
  const runner = new ResilientRunner(config, store, c => new ClaudeRunner(c, ({ options }) => {
    used.push(c.apiKey); const failed = c.apiKey.endsWith('primary');
    return { async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-' + used.length, model: c.model, permissionMode: 'auto', effort: c.effort } as unknown as SDKMessage;
      if (failed) yield { type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: 'Rejected' }] } } as unknown as SDKMessage;
      yield { type: 'result', subtype: 'success', is_error: false, session_id: 'sdk-' + used.length, uuid: 'result-' + used.length, result: failed ? 'Rejected' : 'Backup answered', modelUsage: {}, total_cost_usd: 0, permission_denials: [] } as unknown as SDKMessage;
    }, close() { options.abortController!.abort(); } };
  }), 0);
  const result = await runner.run({ prompt: 'Hello', cwd: dir, memoryEnabled: false }, () => {}, owner);
  assert.equal(result.text, 'Backup answered'); assert.deepEqual(used, ['sk-ant-primary', 'sk-ant-backup']);
  assert.equal(owner.signal.aborted, false); assert.equal(store.data.disabledKeyIds!.length, 1);
});
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
test('B2: a rate limit rests only that key; the next key takes over and only the last key retries once', async () => {
  const calls: string[] = [];
  const { runner, store } = await setup(key => ({ async run() { calls.push(key); throw new AgentApiError('rate_limit', 'Limited'); } }));
  await assert.rejects(runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController()), (e: AgentApiError) => e.kind === 'rate_limit' && /rate limit/.test(e.message));
  assert.deepEqual(calls, ['sk-ant-primary', 'sk-ant-backup', 'sk-ant-backup']); assert.deepEqual(store.data.disabledKeyIds, []);
  assert.ok(Object.values(store.data.keyRecords!).every(r => r.status === 'cooldown'));
  calls.length = 0;
  const next = await setup(key => ({ async run() { calls.push(key); if (key.endsWith('primary')) throw new AgentApiError('rate_limit', 'Limited'); return { session: 's', text: 'ok', cumulativeCost: 0 }; } }));
  assert.equal((await next.runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController())).text, 'ok');
  assert.deepEqual(calls, ['sk-ant-primary', 'sk-ant-backup']);
  calls.length = 0; assert.equal((await next.runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController())).text, 'ok');
  assert.deepEqual(calls, ['sk-ant-backup'], 'a later task skips the cooling key instead of failing as account_restricted');
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


test('safety refusals never rotate keys or replay the task automatically', async () => {
  const { AgentSafetyError } = await import('../src/agent.js'); let calls=0;
  const {runner,store}=await setup(()=>({async run(){calls++;throw new AgentSafetyError('cyber');}}));
  await assert.rejects(runner.run({prompt:'Current task',cwd:'.'},()=>{},new AbortController()),/safety system/);
  assert.equal(calls,1);assert.deepEqual(store.data.disabledKeyIds,[]);
});

test('M2: a busy API moves to the next key, and the last key gets one retry', async () => {
  const calls: string[] = []; let backupFailures = 0;
  const { runner } = await setup(key => ({ async run() {
    calls.push(key);
    if (key === 'sk-ant-primary' || backupFailures++ < 1) throw new AgentApiError('overloaded', 'Overloaded');
    return { text: 'ok', session: 's-' + calls.length, cumulativeCost: 0 };
  } }));
  const result = await runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController());
  assert.equal(result.text, 'ok'); assert.deepEqual(calls, ['sk-ant-primary', 'sk-ant-backup', 'sk-ant-backup']);
});
test('M2: with one key a busy API reports the real reason, not "all keys failed"', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-recovery-one-'));
  const store = await StateStore.open(path.join(dir, 'state.json'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'sk-ant-only', DATA_DIR: dir });
  let calls = 0; let busy = true;
  const runner = new ResilientRunner(config, store, () => ({ async run() { calls++; if (busy) throw new AgentApiError('server_error', 'Server error'); return { text: 'ok', session: 's', cumulativeCost: 0 }; } }), 1);
  await assert.rejects(runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController()), (e: unknown) => e instanceof AgentApiError && e.kind === 'server_error' && !/All eligible/.test(e.message));
  assert.equal(calls, 2, 'one retry on the same key');
  busy = false; calls = 0;
  assert.equal((await runner.run({ prompt: 'Hi', cwd: '.' }, () => {}, new AbortController())).text, 'ok', 'a busy key in short cooldown is still tried');
  assert.equal(calls, 1);
});
