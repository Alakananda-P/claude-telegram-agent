import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '../src/config.js';
import { Controller } from '../src/controller.js';
import { LiveSteerResponder, type QuickResponder } from '../src/live-steer.js';
import type { AgentRequest, QueryFactory } from '../src/agent.js';
import { StateStore } from '../src/state.js';
import type { Message } from '../src/safety.js';

const env = (dataDir: string, extra: Record<string, string> = {}) => ({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dataDir, ...extra });
const message = (text: string): Message => ({ message_id: Math.floor(Math.random() * 1e6), date: 1, chat: { id: 123, type: 'private' }, from: { id: 123, is_bot: false, first_name: 'Owner' }, text } as Message);
const result = { type: 'result', subtype: 'success', is_error: false, result: 'Got it, I will switch to CSV next.', session_id: 'fork-1', uuid: 'live-result', total_cost_usd: 0.001, modelUsage: {} };
const factory = (events: unknown[], capture: (o: Options) => void = () => {}): QueryFactory => ({ options }) => {
  capture(options);
  return { async *[Symbol.asyncIterator]() { for (const e of events) { if (e instanceof Error) throw e; yield e as SDKMessage; } }, close() {} };
};

test('LIVE_STEER is validated and defaults to on', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-live-'));
  assert.equal(loadConfig(env(dataDir)).liveSteer, true);
  assert.equal(loadConfig(env(dataDir, { LIVE_STEER: 'false' })).liveSteer, false);
  assert.throws(() => loadConfig(env(dataDir, { LIVE_STEER: 'maybe' })), /LIVE_STEER must be true or false/);
});

test('the live responder forks the running session, denies every tool and keeps the main tool list for the prompt cache; failures return null', async () => {
  const config = loadConfig(env(await mkdtemp(path.join(tmpdir(), 'tg-live-'))));
  let options!: Options;
  const reply = await new LiveSteerResponder(config, undefined, factory([result], o => { options = o; })).reply({ session: 'main-session', cwd: config.dataDir, model: 'claude-opus-5-5', text: 'use CSV instead' }, new AbortController().signal);
  assert.equal(reply, 'Got it, I will switch to CSV next.');
  assert.equal(options.resume, 'main-session'); assert.equal(options.forkSession, true); assert.equal(options.model, 'claude-opus-5-5');
  assert.deepEqual(options.tools, { type: 'preset', preset: 'claude_code' }); assert.deepEqual(options.allowedTools, []); assert.equal(options.maxTurns, 2); assert.equal(options.persistSession, false); assert.deepEqual(options.settingSources, []);
  assert.equal((await options.canUseTool!('Bash', {}, { signal: new AbortController().signal } as never))?.behavior, 'deny');
  assert.equal(await new LiveSteerResponder(config, undefined, factory([new Error('network')])).reply({ session: 's', cwd: config.dataDir, model: 'm', text: 'hi' }, new AbortController().signal), null);
  assert.equal(await new LiveSteerResponder(config, undefined, factory([{ ...result, subtype: 'error_during_execution', is_error: true, result: '' }])).reply({ session: 's', cwd: config.dataDir, model: 'm', text: 'hi' }, new AbortController().signal), null);
  // A reply that never arrives is cut off by the timeout.
  const hang: QueryFactory = ({ options: o }) => ({ async *[Symbol.asyncIterator]() { await new Promise((_r, reject) => o.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted')))); }, close() {} });
  assert.equal(await new LiveSteerResponder(config, undefined, hang, undefined, 20).reply({ session: 's', cwd: config.dataDir, model: 'm', text: 'hi' }, new AbortController().signal), null);
});

async function setup(live: QuickResponder, extra: Record<string, string> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-live-controller-'));
  const config = loadConfig(env(dataDir, extra));
  const store = await StateStore.open(path.join(dataDir, 'bot', 'state.json'));
  const replies: string[] = [];
  const sender = { async send(_chat: number, text: string) { replies.push(text); }, async temporary() { return 99; }, async edit() {}, async remove() {}, async typing() {},
    async clear() { return true; }, async queueClear() {}, async panel(_chat: number, text: string) { replies.push(text); }, async acknowledge() {} };
  let began!: () => void; let release!: () => void; let current!: AgentRequest;
  const started = new Promise<void>(r => { began = r; }); const finish = new Promise<void>(r => { release = r; });
  const frames: SDKUserMessage[] = [];
  const runner = { async run(request: AgentRequest, emit: (e: never) => Promise<void>) {
    current = request; await emit({ type: 'session', id: 'main-session' } as never); began();
    const abort = new AbortController();
    const reading = (async () => { try { for await (const frame of request.steering!.stream('start', abort.signal)) frames.push(frame); } catch { /* closed */ } })();
    await finish; abort.abort(); await reading;
    return { session: 'main-session', text: 'Main task done', cumulativeCost: 0 };
  } };
  const bot = new Controller(config, store, sender as never, runner, undefined, undefined, undefined, undefined, live);
  return { bot, replies, frames, started, release: () => release(), steering: () => current.steering!, config };
}
const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(check()); };

test('a text steer gets a quick live reply while the main task keeps running, then a note follows the steer', async () => {
  const seen: { session: string; model: string; text: string }[] = [];
  const fixture = await setup({ async reply(request) { seen.push(request); return 'Okay, switching to CSV in the next step.'; } });
  await fixture.bot.handle(message('Read bills')); await fixture.started;
  try {
    await fixture.bot.handle(message('Use CSV instead'));
    await until(() => fixture.frames.length >= 3);
    assert.deepEqual(seen.map(s => [s.session, s.text]), [['main-session', 'Use CSV instead']]); assert.ok(seen[0].model);
    assert.ok(fixture.replies.includes('Okay, switching to CSV in the next step.'));
    assert.match(String(fixture.frames[1].message.content), /Use CSV instead/);
    assert.match(String(fixture.frames[2].message.content), /^\[Live reply already sent to the owner: Okay, switching to CSV/);
    assert.equal(fixture.frames[2].isSynthetic, true);
    assert.ok(!fixture.replies.includes('Main task done'));
  } finally { fixture.release(); await fixture.bot.idle(); }
  assert.ok(fixture.replies.includes('Main task done'));
});

test('LIVE_STEER=false keeps the steer but sends no live reply', async () => {
  let asked = 0;
  const fixture = await setup({ async reply() { asked++; return 'should not send'; } }, { LIVE_STEER: 'false' });
  await fixture.bot.handle(message('Read bills')); await fixture.started;
  try {
    await fixture.bot.handle(message('Use CSV instead'));
    await until(() => fixture.frames.length >= 2); await new Promise(r => setTimeout(r, 30));
    assert.equal(asked, 0); assert.equal(fixture.frames.length, 2); assert.ok(!fixture.replies.includes('should not send'));
  } finally { fixture.release(); await fixture.bot.idle(); }
});

test('a failed live reply sends nothing and adds no note; the steer still reaches the main task', async () => {
  let asked = 0;
  const fixture = await setup({ async reply() { asked++; throw new Error('provider down'); } });
  await fixture.bot.handle(message('Read bills')); await fixture.started;
  const before = fixture.replies.length;
  try {
    await fixture.bot.handle(message('Use CSV instead'));
    await until(() => fixture.frames.length >= 2 && asked === 1); await new Promise(r => setTimeout(r, 30));
    assert.equal(fixture.frames.length, 2); assert.match(String(fixture.frames[1].message.content), /Use CSV instead/);
    assert.equal(fixture.replies.length, before);
  } finally { fixture.release(); await fixture.bot.idle(); }
});
