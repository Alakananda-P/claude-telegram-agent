import { z } from 'zod';
import { EFFORTS, familyOf, type Effort } from './settings.js';
import type { StateStore } from './state.js';

/** One Claude model as listed by the Anthropic Models API (GET /v1/models). */
export interface CatalogModel { id: string; label: string; family: string; createdAt: string; efforts?: Effort[]; lifecycle?: string; retiresAt?: string | null }
/** Cached in state.modelCatalog, a new optional field that older versions ignore. */
export interface ModelCatalogState { fetchedAt: string; models: CatalogModel[] }

export const DEFAULT_MODEL_FAMILIES = ['fable', 'opus', 'sonnet'];
export const MODEL_REFRESH_MS = 12 * 60 * 60_000;
/** Used when the Models API has never been reached. Checked against the API on 25 Nov 2026. */
export const BUILTIN_MODELS: CatalogModel[] = [
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', family: 'fable', createdAt: '2026-11-09T18:30:00Z', efforts: [...EFFORTS] },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', family: 'opus', createdAt: '2026-09-21T16:24:00Z', efforts: [...EFFORTS] },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', family: 'sonnet', createdAt: '2026-09-28T00:00:00Z', efforts: [...EFFORTS] },
];

const modelId = z.string().regex(/^claude-[a-z0-9-]{1,80}$/);
const apiModel = z.object({
  id: modelId, display_name: z.string().min(1).max(80), created_at: z.string().datetime({ offset: true }),
  line: z.string().regex(/^[a-z]{1,32}$/).optional(), lifecycle: z.string().max(32).optional(), retires_at: z.string().nullable().optional(),
  capabilities: z.object({ effort: z.record(z.string(), z.unknown()).optional() }).passthrough().optional(),
});
const catalogModel = z.object({ id: modelId, label: z.string().min(1).max(80), family: z.string().regex(/^[a-z]{1,32}$/), createdAt: z.string(),
  efforts: z.array(z.enum(EFFORTS)).optional(), lifecycle: z.string().max(32).optional(), retiresAt: z.string().nullable().optional() });
const catalogState = z.object({ fetchedAt: z.string(), models: z.array(catalogModel).max(500) });

export { familyOf };

/** Parses one Models API page. Entries that do not match the expected shape are skipped, never trusted. */
export function parseModels(page: unknown): CatalogModel[] {
  const data = (page as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('Models API returned no model list.');
  return data.flatMap(raw => {
    const parsed = apiModel.safeParse(raw); if (!parsed.success) return [];
    const m = parsed.data; const family = m.line ?? familyOf(m.id); if (!family) return [];
    const effort = m.capabilities?.effort as Record<string, { supported?: boolean }> | undefined;
    const efforts = effort ? EFFORTS.filter(level => effort[level]?.supported === true) : undefined;
    return [{ id: m.id, label: m.display_name, family, createdAt: m.created_at, ...(efforts ? { efforts } : {}), ...(m.lifecycle ? { lifecycle: m.lifecycle } : {}), ...(m.retires_at !== undefined ? { retiresAt: m.retires_at } : {}) }];
  });
}

/** The newest usable model per allowed family, by created_at. Retired models are never chosen. */
export function newestByFamily(models: CatalogModel[], families: string[]): Map<string, CatalogModel> {
  const newest = new Map<string, CatalogModel>();
  for (const m of models) {
    if (!families.includes(m.family) || m.lifecycle === 'retired') continue;
    const current = newest.get(m.family);
    if (!current || Date.parse(m.createdAt) > Date.parse(current.createdAt)) newest.set(m.family, m);
  }
  return newest;
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** O-c: Claude Code OAuth has no API key for the Models API; the built-in list is used without a call. */
export class NoModelKeyError extends Error { constructor() { super('No API key for the Models API (OAuth login).'); this.name = 'NoModelKeyError'; } }

/** GET /v1/models with pagination (at most 5 pages). Throws on any HTTP or shape error; never includes the key in errors. */
export async function fetchModels(apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, baseUrl = 'https://api.anthropic.com'): Promise<CatalogModel[]> {
  if (!apiKey) throw new NoModelKeyError();
  const models: CatalogModel[] = []; let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = `${baseUrl}/v1/models?limit=100${after ? '&after_id=' + encodeURIComponent(after) : ''}`;
    const response = await fetchImpl(url, { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Models API returned HTTP ${response.status}.`);
    const body = await response.json() as { has_more?: unknown; last_id?: unknown };
    models.push(...parseModels(body));
    if (body.has_more !== true || typeof body.last_id !== 'string') break;
    after = body.last_id;
  }
  if (!models.length) throw new Error('Models API listed no usable models.');
  return models;
}

/** Model list for the bot: the cached API list, filled in from the built-in list for any family the API did not return. */
export class ModelCatalog {
  constructor(private store: StateStore, readonly families: string[] = DEFAULT_MODEL_FAMILIES, private load: () => Promise<CatalogModel[]>) {}
  private cached(): ModelCatalogState | undefined {
    const parsed = catalogState.safeParse(this.store.data.modelCatalog);
    return parsed.success ? parsed.data : undefined;
  }
  /** Newest model per allowed family. */
  current(): Map<string, CatalogModel> {
    const latest = newestByFamily(this.cached()?.models ?? [], this.families);
    for (const [family, model] of newestByFamily(BUILTIN_MODELS, this.families)) if (!latest.has(family)) latest.set(family, model);
    return latest;
  }
  /** Every known model, cached API list first. */
  all(): CatalogModel[] { return [...(this.cached()?.models ?? []), ...BUILTIN_MODELS.filter(b => !this.cached()?.models.some(m => m.id === b.id))]; }
  due(now = Date.now()): boolean { const at = Date.parse(this.cached()?.fetchedAt ?? ''); return !Number.isFinite(at) || now - at >= MODEL_REFRESH_MS; }
  /** Fetches the list. On failure the last good copy (or the built-in list) stays in use. */
  async refresh(now = new Date()): Promise<boolean> {
    let models: CatalogModel[];
    try { models = await this.load(); }
    catch (error) { if (!(error instanceof NoModelKeyError)) console.warn('Model list refresh failed; keeping the last known list.'); return false; }
    this.store.data.modelCatalog = { fetchedAt: now.toISOString(), models: models.slice(0, 500) };
    await this.store.save(); return true;
  }
}
