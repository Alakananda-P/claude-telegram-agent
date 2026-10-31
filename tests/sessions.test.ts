import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { ChatArchive } from '../src/chats.js';
import { SessionCatalog, sessionTools, sessionServer } from '../src/sessions.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-sessions-'));
  const store = await StateStore.open(path.join(dir, 'state.json'));
  const archive = new ChatArchive(path.join(dir, 'chats'), ['private-test-secret']);
  store.data.conversations = [
    { id: 'old-id', project: 'bills', updatedAt: '2026-10-30' },
    { id: 'active-id', project: 'default', updatedAt: '2026-10-31' },
  ];
  store.data.sessions.default = 'active-id';
  await archive.append('old-id', { role: 'user', text: 'Prepare handwritten bills for Tally import' });
  const catalog = new SessionCatalog(store, archive, ['private-test-secret']);
  return { catalog, store, archive };
}

test('old sessions get persistent topic names and model renames survive backfill', async () => {
  const { catalog, store } = await setup();
  await catalog.backfill();
  assert.match(catalog.list().sessions.find(s => s.id === 'old-id')!.title, /handwritten bills/);
  await catalog.rename('old-id', 'Tally bills October', 'model');
  await catalog.backfill();
  const reopened = await StateStore.open(store.file);
  assert.equal(reopened.data.conversations![0].title, 'Tally bills October');
  assert.equal(catalog.list().total, 2);
  assert.equal(catalog.list().currentSession, 'active-id');
  await assert.rejects(catalog.rename('../../state', 'bad'), /not found/i);
  await assert.rejects(catalog.rename('old-id', 'private-test-secret'), /title/i);
});

test('session reader can page through long messages across projects without file tokens', async () => {
  const { catalog, archive } = await setup();
  const original = 'long text '.repeat(4000);
  await archive.append('old-id', { role: 'assistant', text: original, file: { id: 'TG-PRIVATE-ID', name: 'bills.xlsx' } });
  let cursor = { turn: 0, offset: 0 };
  let combined = '';
  for (let i = 0; i < 20; i++) {
    const page = await catalog.read('old-id', cursor.turn, cursor.offset);
    assert.ok(JSON.stringify(page).length < 15000);
    assert.ok(!JSON.stringify(page).includes('TG-PRIVATE-ID'));
    combined += page.turns.filter(t => t.index === 1).map(t => t.text).join('');
    if (!page.next) break;
    cursor = page.next;
  }
  assert.equal(combined, original);
  await assert.rejects(catalog.read('draft-default'), /not found/i);
  await assert.rejects(catalog.read('old-id', -1), /page/i);
});

test('session tools expose count, bounded history and rename without changing active chat', async () => {
  const { catalog, store } = await setup();
  const definitions = sessionTools(catalog);
  const invoke = (name: string, args: unknown) => definitions.find(t => t.name === name)!.handler(args as never, {});
  const list = await invoke('list_sessions', {});
  assert.match(JSON.stringify(list), /old-id/);
  const rename = await invoke('rename_session', { session_id: 'old-id', title: 'Invoice conversion' });
  assert.equal(rename.isError, undefined);
  assert.equal(store.data.sessions.default, 'active-id');
  const error = await invoke('read_session', { session_id: 'not-known' });
  assert.equal(error.isError, true);
});

test('search finds archived content and continues beyond an empty scan page', async () => {
  const { catalog, store, archive } = await setup();
  store.data.conversations = Array.from({ length: 30 }, (_, i) => ({ id: `chat-${i}`, project: 'default', updatedAt: '2026-10-31' }));
  await archive.append('chat-29', { role: 'user', text: 'Find October ledger entries' });
  assert.deepEqual((await catalog.search('ledger')).hits, []);
  assert.equal((await catalog.search('ledger')).nextPage, 1);
  const result = await catalog.search('ledger', 1);
  assert.equal(result.hits[0].id, 'chat-29');
  assert.equal(result.hits[0].turn, 0);
  assert.equal(result.nextPage, null);
});

test('failed auto naming keeps a useful fallback and concurrent rename wins', async () => {
  const { catalog, store } = await setup();
  await catalog.autoName('old-id', async () => null);
  assert.match(store.data.conversations![0].title!, /handwritten/);
  assert.equal(store.data.conversations![0].titleAttempted, true);
  store.data.conversations![0].titleAttempted = false;
  await catalog.autoName('old-id', async () => {
    await catalog.rename('old-id', 'Owner supplied title', 'manual');
    return 'Auto generated title';
  });
  assert.equal(store.data.conversations![0].title, 'Owner supplied title');
});

test('automatic naming uses generated title once and never overwrites a model rename', async () => {
  const { catalog, store } = await setup();
  let calls = 0;
  await catalog.autoName('old-id', async () => { calls++; return 'Tally invoice import'; });
  await catalog.autoName('old-id', async () => { calls++; return 'Repeated name'; });
  assert.equal(calls, 1);
  assert.equal(store.data.conversations![0].title, 'Tally invoice import');
  await catalog.rename('old-id', 'My custom title');
  await catalog.autoName('old-id', async () => 'Unwanted title');
  assert.equal(store.data.conversations![0].title, 'My custom title');
});

test('real MCP transport lists schemas, reads pages and persists a rename', async () => {
  const { catalog, store } = await setup();
  const server = sessionServer(catalog);
  const client = new Client({ name: 'session-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.ok(['list_sessions', 'read_session', 'rename_session', 'search_sessions', 'request_delete_session', 'restore_session', 'list_trash'].every(name => listed.tools.some(t => t.name === name)));
    const read = await client.callTool({ name: 'read_session', arguments: { session_id: 'old-id' } });
    assert.match(JSON.stringify(read), /handwritten bills/);
    const renamed = await client.callTool({ name: 'rename_session', arguments: { session_id: 'old-id', title: 'October invoices' } });
    assert.equal(renamed.isError, undefined);
    assert.equal(store.data.conversations![0].title, 'October invoices');
    const invalid = await client.callTool({ name: 'read_session', arguments: { session_id: 'old-id', start_turn: -1 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.instance.close(); }
});

test('trash expires after 48 hours, restore cancels expiry and purge prevents transcript reimport', async () => {
  const { catalog, store, archive } = await setup();
  const now = new Date('2026-10-31T12:00:00Z');
  await catalog.trash('old-id', now);
  assert.equal(catalog.list().total, 1);
  assert.equal(catalog.trashList()[0].purgeAt, '2026-11-02T12:00:00.000Z');
  await assert.rejects(catalog.read('old-id'), /Trash/);
  assert.equal(await catalog.purgeExpired(new Date('2026-11-02T11:59:59Z')), 0);
  await catalog.restore('old-id', now);
  assert.equal(await catalog.purgeExpired(new Date('2026-11-03T00:00:00Z')), 0);
  await catalog.trash('old-id', now);
  assert.equal(await catalog.purgeExpired(new Date('2026-11-02T12:00:00Z')), 1);
  assert.deepEqual(await archive.read('old-id'), []);
  assert.ok(store.data.purgedSessions!.includes('old-id'));
  assert.equal(store.data.sessions.default, 'active-id');
  assert.equal(store.data.memoryEnabled, true);
});
