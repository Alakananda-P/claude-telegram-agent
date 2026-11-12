import test from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeRunner, type AgentEvent, type QueryFactory } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { ChatArchive } from '../src/chats.js';
import { SessionCatalog, SESSION_TOOL_NAMES } from '../src/sessions.js';
import { MEMORY_TOOL_NAMES } from '../src/memory-tools.js';
import { SteeringInput } from '../src/steering.js';
import { Automation } from '../src/automation.js';

const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only-not-real' });

test('runner uses an open input stream for conversational steering', async () => {
  const make: QueryFactory = ({ prompt }) => {
    assert.notEqual(typeof prompt, 'string');
    return { async *[Symbol.asyncIterator]() { yield init as SDKMessage; yield result as unknown as SDKMessage; }, close() {} };
  };
  await new ClaudeRunner(config, make).run({ prompt: 'Hello', cwd: '/work' }, () => {}, new AbortController());
});

test('ordinary assistant progress is emitted while raw reasoning and subagent text stay private', async () => {
  const events: AgentEvent[] = [];
  const assistant = { type: 'assistant', uuid: 'msg-1', session_id: 'session-1', parent_tool_use_id: null, message: { id: 'msg-1', model: config.model, content: [{ type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text: 'I found the totals; checking the dates next.' }, { type: 'tool_use', name: 'Read', id: 'tool-1', input: {} }] } };
  await new ClaudeRunner(config, factory([init, assistant, assistant, { ...assistant, parent_tool_use_id: 'subagent' }, result])).run({ prompt: 'Check bills', cwd: '/work' }, e => { events.push(e); }, new AbortController());
  assert.equal(events.filter(e => e.type === 'commentary').length, 1);
  assert.ok(JSON.stringify(events).includes('checking the dates')); assert.ok(!JSON.stringify(events).includes('PRIVATE REASONING'));
});
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

test('late steering survives the first result and finishes in the same SDK conversation', async () => {
  const steering = new SteeringInput(); let sends = 0; let closed = 0; const events: AgentEvent[] = [];
  const make: QueryFactory = ({ prompt }) => ({ async *[Symbol.asyncIterator]() {
    assert.notEqual(typeof prompt, 'string'); const incoming = (prompt as AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>)[Symbol.asyncIterator]();
    const first = (await incoming.next()).value!; sends++; yield init as SDKMessage;
    const release = steering.reserve(); assert.ok(release);
    const update = steering.add('Use CSV instead'); release();
    yield { ...result, user_message_uuids: [first.uuid], queued_turn_count: 1 } as unknown as SDKMessage;
    const second = (await incoming.next()).value!; sends++; assert.equal(second.uuid, update.id); assert.equal(second.priority, 'next');
    yield { ...result, uuid: 'result-two', result: 'CSV ready', user_message_uuids: [second.uuid], total_cost_usd: 0.15, queued_turn_count: 0 } as unknown as SDKMessage;
  }, close() { closed++; } });
  const output = await new ClaudeRunner(config, make).run({ prompt: 'Make Excel', cwd: '/work', steering }, e => { events.push(e); }, new AbortController());
  assert.equal(output.text, 'CSV ready'); assert.equal(sends, 2); assert.equal(closed, 1); assert.equal(steering.messages[0].answered, true);
  assert.deepEqual(events.filter(e => e.type === 'usage').map(e => e.cost), [0.1, 0.15]);
});

test('a notification-only completion cannot finish the pending human turn', async () => {
  const make: QueryFactory = ({ prompt }) => ({ async *[Symbol.asyncIterator]() {
    const incoming = (prompt as AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>)[Symbol.asyncIterator]();
    const first = (await incoming.next()).value!; yield init as SDKMessage;
    yield { ...result, origin: { kind: 'task-notification' }, result: '', user_message_uuids: ['background-only'] } as unknown as SDKMessage;
    yield { ...result, uuid: 'human-reply', result: 'Your job is still running.', user_message_uuids: [first.uuid] } as unknown as SDKMessage;
  }, close() {} });
  const answer = await new ClaudeRunner(config, make).run({ prompt: 'Kam ho rha h?', cwd: '/work' }, () => {}, new AbortController());
  assert.equal(answer.text, 'Your job is still running.');
});

