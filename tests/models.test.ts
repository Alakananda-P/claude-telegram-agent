import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { BUILTIN_MODELS, ModelCatalog, fetchModels, parseModels, type FetchLike } from '../src/models.js';
import { loadConfig } from '../src/config.js';
import { modelLabel } from '../src/settings.js';

const fixture = async () => JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures-models-2026-11-25.json'), 'utf8'));
const store = async () => StateStore.open(path.join(await mkdtemp(path.join(tmpdir(), 'tg-models-')), 'state.json'));
const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });

test('the newest model per allowed family comes from the Models API, labelled with its display name', async () => {
  const s = await store(); const page = await fixture();
  const catalog = new ModelCatalog(s, ['fable', 'opus', 'sonnet'], async () => parseModels(page));
  assert.equal(catalog.due(), true);
  assert.equal(await catalog.refresh(new Date('2026-11-25T00:00:00Z')), true);
  const current = catalog.current();
  assert.deepEqual([...current.values()].map(m => [m.family, m.id, m.label]), [['fable', 'claude-fable-5-2', 'Claude Fable 5.2'], ['sonnet', 'claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['opus', 'claude-opus-5-5', 'Claude Opus 5.5']]);
  assert.equal(current.has('haiku'), false, 'a family that is not allowed is hidden');
  assert.deepEqual(parseModels(page).find(m => m.id === 'claude-sonnet-4-6')!.efforts, ['low', 'medium', 'high', 'max']);
  assert.equal(catalog.due(Date.parse('2026-11-25T11:59:00Z')), false); assert.equal(catalog.due(Date.parse('2026-11-25T12:00:00Z')), true);
  assert.equal((await StateStore.open(s.file)).data.modelCatalog!.models.length, page.data.length);
});

test('API down keeps the last good list, and the built-in list covers a fresh install', async () => {
  const s = await store();
  const down = new ModelCatalog(s, ['fable', 'opus', 'sonnet'], async () => { throw new Error('offline'); });
  assert.equal(await down.refresh(), false);
  assert.deepEqual([...down.current().values()].map(m => m.id).sort(), BUILTIN_MODELS.map(m => m.id).sort());
  const newer = { id: 'claude-fable-6', label: 'Claude Fable 6', family: 'fable', createdAt: '2027-01-01T00:00:00Z' };
  await new ModelCatalog(s, ['fable', 'opus', 'sonnet'], async () => [newer]).refresh();
  assert.equal(down.current().get('fable')!.id, 'claude-fable-6');
  assert.equal(down.current().get('opus')!.id, 'claude-opus-5-5', 'families missing from the API fall back to the built-in list');
  assert.equal(await down.refresh(), false); assert.equal(down.current().get('fable')!.id, 'claude-fable-6');
  s.data.modelCatalog = { fetchedAt: 'x', models: [{ id: 'not a model id' }] } as never;
  assert.equal(down.current().get('fable')!.id, 'claude-fable-5-2', 'a corrupt cache is ignored, not trusted');
});

test('fetchModels pages through the list, sends the key only as a header and never echoes it in errors', async () => {
  const page = await fixture(); const urls: string[] = []; const key = 'sk-ant-test-only-not-real';
  const pages: FetchLike = async (url, init) => {
    urls.push(url); assert.equal(init.headers['x-api-key'], key); assert.equal(init.headers['anthropic-version'], '2023-06-01');
    return url.includes('after_id') ? reply({ data: page.data.slice(2), has_more: false }) : reply({ data: page.data.slice(0, 2), has_more: true, last_id: page.data[1].id });
  };
  assert.equal((await fetchModels(key, pages)).length, page.data.length);
  assert.equal(urls.length, 2); assert.ok(urls.every(u => !u.includes(key)));
  await assert.rejects(fetchModels(key, async () => reply({ error: 'nope' }, 401)), error => !String(error).includes(key) && /HTTP 401/.test(String(error)));
  await assert.rejects(fetchModels(key, async () => reply({ data: [{ id: 'bad' }] })), /no usable models/);
});

test('ALLOWED_MODEL_FAMILIES sets the families and rejects malformed values', () => {
  const base = { TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only' };
  assert.deepEqual(loadConfig(base).modelFamilies, ['fable', 'opus', 'sonnet']);
  assert.deepEqual(loadConfig({ ...base, ALLOWED_MODEL_FAMILIES: 'opus, haiku' }).modelFamilies, ['opus', 'haiku']);
  assert.throws(() => loadConfig({ ...base, ALLOWED_MODEL_FAMILIES: 'opus;rm -rf' }), /ALLOWED_MODEL_FAMILIES/);
});

test('CLAUDE_MODEL accepts a family or any model id of an allowed family and is stored as a rollback-safe id', () => {
  const base = { TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only' };
  assert.equal(loadConfig({ ...base, CLAUDE_MODEL: 'claude-fable-5-2' }).model, 'claude-fable-5-1');
  assert.equal(loadConfig({ ...base, CLAUDE_MODEL: 'opus' }).model, 'claude-opus-5-5');
  const haiku = loadConfig({ ...base, CLAUDE_MODEL: 'claude-haiku-5-5', ALLOWED_MODEL_FAMILIES: 'opus,haiku' });
  assert.equal(haiku.model, 'claude-opus-5-5'); assert.equal(haiku.modelFamily, 'haiku');
  assert.throws(() => loadConfig({ ...base, CLAUDE_MODEL: 'claude-haiku-5-5' }), /CLAUDE_MODEL/);
  assert.throws(() => loadConfig({ ...base, CLAUDE_MODEL: 'gpt-5' }), /CLAUDE_MODEL/);
  assert.deepEqual(['claude-fable-5-2', 'claude-opus-4-5-20251101', 'claude-opus-5', 'claude-haiku-5-5', 'something-else'].map(modelLabel), ['Fable 5.2', 'Opus 4.5', 'Opus 5', 'Haiku 5.5', 'something-else']);
});
