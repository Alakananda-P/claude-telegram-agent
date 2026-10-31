import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { editImage, validateBill } from '../src/images.js';
import { artifactSnapshot, changedArtifacts } from '../src/artifacts.js';
test('image crop/rotation preserves originals and rejects traversal', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-images-'));
  await mkdir(path.join(root, 'uploads'));
  const original = await sharp({ create: { width: 120, height: 80, channels: 3, background: 'white' } }).png().toBuffer();
  await writeFile(path.join(root, 'uploads', 'bill.png'), original);
  const before = await artifactSnapshot(root);
  const out = await editImage(root, 'uploads/bill.png', { crop: { left: 0, top: 0, width: 60, height: 40 }, rotate: 90, contrast: true });
  const meta = await sharp(await readFile(path.join(root, out.path))).metadata();
  assert.equal(meta.width, 40); assert.equal(meta.height, 60);
  assert.deepEqual(await readFile(path.join(root, 'uploads/bill.png')), original);
  assert.ok((await changedArtifacts(root, before)).includes(out.path));
  await assert.rejects(editImage(root, '../outside.png', {}), /path|allowed/i);
});
test('bill validation flags inconsistent totals and unresolved fields instead of guessing', () => {
  const result = validateBill([{ label: 'Item', quantity: 2, rate: 10, amount: 25 }], 20, 0, 0, ['Invoice date']);
  assert.equal(result.ready, false);
  assert.ok(result.issues.some(x => /Item/.test(x)));
  assert.ok(result.issues.some(x => /date/.test(x)));
  assert.equal(validateBill([{ label: 'Item', quantity: 2, rate: 10, amount: 20 }], 20).ready, true);
});

test('deskew detects a tilted bill grid and keeps the source intact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tg-deskew-'));
  const svg = '<svg width="500" height="600"><rect width="500" height="600" fill="white"/>' + Array.from({ length: 12 }, (_, i) => `<rect x="40" y="${50 + i * 40}" width="420" height="4" fill="black"/>`).join('') + '</svg>';
  const tilted = await sharp(Buffer.from(svg)).rotate(6, { background: 'white' }).png().toBuffer();
  await writeFile(path.join(root, 'bill.png'), tilted);
  const out = await editImage(root, 'bill.png', { deskew: true, contrast: true });
  assert.ok(Math.abs(out.deskewAngle + 6) <= 1, `Detected ${out.deskewAngle}`);
  assert.deepEqual(await readFile(path.join(root, 'bill.png')), tilted);
});