test('a merged notification placeholder triggers one same-session response correction without replaying actions', async () => {
  const steering = new SteeringInput(); const seen: AgentEvent[] = []; let options!: Options;
  const make: QueryFactory = request => { options = request.options; return { async *[Symbol.asyncIterator]() {
    const incoming = (request.prompt as AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>)[Symbol.asyncIterator]();
    const first = (await incoming.next()).value!; yield init as SDKMessage;
    const owner = steering.add('Kam ho rha h?'); const sent = (await incoming.next()).value!; assert.equal(sent.uuid, owner.id);
    yield { type: 'assistant', parent_tool_use_id: null, uuid: 'placeholder', session_id: 'session-1', message: { id: 'placeholder', model: config.model, content: [{ type: 'text', text: 'No response requested.' }] } } as unknown as SDKMessage;
    yield { ...result, result: 'No response requested.', origin: { kind: 'task-notification' }, user_message_uuids: [first.uuid, owner.id] } as unknown as SDKMessage;
    assert.equal(owner.answered, undefined);
    const reminder = (await incoming.next()).value!;
    assert.equal(reminder.isSynthetic, true); assert.equal(reminder.client_composed, true); assert.equal(reminder.origin, undefined);
    assert.match(String(reminder.message.content), /do not repeat completed actions/i);
    const hook = options.hooks!.PreToolUse![0].hooks[0];
    const permission = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, tool_use_id: 'unsafe', session_id: 'session-1', transcript_path: '', cwd: '/work' }, undefined, { signal: new AbortController().signal });
    assert.equal((permission as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
    yield { ...result, uuid: 'fixed', result: 'Haan, job is running. The last check was successful.', user_message_uuids: [reminder.uuid] } as unknown as SDKMessage;
  }, close() {} }; };
  const answer = await new ClaudeRunner(config, make).run({ prompt: 'Monitor job', cwd: '/work', steering }, e => { seen.push(e); }, new AbortController());
  assert.match(answer.text, /job is running/); assert.equal(steering.messages[0].answered, true);
  assert.ok(!seen.some(e => e.type === 'commentary' && /No response requested/.test(e.text)));
});

test('repeated empty human completions fail clearly instead of silently consuming the instruction', async () => {
  const make: QueryFactory = ({ prompt }) => ({ async *[Symbol.asyncIterator]() {
    const incoming = (prompt as AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>)[Symbol.asyncIterator]();
    const first = (await incoming.next()).value!; yield init as SDKMessage;
    yield { ...result, result: 'No response requested.', user_message_uuids: [first.uuid] } as unknown as SDKMessage;
    const reminder = (await incoming.next()).value!;
    yield { ...result, uuid: 'empty-twice', result: '', user_message_uuids: [reminder.uuid] } as unknown as SDKMessage;
  }, close() {} });
  await assert.rejects(new ClaudeRunner(config, make).run({ prompt: 'Please answer', cwd: '/work' }, () => {}, new AbortController()), /did not answer|unanswered/i);
});

test('a failed input preparation racing with the last result cannot leave the conversation open', async () => {
  const steering = new SteeringInput(); const settled = steering.settled.bind(steering); let raced = false;
  steering.settled = async signal => { await settled(signal); if (!raced) { raced = true; queueMicrotask(() => { const release = steering.reserve()!; setTimeout(release, 10); }); } };
  await new ClaudeRunner(config, factory([init, result])).run({ prompt: 'Task', cwd: '/work', steering }, () => {}, new AbortController());
  assert.equal(steering.accepting, false);
});

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

