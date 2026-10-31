import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { workspaceServer, WORKSPACE_TOOL_NAMES } from '../src/workspace-tools.js';
import { Automation } from '../src/automation.js';
import { StateStore } from '../src/state.js';

test('workspace MCP transport exposes valid schemas and manages real schedules, clock and bill validation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-mcp-')); const store = await StateStore.open(path.join(root, 'state.json'));
  const delivered: string[] = [];
  const server = workspaceServer({ root, project: 'default', automation: new Automation(store), deliver: async f => { delivered.push(f); }, backup: async () => {} });
  const client = new Client({ name: 'workspace-test', version: '1.0.0' }); const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(b); await client.connect(a);
    const list = await client.listTools(); assert.equal(list.tools.length, WORKSPACE_TOOL_NAMES.length);
    const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse((r.content as { text: string }[])[0].text); };
    assert.equal((await call('clock')).timezone, 'Asia/Kolkata');
    const s = await call('create_schedule', { name: 'Daily report', kind: 'agent', prompt: 'Create daily report', cron: '0 9 * * *' });
    assert.equal((await call('list_schedules')).schedules.length, 1);
    await call('edit_schedule', { id: s.id, name: 'Evening report', kind: 'agent', prompt: 'Create evening report', cron: '0 18 * * *' });
    assert.equal(store.data.schedules![0].id, s.id); assert.equal(store.data.schedules!.length, 1);
    await call('manage_schedule', { id: s.id, action: 'pause' }); assert.equal(store.data.schedules![0].enabled, false);
    const bill = await call('validate_bill', { rows: [{ label: 'Item', quantity: 2, rate: 15, amount: 30 }], total: 30, uncertain: ['date'] }); assert.equal(bill.ready, false);
    await call('deliver_file', { file: 'output/table.csv', preview: 'Ready' }); assert.deepEqual(delivered, ['output/table.csv']);
  } finally { await client.close(); await server.instance.close(); }
});
