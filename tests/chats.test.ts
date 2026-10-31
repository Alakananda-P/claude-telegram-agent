import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatArchive } from '../src/chats.js';

test('chat archives retain turns across fresh chats, session binding and restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-chats-'));
  const chats = new ChatArchive(dir, ['private-secret']);
  await chats.append('draft-default', { role: 'user', text: 'Remember private-secret' });
  await chats.bind('draft-default', 'session-1');
  await chats.append('session-1', { role: 'assistant', text: 'Ready' });
  await chats.append('draft-default', { role: 'user', text: 'New task' });
  await chats.bind('draft-default', 'session-2');
  const reopened = new ChatArchive(dir, ['private-secret']);
  assert.deepEqual((await reopened.read('session-1')).map(x => x.text), ['Remember [REDACTED]', 'Ready']);
  assert.deepEqual((await reopened.read('session-2')).map(x => x.text), ['New task']);
});

test('legacy chat previews exclude tool results, reasoning and sidechain messages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-chat-import-'));
  const history = path.join(dir, 'projects', '-data-workspaces-default'); await mkdir(history, { recursive: true });
  const common = { cwd: '/data/workspaces/default', timestamp: '2026-10-31T10:00:00Z' };
  await writeFile(path.join(history, 'session-old.jsonl'), [
    { ...common, type: 'user', uuid: 'u1', message: { content: 'Make a sheet' } },
    { ...common, type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: 'hidden reasoning' }] } },
    { ...common, type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', content: 'private tool output' }] } },
    { ...common, type: 'assistant', uuid: 'a2', isSidechain: true, message: { content: 'private helper' } },
    { ...common, type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'Sheet ready' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const chats = new ChatArchive(path.join(dir, 'archive'), []);
  const recovered = await chats.importHistory(path.join(dir, 'projects'));
  assert.equal(recovered[0].project, 'default');
  assert.deepEqual((await chats.read('session-old')).map(x => x.text), ['Make a sheet', 'Sheet ready']);
});