test('synthetic API failures report authentication or billing instead of a false model change, and keep accounting', async () => {
  for (const [error, text, expected] of [
    ['authentication_failed', 'private upstream error', /API key.*rejected/i],
    ['billing_error', 'private upstream error', /billing|credit/i],
    ['invalid_request', 'Your credit balance is too low to access the Anthropic API.', /credit/i],
    ['rate_limit', 'private upstream error', /rate limit/i],
    [undefined, 'private upstream error', /API request failed/i],
  ] as const) {
    const seen: AgentEvent[] = [];
    const synthetic = { type: 'assistant', error, parent_tool_use_id: null, session_id: 'session-1', uuid: 'synthetic',
      message: { id: 'error-message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }], usage: result.usage } };
    const failedResult = { ...result, subtype: 'error_during_execution', is_error: true, errors: ['private upstream error'] };
    await assert.rejects(new ClaudeRunner(config, factory([init, synthetic, failedResult])).run({ prompt: 'x', cwd: '/work' }, e => { seen.push(e); }, new AbortController()),
      e => e instanceof Error && expected.test(e.message) && !e.message.includes('private upstream error') && !e.message.includes('model changed'));
    assert.ok(seen.some(e => e.type === 'usage' && e.cost === 0.1));
  }
});

test('SDK stream errors after a synthetic error retain the safe root cause', async () => {
  const makeQuery: QueryFactory = () => ({ async *[Symbol.asyncIterator]() {
    yield init as SDKMessage;
    yield { type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null,
      message: { model: '<synthetic>', content: [] }, session_id: 'session-1' } as unknown as SDKMessage;
    throw new Error('private raw SDK error');
  }, close() {} });
  await assert.rejects(new ClaudeRunner(config, makeQuery).run({ prompt: 'x', cwd: '/work' }, () => {}, new AbortController()), /API key.*rejected/i);
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

test('only registered session and enabled memory tools receive automatic approval', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-agent-tools-'));
  const store = await StateStore.open(path.join(dataDir, 'state.json'));
  const sessions = new SessionCatalog(store, new ChatArchive(path.join(dataDir, 'chats'), []), []);
  for (const memoryEnabled of [true, false]) {
    let options!: Options;
    await new ClaudeRunner({ ...config, dataDir }, factory([init, result], o => { options = o; }))
      .run({ prompt: 'x', cwd: '/work', sessions, memoryEnabled }, () => {}, new AbortController());
    assert.ok(options.mcpServers!.sessions);
    assert.equal(Boolean(options.mcpServers!.memory), memoryEnabled);
    const expected = [...SESSION_TOOL_NAMES, ...(memoryEnabled ? MEMORY_TOOL_NAMES : [])];
    assert.deepEqual(options.allowedTools, expected);
    const toolOptions = { signal: new AbortController().signal, toolUseID: '1', requestId: '1' };
    for (const name of expected) assert.equal((await options.canUseTool!(name, {}, toolOptions))?.behavior, 'allow');
    for (const name of ['Bash', 'mcp__sessions__delete_all', ...(memoryEnabled ? [] : MEMORY_TOOL_NAMES)]) {
      assert.equal((await options.canUseTool!(name, {}, toolOptions))?.behavior, 'deny');
    }
  }
});

test('background script execution stays available but never receives a blanket permission bypass', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'background-permission-')); const store = await StateStore.open(path.join(root, 'state.json'));
  let options!: Options;
  await new ClaudeRunner(config, factory([init, result], o => { options = o; })).run({ prompt: 'Monitor work', cwd: root, workspace: { root, project: 'default', automation: new Automation(store), deliver: async () => {}, backup: async () => {} } }, () => {}, new AbortController());
  assert.ok(!options.allowedTools!.includes('mcp__workspace__start_background_job'));
  assert.ok(options.allowedTools!.includes('mcp__workspace__read_background_job'));
  assert.equal(options.permissionMode, 'auto');
  const decision = await options.canUseTool!('mcp__workspace__start_background_job', { script: 'monitor.py' }, { signal: new AbortController().signal, toolUseID: 'bg', requestId: 'bg' });
  assert.equal(decision?.behavior, 'deny'); assert.equal(options.allowDangerouslySkipPermissions, undefined);
  await options.canUseTool!('Bash', { command: 'denied command' }, { signal: new AbortController().signal, toolUseID: 'shell', requestId: 'shell' });
  const hook = options.hooks!.PreToolUse![0].hooks[0];
  const denied = await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__workspace__start_background_job', tool_input: {}, tool_use_id: 'bypass', session_id: 'session-1', transcript_path: '', cwd: root }, undefined, { signal: new AbortController().signal });
  assert.equal((denied as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
});


test('structured safety refusal and SDK fallback stop cleanly without accepting another model or leaking provider explanation', async () => {
  for (const frame of [
    { type: 'system', subtype: 'model_refusal_fallback', scope: 'session', original_model: config.model, fallback_model: 'claude-sonnet-5-5', api_refusal_category: 'cyber', api_refusal_explanation: 'PRIVATE DETAIL', session_id: 'session-1', uuid: 'refusal' },
    { ...result, stop_reason: 'refusal', result: 'PRIVATE DETAIL' }
  ]) {
    const events: AgentEvent[] = [];
    await assert.rejects(new ClaudeRunner(config, factory([init, frame, result])).run({ prompt: 'Hello', cwd: '/work' }, e => { events.push(e); }, new AbortController()), (e: any) => { assert.equal(e.name,'AgentSafetyError'); assert.match(e.message, /safety/i); assert.doesNotMatch(e.message,/PRIVATE DETAIL|model changed unexpectedly/); return true; });
    assert.ok(!JSON.stringify(events).includes('PRIVATE DETAIL'));
  }
});


test('refused stream retains usage accounting and never publishes refused text', async () => {
  const events: AgentEvent[]=[];
  const assistant={type:'assistant',uuid:'refused',session_id:'session-1',parent_tool_use_id:null,message:{id:'m',model:config.model,stop_reason:'refusal',content:[{type:'text',text:'PRIVATE REFUSED TEXT'}]}};
  await assert.rejects(new ClaudeRunner(config,factory([init,assistant,{...result,stop_reason:'refusal'}])).run({prompt:'x',cwd:'/work'},e=>{events.push(e);},new AbortController()),/safety/);
  assert.equal(events.filter(e=>e.type==='usage').length,1);assert.ok(!JSON.stringify(events).includes('PRIVATE REFUSED TEXT'));
});


test('local subagent refusal does not misclassify the main task as refused', async () => {
  const frames = [init,{type:'stream_event',parent_tool_use_id:'subtask',session_id:'session-1',uuid:'sub-refusal',event:{type:'message_delta',delta:{stop_reason:'refusal'},usage:{output_tokens:1}}},{type:'system',subtype:'model_refusal_fallback',scope:'local',session_id:'session-1',uuid:'local',api_refusal_category:'cyber'},result];
  const response = await new ClaudeRunner(config,factory(frames)).run({prompt:'Task',cwd:'/work'},()=>{},new AbortController());assert.equal(response.text,result.result);
});
