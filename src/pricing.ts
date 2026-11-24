import { z } from 'zod';
import { modelLabel } from './settings.js';
import type { StateStore } from './state.js';

/** USD per million tokens. */
export interface ModelPrice { input: number; output: number; write5m: number; write1h: number; cacheRead: number }
export interface FastPrice { input: number; output: number }
/** Keyed by the pricing page's model name, e.g. "Claude Fable 5.2". */
export interface PriceTable { prices: Record<string, ModelPrice>; fast: Record<string, FastPrice> }
/** Cached in state.pricing, a new optional field that older versions ignore. */
export interface PricingState extends PriceTable { fetchedAt: string }

export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
/** Checked against the official pricing page on 25 Nov 2026. */
export const BUILTIN_PRICES: PriceTable = {
  prices: {
    'Claude Fable 5.2': { input: 8, output: 40, write5m: 10, write1h: 16, cacheRead: 0.2 },
    'Claude Fable 5.1': { input: 10, output: 50, write5m: 12.5, write1h: 20, cacheRead: 0.25 },
    'Claude Opus 5.5': { input: 4, output: 20, write5m: 5, write1h: 8, cacheRead: 0.2 },
    'Claude Sonnet 5.5': { input: 2, output: 10, write5m: 2.5, write1h: 4, cacheRead: 0.1 },
  },
  fast: { 'Claude Fable 5.2': { input: 16, output: 80 }, 'Claude Opus 5.5': { input: 8, output: 40 } },
};

const amount = z.number().finite().nonnegative().max(10_000);
const pricingState = z.object({ fetchedAt: z.string(), prices: z.record(z.string().max(80), z.object({ input: amount, output: amount, write5m: amount, write1h: amount, cacheRead: amount })),
  fast: z.record(z.string().max(80), z.object({ input: amount, output: amount })) });

/** Pricing-page name of a model id, e.g. claude-opus-4-5-20251101 -> "Claude Opus 4.5". */
export function priceName(model: string): string { return 'Claude ' + modelLabel(model); }

function section(markdown: string, heading: RegExp): string {
  const lines = markdown.split('\n'); const start = lines.findIndex(l => heading.test(l));
  if (start < 0) return '';
  const level = /^#+/.exec(lines[start])![0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && /^#+/.exec(l)![0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}
function rows(table: string): string[][] {
  return table.split('\n').filter(l => /^\|\s*Claude /.test(l)).map(l => l.split('|').slice(1, -1).map(c => c.trim()));
}
function cleanName(cell: string): string {
  return cell.replace(/<sup>.*?<\/sup>/g, '').replace(/\(\[[^\]]*\]\([^)]*\)\)/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}
function dollars(cell: string): number | undefined {
  const m = /\$\s*([\d,]*\.?\d+)/.exec(cell); const value = m ? Number(m[1].replace(/,/g, '')) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

/** Parses the "Model pricing" and "Fast mode pricing" tables. Throws when the model table is missing. */
export function parsePricing(markdown: string): PriceTable {
  const prices: PriceTable['prices'] = {}; const fast: PriceTable['fast'] = {};
  for (const cells of rows(section(markdown, /^##\s+Model pricing\s*$/))) {
    if (cells.length < 6) continue;
    const name = cleanName(cells[0]); const [input, write5m, write1h, cacheRead, output] = cells.slice(1, 6).map(dollars);
    // Tiered rows (e.g. Haiku by prompt size) repeat a name; keep the first (base) tier.
    if (!/^Claude [A-Za-z]+ [\d.]+$/.test(name) || Object.hasOwn(prices, name) || [input, write5m, write1h, cacheRead, output].some(v => v === undefined)) continue;
    prices[name] = { input: input!, output: output!, write5m: write5m!, write1h: write1h!, cacheRead: cacheRead! };
  }
  if (!Object.keys(prices).length) throw new Error('The pricing page has no readable model pricing table.');
  for (const cells of rows(section(markdown, /^###\s+Fast mode pricing\s*$/))) {
    const [input, output] = [dollars(cells[1] ?? ''), dollars(cells[2] ?? '')];
    if (input === undefined || output === undefined) continue;
    for (const name of cells[0].split('/').map(cleanName)) if (/^Claude [A-Za-z]+ [\d.]+$/.test(name)) fast[name] = { input, output };
  }
  return { prices, fast };
}

/** Prices for cost estimates: the last good page copy over the built-in table. The page is fetched only when a model has no price. */
export class PriceBook {
  constructor(private store?: StateStore, private load: () => Promise<string> = async () => { throw new Error('No pricing source.'); }) {}
  private cached(): PricingState | undefined { const parsed = pricingState.safeParse(this.store?.data.pricing); return parsed.success ? parsed.data : undefined; }
  table(): PriceTable { const c = this.cached(); return { prices: { ...BUILTIN_PRICES.prices, ...c?.prices }, fast: { ...BUILTIN_PRICES.fast, ...c?.fast } }; }
  /** Exact price, or an estimate from the newest priced model of the same family. */
  price(model: string): { price: ModelPrice; estimated: boolean } | undefined {
    const { prices } = this.table(); const name = priceName(model);
    if (Object.hasOwn(prices, name)) return { price: prices[name], estimated: false };
    const family = /^Claude ([A-Za-z]+) /.exec(name)?.[1]; if (!family) return;
    const version = (n: string) => (/ ([\d.]+)$/.exec(n)?.[1] ?? '0').split('.').map(Number);
    const newer = (a: number[], b: number[]) => (a[0] - b[0]) || ((a[1] ?? 0) - (b[1] ?? 0));
    const same = Object.keys(prices).filter(n => n.startsWith(`Claude ${family} `)).sort((a, b) => newer(version(b), version(a)));
    return same.length ? { price: prices[same[0]], estimated: true } : undefined;
  }
  fastPrice(model: string): FastPrice | undefined { const { fast } = this.table(); const name = priceName(model); return Object.hasOwn(fast, name) ? fast[name] : undefined; }
  /** Fetches the pricing page only if one of these models has no exact price. A failed fetch is retried on the next check. */
  async ensure(models: string[], now = new Date()): Promise<boolean> {
    if (!this.store || models.every(m => this.price(m)?.estimated === false)) return false;
    let table: PriceTable;
    try { table = parsePricing(await this.load()); }
    catch { console.warn('Pricing page check failed; keeping the last known prices.'); return false; }
    this.store.data.pricing = { fetchedAt: now.toISOString(), ...table }; await this.store.save(); return true;
  }
}

export async function fetchPricingPage(fetchImpl: (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> = fetch as never): Promise<string> {
  const response = await fetchImpl(PRICING_URL, { signal: AbortSignal.timeout(20_000), headers: { accept: 'text/markdown' } });
  if (!response.ok) throw new Error(`Pricing page returned HTTP ${response.status}.`);
  const text = await response.text(); if (text.length > 2_000_000) throw new Error('Pricing page is unexpectedly large.');
  return text;
}
