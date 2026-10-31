import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UsageLedger } from '../src/usage.js';

const usage = (cost: number, input = 100, output = 20) => ({ inputTokens: input, outputTokens: output,
  cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: cost, webSearchRequests: 0 });
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-usage-'));
  return { dir, ledger: await UsageLedger.open(path.join(dir, 'usage.jsonl')) };
}

test('cumulative sessions are replaced, models stay separate and restarts retain totals', async () => {
  const { dir, ledger } = await setup();
  await ledger.recordResult('s1', 'r1', { 'claude-sonnet-5-5': usage(1) }, 1);
  await ledger.recordResult('s1', 'r2', { 'claude-sonnet-5-5': usage(2, 200, 40), 'claude-opus-5-5': usage(4) }, 6);
  await ledger.recordResult('s1', 'r2', { 'claude-sonnet-5-5': usage(2, 200, 40), 'claude-opus-5-5': usage(4) }, 6);
  await ledger.recordResult('s2', 'r3', { 'claude-opus-5-5': usage(3) }, 3);
  const reopened = await UsageLedger.open(path.join(dir, 'usage.jsonl'));
  const totals = reopened.totals();
  assert.equal(totals.costUSD, 9);
  assert.equal(totals.models['claude-sonnet-5-5'].inputTokens, 200);
  assert.equal(totals.models['claude-opus-5-5'].costUSD, 7);
});

test('zero crash results cannot erase prior spend; streaming requests survive before a result', async () => {
  const { ledger } = await setup();
  await ledger.recordStep('s1', 'msg1', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 25, speed: 'fast' }, true);
  await ledger.recordStep('s1', 'msg1', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 25, speed: 'fast' }, true);
  assert.equal(ledger.totals().models['claude-opus-5-5'].outputTokens, 25);
  assert.ok(ledger.totals().costUSD > 0);
  await ledger.recordResult('s1', 'r1', { 'claude-opus-5-5': usage(1, 100, 25) }, 1);
  await ledger.recordResult('s1', 'r2', {}, 0);
  assert.equal(ledger.totals().costUSD, 1);
  assert.equal(ledger.totals().models['claude-opus-5-5'].outputTokens, 25);
});

test('history import reads accounting metadata, deduplicates, and never saves message contents', async () => {
  const { dir, ledger } = await setup();
  const history = path.join(dir, 'claude', 'projects', '-data-workspaces-default');
  await mkdir(history, { recursive: true });
  await writeFile(path.join(history, 'session-old.jsonl'), [
    { type: 'assistant', sessionId: 'session-old', message: { id: 'old-msg', model: 'claude-sonnet-5-5', usage: { input_tokens: 50, output_tokens: 1 }, content: [{ type: 'text', text: 'PRIVATE BILL CONTENT' }] } },
    { type: 'cost-state', sessionId: 'session-old', totalCostUSD: 0.5, modelUsage: { 'claude-sonnet-5-5': usage(0.5, 50, 30) } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  await ledger.importHistory(path.join(dir, 'claude', 'projects'));
  await ledger.importHistory(path.join(dir, 'claude', 'projects'));
  assert.equal(ledger.totals().costUSD, 0.5);
  assert.equal(ledger.totals().models['claude-sonnet-5-5'].outputTokens, 30);
  assert.ok(!(await readFile(path.join(dir, 'usage.jsonl'), 'utf8')).includes('PRIVATE BILL CONTENT'));
});

test('streaming usage replaces placeholders and earlier deltas even after reopening', async () => {
  const { dir, ledger } = await setup();
  await ledger.recordStep('s1', 'msg1', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 1, speed: 'fast' }, false);
  await ledger.recordStep('s1', 'msg1', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 10, speed: 'fast' }, true);
  await ledger.recordStep('s1', 'msg1', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 30, speed: 'fast' }, true);
  const reopened = await UsageLedger.open(path.join(dir, 'usage.jsonl'));
  assert.equal(reopened.totals().models['claude-opus-5-5'].inputTokens, 100);
  assert.equal(reopened.totals().models['claude-opus-5-5'].outputTokens, 30);
  assert.ok(Math.abs(reopened.totals().costUSD - 0.002) < 1e-9);
});

test('historical subagent rows are covered by their parent cost snapshot, regardless of file order', async () => {
  const { dir, ledger } = await setup();
  const history = path.join(dir, 'history');
  await mkdir(history);
  await writeFile(path.join(history, 'a.jsonl'), JSON.stringify({ type: 'cost-state', sessionId: 's1', totalCostUSD: 1, modelUsage: { 'claude-opus-5-5': usage(1) } }) + '\n');
  await writeFile(path.join(history, 'z.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 's1', message: { id: 'sub', model: 'claude-opus-5-5', usage: { input_tokens: 50, output_tokens: 1 } } }) + '\n');
  await ledger.importHistory(history);
  assert.equal(ledger.totals().models['claude-opus-5-5'].inputTokens, 100);
  assert.equal(ledger.totals().costUSD, 1);
});

test('history keeps partial requests written after the last cost-state snapshot', async () => {
  const { dir, ledger } = await setup();
  const history = path.join(dir, 'history'); await mkdir(history);
  await writeFile(path.join(history, 's1.jsonl'), [
    { type: 'cost-state', sessionId: 's1', totalCostUSD: 1, modelUsage: { 'claude-opus-5-5': usage(1) } },
    { type: 'assistant', sessionId: 's1', message: { id: 'after-crash', model: 'claude-opus-5-5', usage: { input_tokens: 50, output_tokens: 1 } } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  await ledger.importHistory(history);
  assert.equal(ledger.totals().models['claude-opus-5-5'].inputTokens, 150);
  assert.equal(ledger.totals().partial, true);
});

test('partial final journal write is recovered but interior corruption fails closed', async () => {
  const { dir, ledger } = await setup();
  await ledger.recordResult('s1', 'r1', { 'claude-opus-5-5': usage(1) }, 1);
  const file = path.join(dir, 'usage.jsonl');
  const before = await readFile(file, 'utf8');
  await writeFile(file, before + '{"broken');
  const recovered = await UsageLedger.open(file);
  assert.equal(recovered.totals().costUSD, 1);
  await recovered.recordResult('s2', 'r2', { 'claude-opus-5-5': usage(2) }, 2);
  assert.equal((await UsageLedger.open(file)).totals().costUSD, 3);
  await writeFile(file, '{"broken\n' + before);
  await assert.rejects(UsageLedger.open(file), /usage/i);
});
