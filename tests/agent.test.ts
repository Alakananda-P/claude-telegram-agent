import test from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeRunner, type AgentEvent, type QueryFactory } from '../src/agent.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only-not-real' });
const init = { type: 'system', subtype: 'init', model: 'claude-opus-5-5', permissionMode: 'auto', effort: 'high', fast_mode_state: 'on',
  session_id: 'session-1', uuid: 'uuid-1', apiKeySource: 'env', claude_code_version: '2.1.314', cwd: '/work',
  tools: ['Bash', 'Read', 'Edit', 'Write'], mcp_servers: [], slash_commands: [], output_style: 'default', skills: [], plugins: [] };
const result = { type: 'result', subtype: 'success', is_error: false, duration_ms: 100, duration_api_ms: 90,
  num_turns: 1, result: 'Created hello.py', stop_reason: 'end_turn', total_cost_usd: 0.1,
  usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    server_tool_use: null, service_tier: 'standard', cache_creation: null, inference_geo: null, iterations: null, speed: 'standard' },
  modelUsage: {}, permission_denials: [], uuid: 'uuid-2', session_id: 'session-1' };

function factory(messages: unknown[], capture: (o: Options) => void = () => {}): QueryFactory {
  return ({ options }) => {
    capture(options);
    return { async *[Symbol.asyncIterator]() { for (const m of messages) yield m as SDKMessage; }, close() {} };
  };
}

test('runner passes exact requested settings, resume, limits and a filtered child environment', async () => {
  const events: AgentEvent[] = [];
  let options!: Options;
  const runner = new ClaudeRunner(config, factory([init, result], o => { options = o; }));
  const output = await runner.run({ prompt: 'Write code', cwd: '/work', session: 'old-session' }, e => { events.push(e); }, new AbortController());
  assert.equal(options.model, 'claude-opus-5-5');
  assert.deepEqual(options.settings, { fastMode: true });
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.effort, 'high');
  assert.equal(options.permissionMode, 'auto');
  assert.equal(options.resume, 'old-session');
  assert.equal(options.maxBudgetUsd, undefined);
  assert.equal(options.maxTurns, 50);
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.equal(options.env?.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(options.env?.ANTHROPIC_API_KEY, 'test-only-not-real');
  assert.equal(options.env?.ANTHROPIC_BASE_URL, undefined);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(output.text, 'Created hello.py');
  assert.equal(output.session, 'session-1');
  assert.ok(events.some(e => e.type === 'session' && e.id === 'session-1'));
});

test('runner rejects model or permission fallback and incomplete streams', async () => {
  for (const changed of [{ model: 'claude-sonnet-5' }, { permissionMode: 'default' }, { effort: 'low' }]) {
    const runner = new ClaudeRunner(config, factory([{ ...init, ...changed }, result]));
    await assert.rejects(runner.run({ prompt: 'x', cwd: '/work' }, () => {}, new AbortController()), /configuration/i);
  }
  await assert.rejects(new ClaudeRunner(config, factory([init])).run({ prompt: 'x', cwd: '/work' }, () => {}, new AbortController()), /result/i);
});

test('runner reports SDK failures without exposing raw error text', async () => {
  const seen: AgentEvent[] = [];
  const failure = { ...result, subtype: 'error_during_execution', is_error: true, errors: ['secret-value'], result: undefined };
  await assert.rejects(new ClaudeRunner(config, factory([init, failure])).run({ prompt: 'x', cwd: '/work' }, e => { seen.push(e); }, new AbortController()), /error_during_execution/);
  assert.ok(seen.some(e => e.type === 'usage' && e.cost === 0.1));
});

test('streaming records actual output counts without forwarding hidden reasoning', async () => {
  const seen: AgentEvent[] = [];
  const frame = (event: unknown) => ({ type: 'stream_event', session_id: 'session-1', parent_tool_use_id: null, uuid: 'frame', event });
  const messages = [init,
    frame({ type: 'message_start', message: { id: 'msg-real', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 1, speed: 'fast' } } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE REASONING' } }),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 123 } }),
    { ...result, fast_mode_state: 'on' }];
  await new ClaudeRunner(config, factory(messages)).run({ prompt: 'x', cwd: '/work' }, e => { seen.push(e); }, new AbortController());
  assert.ok(seen.some(e => e.type === 'step' && e.complete && e.usage.output_tokens === 123 && e.usage.speed === 'fast'));
  assert.ok(!JSON.stringify(seen).includes('PRIVATE REASONING'));
});

test('unresolved prompts deny instead of disabling auto safeguards', async () => {
  let options!: Options;
  await new ClaudeRunner(config, factory([init, result], o => { options = o; })).run({ prompt: 'x', cwd: '/work' }, () => {}, new AbortController());
  const decision = await options.canUseTool!('Bash', { command: 'anything' }, { signal: new AbortController().signal, toolUseID: '1', requestId: '1' });
  assert.equal(decision?.behavior, 'deny');
});

test('runner rejects a main-agent model change after initialization', async () => {
  const changed = { type: 'assistant', parent_tool_use_id: null, message: {
    id: 'msg-test', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [],
    stop_reason: 'end_turn', stop_sequence: null, usage: result.usage,
  }, session_id: 'session-1', uuid: 'uuid-3' };
  await assert.rejects(new ClaudeRunner(config, factory([init, changed, result])).run({ prompt: 'x', cwd: '/work' }, () => {}, new AbortController()), /model/i);
});
