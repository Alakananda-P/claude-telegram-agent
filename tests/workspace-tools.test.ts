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
import { BackgroundJobs } from '../src/background.js';
import { loadConfig } from '../src/config.js';
import { mkdir, writeFile } from 'node:fs/promises';

test('workspace MCP transport exposes valid schemas and manages real schedules, clock and bill validation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-mcp-')); const store = await StateStore.open(path.join(root, 'state.json'));
  const delivered: string[] = [];
  const transcribed: string[] = [];
  const server = workspaceServer({ root, project: 'default', automation: new Automation(store), deliver: async f => { delivered.push(f); }, backup: async () => {}, transcribe: async (file, language) => { transcribed.push(file + ':' + language); return { text: 'हैलो '.repeat(5000), language: 'hin', durationSeconds: 3, provider: 'ElevenLabs', model: 'scribe_v2', cached: false, hasSpeech: true, transcriptFile: 'transcripts/test.txt', metadataFile: 'transcripts/test.json' }; } });
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
    const transcription = await call('transcribe_media', { file: 'uploads/voice.ogg', language: 'hi' });
    assert.deepEqual(transcribed, ['uploads/voice.ogg:hi']); assert.equal(transcription.model, 'scribe_v2');
    assert.equal(transcription.text.length, 20000); assert.equal(transcription.truncated, true);
    assert.equal(transcription.transcriptFile, 'transcripts/test.txt');
  } finally { await client.close(); await server.instance.close(); }
});

test('transcription tool returns a clear configuration error over MCP', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-stt-mcp-')); const store = await StateStore.open(path.join(root, 'state.json'));
  const server = workspaceServer({ root, project: 'default', automation: new Automation(store), deliver: async () => {}, backup: async () => {} });
  const client = new Client({ name: 'stt-test', version: '1.0.0' }); const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.instance.connect(b); await client.connect(a); const result = await client.callTool({ name: 'transcribe_media', arguments: { file: 'uploads/voice.ogg' } }); assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /ElevenLabs transcription is not configured/); }
  finally { await client.close(); await server.instance.close(); }
});


test('Telegram tools are discoverable and callable without a slash command and expose no chat selector', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-message-mcp-')); const store = await StateStore.open(path.join(root, 'state.json'));
  const removed: number[][] = []; const options: unknown[] = [];
  const server = workspaceServer({ root, project: 'default', automation: new Automation(store), deliver: async () => {}, backup: async () => {}, telegram: {
    list: async a => { options.push(a); return { messages: [{ id: 10, preview: 'Old status', deletable: true }], total: 1 }; },
    delete: async ids => { removed.push(ids); return { deleted: ids, alreadyMissing: [], failed: [] }; }
  } });
  const client = new Client({ name: 'message-test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(b); await client.connect(a);
    const tools = (await client.listTools()).tools;
    for (const name of ['list_telegram_messages', 'delete_telegram_messages']) { assert.ok(WORKSPACE_TOOL_NAMES.includes('mcp__workspace__' + name)); assert.ok(tools.some(t => t.name === name)); }
    const deletion = tools.find(t => t.name === 'delete_telegram_messages')!;
    assert.ok(!Object.hasOwn(deletion.inputSchema.properties!, 'chat_id'));
    const listing = await client.callTool({ name: 'list_telegram_messages', arguments: { limit: 2, include_current_task: true } }); assert.ok(!listing.isError);
    assert.deepEqual(options, [{ limit: 2, include_current_task: true, include_ui: false }]);
    const result = await client.callTool({ name: 'delete_telegram_messages', arguments: { message_ids: [10] } }); assert.ok(!result.isError); assert.deepEqual(removed, [[10]]);
    const invalid = await client.callTool({ name: 'delete_telegram_messages', arguments: { message_ids: [] } }); assert.equal(invalid.isError, true); assert.equal(removed.length, 1);
  } finally { await client.close(); await server.instance.close(); }
});

test('background MCP tools start a real script, expose honest annotations and preserve its output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-background-mcp-')), root = path.join(dir, 'workspaces/default'); await mkdir(root, { recursive: true });
  const store = await StateStore.open(path.join(dir, 'bot/state.json'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', DATA_DIR: dir });
  const jobs = new BackgroundJobs(config, store, async () => {}); await writeFile(path.join(root, 'monitor.mjs'), "console.log('MCP_BACKGROUND_OK');");
  const server = workspaceServer({ root, project: 'default', automation: new Automation(store), deliver: async () => {}, backup: async () => {}, background: { start: input => jobs.start({ ...input, root, project: 'default', chatKey: 'chat' }), list: (offset, limit) => jobs.list(offset, limit), read: (id, offset, limit) => jobs.read(id, offset, limit), cancel: id => jobs.cancel(id) } });
  const client = new Client({ name: 'background-test', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(b); await client.connect(a); const tools = (await client.listTools()).tools;
    assert.equal(tools.find(t => t.name === 'start_background_job')!.annotations!.destructiveHint, true);
    assert.equal(tools.find(t => t.name === 'read_background_job')!.annotations!.readOnlyHint, true);
    const call = async (name: string, args: Record<string, unknown>) => { const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError); return JSON.parse((response.content as { text: string }[])[0].text); };
    const job = await call('start_background_job', { name: 'Monitor', script: 'monitor.mjs', runtime: 'node' }); await jobs.wait(job.id);
    assert.equal((await call('list_background_jobs', {})).jobs.length, 1);
    assert.match((await call('read_background_job', { id: job.id })).text, /MCP_BACKGROUND_OK/);
  } finally { await jobs.stop(); await client.close(); await server.instance.close(); }
});
