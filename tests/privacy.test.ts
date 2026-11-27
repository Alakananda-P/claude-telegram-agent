import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StateStore } from '../src/state.js';
import { Automation } from '../src/automation.js';
import { workspaceServer } from '../src/workspace-tools.js';
import { redact } from '../src/safety.js';
import { ChatArchive } from '../src/chats.js';
import { SessionCatalog, sessionTools } from '../src/sessions.js';
import { Telegram } from '../src/telegram.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-privacy-')), store = await StateStore.open(path.join(root, 'state.json'));
  const automation = new Automation(store);
  const server = workspaceServer({ root, project: 'default', automation, deliver: async () => {}, backup: async () => {} });
  const client = new Client({ name: 'privacy-regression', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.instance.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 3000 });
    assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse((r.content as { text: string }[])[0].text);
  };
  return { root, store, automation, call };
}

test('task inspection uses paginated metadata and never returns raw prompt, steering or legacy fields', async t => {
  const { store, automation, call } = await fixture(t);
  const raw = 'UnlabelledPrivateValueThatMustNotAppearInDefaultMetadata';
  for (let i = 0; i < 24; i++) {
    const task = await automation.enqueue({ project: i % 2 ? 'other' : 'default', chatKey: 'chat', kind: 'agent', prompt: raw, displayPrompt: 'password: "fake private value"', steers: [{ id: 'steer', text: raw, displayText: raw, status: 'sent' }] });
    if (i % 2) task.status = 'failed';
    Object.assign(task, { legacy: { raw } });
  }
  const page = await call('list_tasks');
  assert.equal(page.tasks.length, 20); assert.equal(page.total, 24); assert.equal(page.nextOffset, 20);
  assert.ok(!JSON.stringify(page).includes(raw));
  assert.ok(page.tasks.every((x: object) => !['prompt', 'displayPrompt', 'steers', 'legacy'].some(k => Object.hasOwn(x, k))));
  const filtered = await call('list_tasks', { project: 'other', status: 'failed', limit: 1, include_summary: true });
  assert.equal(filtered.total, 12); assert.equal(filtered.tasks.length, 1); assert.equal(filtered.tasks[0].project, 'other');
  assert.match(filtered.tasks[0].summary, /REDACTED/);
  const old = store.data.tasks![1]; await automation.retryTask(old.id);
  const restarted = await StateStore.open(store.file);
  assert.equal(restarted.data.tasks!.at(-1)!.prompt, raw);
  assert.equal(restarted.data.tasks!.at(-1)!.steers![0].text, raw);
});

test('schedule inspection masks credentials while an omitted edit prompt preserves exact execution text', async t => {
  const { store, call } = await fixture(t), raw = 'Report using password: "test password with spaces"';
  const created = await call('create_schedule', { name: 'Daily', kind: 'agent', prompt: raw, intervalMinutes: 60 });
  assert.ok(!JSON.stringify(created).includes('test password with spaces'));
  const listed = await call('list_schedules'); assert.ok(!JSON.stringify(listed).includes('test password with spaces'));
  await call('edit_schedule', { id: created.id, name: 'Evening', kind: 'agent', intervalMinutes: 120 });
  assert.equal(store.data.schedules![0].prompt, raw); assert.equal(store.data.schedules![0].intervalMinutes, 120);
});

test('shared redaction covers recognizable tokens and labelled credentials without corrupting amounts or GSTINs', () => {
  const token = 'ghp_' + 'A'.repeat(36), kaggle = 'KGAT_' + 'b'.repeat(32);
  const text = `${token}\n${kaggle}\napi_key=example-private-key-123&x=1\nPassword: "private words here"\nAadhaar: 2345 6789 0123\nPAN: ABCDE1234F\nGSTIN: 07ABCDE1234F1Z5\nTotal: 1234.50\nInvoice: 234567890123`;
  const safe = redact(text, []);
  for (const secret of [token, kaggle, 'example-private-key-123', 'private words here', '2345 6789 0123']) assert.ok(!safe.includes(secret));
  assert.match(safe, /GSTIN: 07ABCDE1234F1Z5/); assert.match(safe, /Total: 1234\.50/); assert.match(safe, /Invoice: 234567890123/);
  assert.match(safe, /&x=1/);
  const quoted = JSON.stringify({ password: 'one"two\\three' });
  assert.ok(!redact(quoted).includes('three'));
  assert.equal(redact('API_KEY="<YOUR_API_KEY>"'), 'API_KEY="<YOUR_API_KEY>"');
});

test('large unbroken process output remains usable during secret masking', { timeout: 3000 }, () => {
  const log = 'x'.repeat(300000);
  assert.equal(redact(log), log);
  assert.equal(redact('https://user:private-value@example.org/path'), 'https://user:[REDACTED]@example.org/path');
});

