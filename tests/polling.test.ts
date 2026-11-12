import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { poll } from '../src/polling.js';
import { StateStore } from '../src/state.js';
import { TelegramError } from '../src/telegram.js';

test('polling persists offset before work and ignores already processed updates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-agent-poll-'));
  const store = await StateStore.open(path.join(dir, 'state.json'));
  store.data.offset = 10; await store.save();
  const abort = new AbortController();
  let handled = 0;
  const client = { async call<T>(_method: string, payload: Record<string, unknown>): Promise<T> {
    assert.equal(payload.offset, 10);
    return [{ update_id: 9, message: { chat: { id: 123, type: 'private' } } },
      { update_id: 10, message: { chat: { id: 123, type: 'private' }, text: 'work' } }] as T;
  } };
  await poll(client, store, async () => {
    handled++;
    const persisted = JSON.parse(await readFile(store.file, 'utf8'));
    assert.equal(persisted.offset, 11);
    abort.abort();
  }, abort.signal);
  assert.equal(handled, 1);
});

test('brief outages keep a safe durable history without sending a recovery notice', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-outage-')); const store = await StateStore.open(path.join(root, 'state.json'));
  let now = Date.parse('2026-11-12T00:00:00Z'), attempts = 0, notices = 0;
  const abort = new AbortController(); const waits: number[] = [];
  const client = { async call<T>(): Promise<T> { if (++attempts <= 3) throw new TelegramError(0, 0, false, 'ECONNRESET'); return [{ update_id: 1, message: { text: 'hello' } }] as T; } };
  await poll(client, store, async () => { abort.abort(); }, abort.signal, undefined, async () => { notices++; }, {
    now: () => now, wait: async ms => { waits.push(ms); now += ms; }
  });
  assert.equal(notices, 0); assert.deepEqual(waits, [1000, 2000, 4000]);
  const reopened = await StateStore.open(store.file); const outage = reopened.data.health!.telegramOutages![0];
  assert.equal(outage.durationMs, 7000); assert.equal(outage.failures, 3); assert.equal(outage.reason, 'ECONNRESET');
  assert.equal(reopened.data.health!.telegramOutage, undefined);
});

test('recovery notification failures never discard fetched owner updates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-recover-dispatch-')); const store = await StateStore.open(path.join(root, 'state.json'));
  let now = Date.parse('2026-11-12T00:00:00Z'), attempts = 0, notices = 0, handled = 0;
  const abort = new AbortController();
  const client = { async call<T>(): Promise<T> {
    if (++attempts === 1) throw new TelegramError(502);
    if (attempts > 2) { abort.abort(); return [] as T; }
    return [{ update_id: 3, message: { text: 'real owner instruction' } }] as T;
  } };
  await poll(client, store, async () => { handled++; abort.abort(); }, abort.signal, undefined, async (failures, outage) => {
    notices++; assert.equal(failures, 1); assert.equal(outage.durationMs, 61_000); throw new Error('notification delivery failed');
  }, { now: () => now, wait: async () => { now += 61_000; } });
  assert.equal(handled, 1); assert.equal(notices, 1); assert.equal(attempts, 2); assert.equal(store.data.offset, 4);
});

test('polling dispatches callbacks only after durably recording the update offset', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-agent-callback-'));
  const store = await StateStore.open(path.join(dir, 'state.json'));
  const abort = new AbortController();
  const client = { async call<T>(_method: string, payload: Record<string, unknown>): Promise<T> {
    assert.ok((payload.allowed_updates as string[]).includes('callback_query'));
    return [{ update_id: 1, callback_query: { id: 'cb', from: { id: 123 }, data: 'menu' } }] as T;
  } };
  await poll(client, store, async () => assert.fail('Not a message'), abort.signal, async callback => {
    assert.equal(callback.id, 'cb');
    assert.equal(JSON.parse(await readFile(store.file, 'utf8')).offset, 2);
    abort.abort();
  });
});
