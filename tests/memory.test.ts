import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SharedMemory } from '../src/memory.js';
import { memoryServer } from '../src/memory-tools.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

async function setup() { const dir = await mkdtemp(path.join(tmpdir(), 'tg-memory-v2-')); return { dir, memory: new SharedMemory(dir, ['private-secret']) }; }

test('legacy core and topic memory grow past old limits without truncation or loss', async () => {
  const { dir, memory } = await setup(); await mkdir(path.dirname(memory.file), { recursive: true });
  const legacy = 'पुरानी जानकारी '.repeat(10000); await writeFile(memory.file, legacy);
  await memory.remember('New durable preference'); assert.equal(await memory.read(), legacy.trimEnd() + '\n- New durable preference\n');
  const detail = 'accounting facts '.repeat(12000) + ' END_MARKER'; await memory.remember(detail, 'office');
  assert.ok((await memory.read('office')).includes('END_MARKER'));
  assert.equal(await readFile(memory.file, 'utf8'), await memory.read());
  const reopened = new SharedMemory(dir, []); assert.equal(await reopened.read('office'), await memory.read('office'));
  const stats = await memory.list(); assert.equal(stats.totalTopics, 2); assert.ok(stats.totalBytes > 64000); assert.equal(stats.storageLimit, null);
});

test('paginated reads and search reach facts beyond the old cap; prompt context stays bounded', async () => {
  const { memory } = await setup(); await memory.remember('Core fact\n' + 'irrelevant padding\n'.repeat(5000));
  await memory.remember('office padding\n'.repeat(3000) + 'Simnax special ledger verified', 'office');
  const search = await memory.search('Simnax'); assert.equal(search.matches[0].topic, 'office');
  const page = await memory.page('office', search.matches[0].offset, 200); assert.match(page.text, /Simnax/);
  let offset = 0, reconstructed = ''; do { const p = await memory.page('office', offset, 16000); reconstructed += p.text; if (p.nextOffset === null) break; assert.ok(p.nextOffset > offset); offset = p.nextOffset; } while (true);
  assert.equal(reconstructed, await memory.read('office'));
  const context = await memory.context('Simnax ledger'); assert.match(context, /Simnax/); assert.ok(context.length < 16000);
});

test('separate memory instances serialize writes and edits correctly and clear all topics', async () => {
  const { dir, memory } = await setup(); const other = new SharedMemory(dir, []);
  await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 2 ? memory : other).remember('Fact ' + i, 'project')));
  for (let i = 0; i < 25; i++) assert.match(await memory.read('project'), new RegExp('Fact ' + i + '\\n'));
  await memory.replace('Fact 10\n', 'Corrected fact\n', 'project'); assert.match(await memory.read('project'), /Corrected fact/);
  await memory.remember('Core'); await memory.clear(); assert.equal(await memory.read('project'), ''); assert.equal(await memory.read(), '');
});

test('memory tools expose useful errors and support topic, list and search through MCP', async () => {
  const { memory } = await setup(); const server = memoryServer(memory); const client = new Client({ name: 'memory-test', version: '1' }); const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(b); await client.connect(a);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const saved = await call('remember', { text: 'Useful fact '.repeat(3000), topic: 'office' }); assert.ok(!saved.isError);
    const page = await call('read_memory', { topic: 'office', limit: 100 }); assert.match(JSON.stringify(page), /nextOffset/);
    const list = await call('list_memory', {}); assert.match(JSON.stringify(list), /office/);
    const search = await call('search_memory', { query: 'Useful' }); assert.match(JSON.stringify(search), /office/);
    const bad = await call('edit_memory', { topic: 'office', old_text: 'missing', new_text: 'x' }); assert.equal(bad.isError, true); assert.match(JSON.stringify(bad), /missing or ambiguous/); assert.doesNotMatch(JSON.stringify(bad), /Saved data could not/);
    const secret = await call('remember', { text: 'private-secret', topic: 'office' }); assert.equal(secret.isError, true); assert.match(JSON.stringify(secret), /credentials/);
    await assert.rejects(memory.remember('escape', '../outside'), /topic/);
  } finally { await client.close(); await server.instance.close(); }
});

test('memory refuses symlink topic files and directories', async t => {
  const { dir, memory } = await setup(); await memory.remember('Core'); await memory.remember('topic', 'office');
  const { unlink } = await import('node:fs/promises'); await unlink(path.join(dir,'memory/topics/office.md'));
  try { await symlink(memory.file, path.join(dir,'memory/topics/office.md')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Host does not permit symlinks'); return; } throw e; }
  await assert.rejects(memory.read('office'), /symlink|regular file/);
});


test('search offsets remain exact for legacy Windows line endings and continuation reaches all topics', async () => {
  const { memory } = await setup(); await memory.remember('Core');
  await writeFile(memory.file, 'first\r\nsecond\r\nTARGET\r\n');
  const found = await memory.search('TARGET'); assert.equal(found.matches[0].offset,15);
  assert.ok((await memory.page('core',found.matches[0].offset,8)).text.startsWith('TARGET'));
  await memory.remember('TARGET A','a'); await memory.remember('TARGET B','b');
  const one=await memory.search('TARGET',undefined,0,1);assert.equal(one.nextOffset,1);
  const two=await memory.search('TARGET',undefined,one.nextOffset!,1);assert.equal(two.matches[0].topic,'a');
});

test('legacy configured credentials spanning read-page boundaries never leak fragments', async () => {
  const {memory}=await setup();await memory.remember('Core');await writeFile(memory.file,'padding-private-secret-end');
  const page=await memory.page('core',12,5);assert.ok(!page.text.includes('ate-s'));assert.match(page.text,/█/);
});


test('failed atomic write leaves existing committed memory unchanged and returns an actionable error', async t => {
 if(process.platform==='win32'){t.skip('POSIX directory permissions required');return;}
 const {chmod}=await import('node:fs/promises');const {memory}=await setup();await memory.remember('Keep this fact');const before=await memory.read();
 await chmod(memory.directory,0o500);
 try{await assert.rejects(memory.remember('New fact'),/permission|storage/i);assert.equal(await memory.read(),before);}finally{await chmod(memory.directory,0o700);}
});