test('legacy chat reads redact before paging and search excerpts can expose credential fragments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-private-history-')), dir = path.join(root, 'chats'); await mkdir(dir);
  const secret = 'LegacyConfiguredCredential_' + 'Z'.repeat(80), id = 'legacy';
  const file = path.join(dir, createHash('sha256').update(id).digest('hex') + '.json');
  await writeFile(file, JSON.stringify([{ role: 'user', text: 'x'.repeat(9970) + secret + ' done' }]));
  const archive = new ChatArchive(dir, [secret]);
  assert.ok(!(await archive.read(id))[0].text.includes(secret));
  const store = await StateStore.open(path.join(root, 'state.json'));
  store.data.conversations = [{ id, project: 'default', updatedAt: new Date().toISOString() }];
  const catalog = new SessionCatalog(store, archive, [secret]);
  let page = await catalog.read(id), all = JSON.stringify(page);
  if (page.next) { page = await catalog.read(id, page.next.turn, page.next.offset); all += JSON.stringify(page); }
  assert.ok(!all.includes('LegacyConfiguredCredential_')); assert.ok(!all.includes('Z'.repeat(15)));
});

test('Telegram panel labels are sanitized without changing callback IDs', async () => {
  const telegram = new Telegram('123456:test-token', []), payloads: any[] = [];
  Object.assign(telegram, { async call(_method: string, payload: unknown) { payloads.push(payload); return { message_id: 1 }; } });
  await telegram.panel(123, 'Settings', [[{ text: 'password: "private button value"', callback_data: 'settings' }]]);
  assert.ok(!JSON.stringify(payloads).includes('private button value'));
  assert.equal(payloads[0].reply_markup.inline_keyboard[0][0].callback_data, 'settings');
});

test('masking inspection does not rewrite legacy archive turns during an ordinary append or binding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-legacy-private-')); await mkdir(root, { recursive: true });
  const file = path.join(root, createHash('sha256').update('legacy').digest('hex') + '.json');
  const original = { role: 'user', text: 'password: "legacy archive value"' };
  await writeFile(file, JSON.stringify([original]));
  const archive = new ChatArchive(root, []);
  await archive.append('legacy', { role: 'assistant', text: 'Unrelated answer' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8'))[0], original);
  await archive.bind('legacy', 'next');
  assert.deepEqual((await archive.snapshot('next'))[0], original);
  assert.ok(!(await archive.read('next'))[0].text.includes('legacy archive value'));
});

test('legacy session title inspection and start context mask configured secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-private-title-')), secret = 'ConfiguredPrivateValue_0123456789';
  const store = await StateStore.open(path.join(root, 'state.json'));
  store.data.conversations = [{ id: 'legacy', project: 'default', updatedAt: new Date().toISOString(), title: 'Work ' + secret }];
  store.data.sessions.default = 'legacy';
  const catalog = new SessionCatalog(store, new ChatArchive(root, [secret]), [secret]);
  const tools = sessionTools(catalog);
  const result = await tools.find(t => t.name === 'list_sessions')!.handler({} as never, {});
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(catalog.context()).includes(secret));
  assert.equal(store.data.conversations[0].title, 'Work ' + secret);
});

test('one token table drives redact and detectTokens, with Verhoeff-checked bare Aadhaar masking', async () => {
  const { detectTokens, maskTokens, verhoeffValid } = await import('../src/safety.js');
  const samples: [string, string][] = [['ElevenLabs key', 'sk_' + 'ab12'.repeat(12)], ['Hugging Face token', 'hf_' + 'aB3d'.repeat(9)], ['AWS access key', 'AKIA' + 'ABCD2345EFGH6789'],
    ['Slack token', 'xoxb-1234567890-abcdefghij'], ['Render API key', 'rnd_' + 'Ab1'.repeat(8)], ['Modal token', 'ak-' + 'Xy7'.repeat(8)], ['Modal token', 'as-' + 'Qz9'.repeat(8)]];
  for (const [kind, value] of samples) {
    assert.ok(detectTokens(`use ${value} now`).includes(kind), kind); assert.equal(redact(`use ${value} now`), 'use [REDACTED] now', kind);
    assert.ok(!maskTokens(value).includes(value), kind);
  }
  assert.deepEqual(detectTokens('sk-ant-api03-' + 'x'.repeat(30)), ['Anthropic API key'], 'no duplicate OpenAI hit');
  assert.ok(verhoeffValid('499118665246') && !verhoeffValid('234567890123') && !verhoeffValid('12a4'));
  assert.equal(redact('id 4991 1866 5246 and 499118665246'), 'id [REDACTED] and [REDACTED]');
  for (const plain of ['Invoice: 234567890123', 'Total 4991.18665246', 'GSTIN 07ABCDE1234F1Z5', 'Order 1499118665246', 'Ref 199118665246']) assert.equal(redact(plain), plain);
});

test('secretPath blocks key files and secret folders used by /get, deliver_file and backups', async () => {
  const { secretPath, credentialContent } = await import('../src/safety.js');
  for (const p of ['.secrets/keys.txt', 'secrets/api.txt', 'secrets.json', 'config/kaggle.json', '.netrc', '.env.local', 'certs/server.pem', '.ssh/id_rsa', 'id_ed25519', '.kaggle/kaggle.json', '.git-credentials', '.pypirc']) assert.ok(secretPath(p), p);
  for (const p of ['output/report.xlsx', 'src/secret_santa.md', 'docs/secretary.txt', 'kaggle_notes.json']) assert.ok(!secretPath(p), p);
  assert.ok(credentialContent(Buffer.from('KEY=' + 'AKIA' + 'ABCD2345EFGH6789'))); assert.ok(credentialContent(Buffer.from('x configured-key y'), ['configured-key']));
  assert.ok(!credentialContent(Buffer.from('Total 1234.50, invoice 234567890123')));
});
