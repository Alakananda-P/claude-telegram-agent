import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '../src/config.js';
import { HaikuTitles, TITLE_MODEL, TitleAccountingError } from '../src/titles.js';
import type { QueryFactory } from '../src/agent.js';
import { UsageLedger } from '../src/usage.js';
import { SharedMemory } from '../src/memory.js';

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tg-title-'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dataDir });
  const ledger = await UsageLedger.open(path.join(dataDir, 'usage.jsonl'));
  return { dataDir, config, ledger };
}
const init = { type: 'system', subtype: 'init', model: TITLE_MODEL };
const result = { type: 'result', subtype: 'success', is_error: false, result: 'October Tally bill import', session_id: 'title-request', uuid: 'title-result',
  total_cost_usd: 0.002, modelUsage: { [TITLE_MODEL]: { inputTokens: 500, outputTokens: 8, costUSD: 0.002 } } };
const factory = (events: unknown[], capture: (o: Options) => void = () => {}): QueryFactory => ({ options }) => {
  capture(options);
  return { async *[Symbol.asyncIterator]() { for (const e of events) yield e as SDKMessage; }, close() {} };
};

test('Haiku titles have no tools, resume, memory or Fast and their usage persists', async () => {
  const { config, ledger } = await setup();
  let options!: Options;
  const generator = new HaikuTitles(config, ledger, factory([init, result], o => { options = o; }));
  assert.equal(await generator.generate([{ role: 'user', text: 'Prepare bills' }], new AbortController().signal), result.result);
  assert.equal(options.model, TITLE_MODEL);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.resume, undefined);
  assert.equal(options.persistSession, false);
  assert.deepEqual(options.settings, { fastMode: false });
  assert.equal(options.env!.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(options.env!.GITHUB_TOKEN, undefined);
  const reloaded = await UsageLedger.open(ledger.file);
  assert.match(reloaded.report('tokens'), /500/);
  assert.match(reloaded.report('cost'), /0.002/);
});

test('title failures preserve billable usage, do not return error text and never mask storage failures', async () => {
  const { config, ledger } = await setup();
  const failure = { ...result, subtype: 'error_during_execution', is_error: true, errors: ['PRIVATE DATA'] };
  assert.equal(await new HaikuTitles(config, ledger, factory([init, failure])).generate([], new AbortController().signal), null);
  assert.match(ledger.report('cost'), /0.002/);
  assert.equal(await new HaikuTitles(config, ledger, factory([{ ...init, model: 'wrong-model' }, result])).generate([], new AbortController().signal), null);
  ledger.recordResult = async () => { throw new Error('private filesystem details'); };
  await assert.rejects(new HaikuTitles(config, ledger, factory([init, result])).generate([], new AbortController().signal), TitleAccountingError);
});

test('memory additions serialize, deduplicate and support exact correction or forgetting', async () => {
  const { dataDir } = await setup();
  const memory = new SharedMemory(dataDir, ['do-not-store-secret']);
  await Promise.all([memory.remember('Use Hindi'), memory.remember('Prefer Excel files')]);
  await memory.remember('Use Hindi');
  assert.equal((await memory.read()).split('Use Hindi').length, 2);
  await memory.replace('Use Hindi', 'Use Hinglish');
  assert.match(await memory.read(), /Use Hinglish/);
  assert.match(await memory.read(), /Prefer Excel files/);
  await memory.replace('- Prefer Excel files\n', '');
  assert.doesNotMatch(await memory.read(), /Excel/);
  await assert.rejects(memory.replace('missing', 'x'), /missing/);
  await assert.rejects(memory.remember('do-not-store-secret'), /credentials/);
});
