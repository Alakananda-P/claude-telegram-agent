import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectCatalog } from '../src/projects.js';
import { StateStore } from '../src/state.js';
const module = await import('../src/' + 'project-tools.js').catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });

test('twelve project tools are callable through MCP with real catalog effects and host-owned switching/deletion', async () => {
  assert.equal(typeof module.projectServer, 'function', 'Project MCP tools are missing');
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-project-tools-')), store = await StateStore.open(path.join(dir, 'bot/state.json'));
  const catalog = new ProjectCatalog(dir, store, ['private-fixture-key']); await catalog.initialize();
  const changes: unknown[] = [], confirmations: string[] = [];
  const server = module.projectServer({ catalog, currentProject: 'default', pending: () => false,
    requestSwitch: async (id: string, remaining?: string) => { changes.push([id, remaining]); return { pending: true }; },
    cancelSwitch: async () => ({ cancelled: true }),
    requestClose: async (id: string, action: string) => action === 'archive' ? catalog.archive(id) : catalog.trash(id),
    requestPermanentDelete: async (id: string) => { confirmations.push(id); return { confirmationSent: true }; },
  });
  const client = new Client({ name: 'project-test', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(b); await client.connect(a);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 12); assert.equal(module.PROJECT_TOOL_NAMES.length, 12);
    assert.equal(tools.find(t => t.name === 'list_projects')!.annotations!.readOnlyHint, true);
    const deletion = tools.find(t => t.name === 'request_permanent_project_delete')!;
    assert.equal(deletion.annotations!.destructiveHint, true);
    assert.ok(!Object.hasOwn(deletion.inputSchema.properties!, 'confirmed'));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError, JSON.stringify(response));
      return JSON.parse((response.content as { text: string }[])[0].text);
    };
    const project = await call('create_project', { name: 'Invoice App', id: 'invoices', description: 'Build supplier reports' });
    assert.equal(project.id, 'invoices'); assert.equal(store.data.project, 'default');
    await call('rename_project', { project_id: project.id, name: 'Office Invoices' });
    await call('update_project', { project_id: project.id, description: 'Monthly reports' });
    assert.equal((await call('get_project', { project_id: project.id })).name, 'Office Invoices');
    assert.equal((await call('list_projects', { query: 'monthly' })).total, 1);
    await writeFile(path.join(await catalog.workspace(project.id), 'main.py'), 'print(1)');
    assert.equal((await call('list_project_files', { project_id: project.id })).files[0].path, 'main.py');
    await call('switch_project', { project_id: project.id, continue_task: 'Write the remaining code in this project.' });
    assert.deepEqual(changes, [['invoices', 'Write the remaining code in this project.']]);
    assert.equal(store.data.project, 'default'); assert.equal((await call('cancel_project_switch')).cancelled, true);
    await call('archive_project', { project_id: project.id }); assert.equal((await catalog.get(project.id)).status, 'archived');
    await call('restore_project', { project_id: project.id });
    await call('delete_project', { project_id: project.id }); assert.equal((await catalog.get(project.id)).status, 'trashed');
    await call('request_permanent_project_delete', { project_id: project.id });
    assert.deepEqual(confirmations, ['invoices']); assert.equal((await catalog.get(project.id)).status, 'trashed');
    const invalid = await client.callTool({ name: 'get_project', arguments: { project_id: '../outside' } });
    assert.equal(invalid.isError, true); assert.ok(!JSON.stringify(invalid).includes(dir));
    const credential = await client.callTool({ name: 'create_project', arguments: { name: 'private-fixture-key' } });
    assert.equal(credential.isError, true); assert.ok(!JSON.stringify(credential).includes('private-fixture-key'));
  } finally { await client.close(); await server.instance.close(); }
});
