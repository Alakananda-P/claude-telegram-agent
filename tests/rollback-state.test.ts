import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StateStore } from '../src/state.js';
import { UsageLedger } from '../src/usage.js';
import { familySettings } from '../src/settings.js';

// The version that was live before this change. A rollback runs it on the same /data disk,
// so it must load everything this version writes (plan U-g).
const LIVE = '0e96738';
const root = path.resolve(import.meta.dirname, '..');

/** Extracts the live version's src/ next to node_modules, or skips when git history is unavailable. */
async function legacy(t: test.TestContext): Promise<string | undefined> {
  const dir = path.join(root, 'tests', '.legacy-' + LIVE);
  try {
    await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
    const archive = execFileSync('git', ['archive', LIVE, 'src'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    return path.join(dir, 'src');
  } catch { await rm(dir, { recursive: true, force: true }); t.skip(`git history for ${LIVE} is not available`); }
}

test('state and usage written by this version still load in the previous live version', async t => {
  const src = await legacy(t); if (!src) return;
  t.after(() => rm(path.dirname(src), { recursive: true, force: true }));
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-rollback-'));
  const store = await StateStore.open(path.join(dir, 'bot', 'state.json'));
  // Everything new in this branch: family settings, model list, notices, prices, update record, /plan tasks.
  store.data.settings = { ...familySettings('haiku'), effort: 'high', fast: false };
  store.data.modelCatalog = { fetchedAt: new Date().toISOString(), models: [{ id: 'claude-fable-5-2', label: 'Claude Fable 5.2', family: 'fable', createdAt: '2026-11-09T18:30:00Z', efforts: ['low', 'high'] }] };
  store.data.modelNotices = { fable: 'claude-fable-5-2' };
  store.data.pricing = { fetchedAt: new Date().toISOString(), prices: { 'Claude Fable 5.2': { input: 8, output: 40, write5m: 10, write1h: 16, cacheRead: 0.2 } }, fast: {} };
  store.data.update = { previousDeployId: 'dep-live', previousCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), startedAt: new Date().toISOString(), result: 'live', reportedAt: new Date().toISOString() };
  const now = new Date().toISOString();
  store.data.tasks!.push({ id: 'task-1', project: 'default', chatKey: 'draft-default', kind: 'agent', status: 'completed', prompt: 'plan it', createdAt: now, startedAt: now, finishedAt: now,
    settings: { ...familySettings('fable'), effort: 'max', fast: true }, planMode: true, deadlineAt: now, interactive: true });
  await store.save();
  const ledger = await UsageLedger.open(path.join(dir, 'bot', 'usage.jsonl'));
  await ledger.recordStep('s1', 'a', 'claude-fable-5-2', { input_tokens: 10, output_tokens: 5 }, true);
  await ledger.recordResult('s1', 'r1', { 'claude-fable-5-2': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01, webSearchRequests: 0 } }, 0.01);

  const old = await import(pathToFileURL(path.join(src, 'state.ts')).href) as typeof import('../src/state.js');
  const reopened = await old.StateStore.open(store.file);
  assert.equal(reopened.data.settings!.model, 'claude-opus-5-5');
  assert.equal(reopened.data.tasks!.find(t => t.id === 'task-1')!.status, 'completed');
  const oldUsage = await import(pathToFileURL(path.join(src, 'usage.ts')).href) as typeof import('../src/usage.js');
  const oldLedger = await oldUsage.UsageLedger.open(ledger.file);
  assert.ok(oldLedger.totals().models['claude-fable-5-2'], 'the old ledger keeps new model rows');
});
