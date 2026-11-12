import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactSnapshot, changedArtifacts } from '../src/artifacts.js';
import { safeFile } from '../src/safety.js';

test('automatic delivery is output-only while explicit project file access remains available', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-artifacts-'));
  const put = async (file: string) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'content'); };
  await put('Coding_and_Experiments/project/data/train.csv'); await put('notes.txt');
  assert.deepEqual(Object.keys(await artifactSnapshot(root)), []);
  assert.equal(await safeFile(root, 'Coding_and_Experiments/project/data/train.csv'), path.join(root, 'Coding_and_Experiments/project/data/train.csv'));
  await put('output/bills.csv'); await put('output/client/table.xlsx'); await put('output/.env');
  await put('output/.cache/temp.json'); await put('output/result-1234.txt');
  assert.deepEqual(Object.keys(await artifactSnapshot(root)).sort(), ['output/bills.csv', 'output/client/table.xlsx']);
  const before = await artifactSnapshot(root); await put('output/new.pdf'); await put('data/raw.csv');
  assert.deepEqual(await changedArtifacts(root, before), ['output/new.pdf']);
});

test('automatic delivery refuses an output directory symlink and linked files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-artifact-links-'));
  const external = await mkdtemp(path.join(tmpdir(), 'tg-artifact-external-'));
  await writeFile(path.join(external, 'private.txt'), 'private');
  await symlink(external, path.join(root, 'output'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(Object.keys(await artifactSnapshot(root)), []);
  const regular = await mkdtemp(path.join(tmpdir(), 'tg-artifact-regular-')); await mkdir(path.join(regular, 'output'));
  try { await symlink(path.join(external, 'private.txt'), path.join(regular, 'output/leak.txt')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') { t.skip('Windows file symlink privilege unavailable; directory junction verified'); return; } throw error; }
  assert.deepEqual(Object.keys(await artifactSnapshot(regular)), []);
});
