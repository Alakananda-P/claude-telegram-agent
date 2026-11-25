import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { PriceBook, parsePricing } from '../src/pricing.js';
import { UsageLedger } from '../src/usage.js';

const page = () => readFile(path.join(import.meta.dirname, 'fixtures-pricing-2026-11-25.md'), 'utf8');
const store = async () => StateStore.open(path.join(await mkdtemp(path.join(tmpdir(), 'tg-pricing-')), 'state.json'));

test('the pricing page tables parse into model and fast-mode prices', async () => {
  const table = parsePricing(await page());
  assert.deepEqual(table.prices['Claude Fable 5.2'], { input: 8, output: 40, write5m: 10, write1h: 16, cacheRead: 0.2 });
  assert.deepEqual(table.prices['Claude Opus 4.1'], { input: 15, output: 75, write5m: 18.75, write1h: 30, cacheRead: 1.5 });
  assert.deepEqual(table.prices['Claude Haiku 5.5'], { input: 0.1, output: 0.5, write5m: 0.125, write1h: 0.2, cacheRead: 0.01 }, 'first tier of a tiered model');
  assert.deepEqual(table.fast, { 'Claude Fable 5.2': { input: 16, output: 80 }, 'Claude Mythos 5.2': { input: 16, output: 80 }, 'Claude Opus 5.5': { input: 8, output: 40 }, 'Claude Opus 5': { input: 10, output: 50 }, 'Claude Opus 4.8': { input: 10, output: 50 } });
  assert.throws(() => parsePricing('# Pricing\n\nNothing here.'), /no readable model pricing table/);
});

test('the page is fetched only when a model has no saved price; a failed parse keeps the last good prices', async () => {
  const s = await store(); let fetches = 0; let body = await page();
  const book = new PriceBook(s, async () => { fetches++; return body; });
  assert.equal(await book.ensure(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5']), false); assert.equal(fetches, 0, 'built-in prices cover today\'s models');
  assert.deepEqual(book.price('claude-opus-5'), { price: { input: 4, output: 20, write5m: 5, write1h: 8, cacheRead: 0.2 }, estimated: true }, 'family estimate before the page is read');
  assert.equal(await book.ensure(['claude-opus-5']), true); assert.equal(fetches, 1);
  assert.deepEqual(book.price('claude-opus-5'), { price: { input: 5, output: 25, write5m: 6.25, write1h: 10, cacheRead: 0.5 }, estimated: false });
  assert.equal(await book.ensure(['claude-opus-5']), false); assert.equal(fetches, 1, 'no repeat fetch once priced');
  body = 'broken page';
  assert.equal(await book.ensure(['claude-opus-6']), false); assert.equal(fetches, 2);
  assert.equal(book.price('claude-opus-5')!.estimated, false, 'last good copy kept');
  assert.deepEqual(book.price('claude-opus-6'), { price: book.price('claude-opus-5-5')!.price, estimated: true });
  assert.equal(book.price('claude-unknown-1'), undefined);
});

test('step costs use the price book, including Fable 5.2 and fast mode, and estimated rows are marked', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-pricing-ledger-'));
  const ledger = await UsageLedger.open(path.join(dir, 'usage.jsonl'));
  await ledger.recordStep('s1', 'a', 'claude-fable-5-2', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, true);
  await ledger.recordStep('s2', 'b', 'claude-fable-5-2', { input_tokens: 1_000_000, output_tokens: 0, speed: 'fast' }, true);
  await ledger.recordStep('s3', 'c', 'claude-sonnet-6', { input_tokens: 1_000_000, output_tokens: 0 }, true);
  const models = ledger.totals().models;
  assert.equal(models['claude-fable-5-2'].costUSD, 48 + 16);
  assert.equal(models['claude-sonnet-6'].costUSD, 2);
  assert.match(ledger.report('cost'), /Sonnet 6: \$2\.0000 \(estimated\)/);
  assert.doesNotMatch(ledger.report('cost'), /Fable 5\.2: \$64\.0000 \(estimated\)/);
});
