import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { poll } from '../src/polling.js';
import { StateStore } from '../src/state.js';

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
