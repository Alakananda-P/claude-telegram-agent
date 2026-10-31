import sharp from 'sharp';
import path from 'node:path';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safeFile } from './safety.js';

export interface ImageEdit { crop?: { left: number; top: number; width: number; height: number }; rotate?: number; contrast?: boolean; deskew?: boolean }
async function skewAngle(bytes: Buffer): Promise<number> {
  const { data, info } = await sharp(bytes).flatten({ background: 'white' }).resize(600, 600, { fit: 'inside', withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const points: [number, number][] = [];
  for (let y = 8; y < info.height - 8; y++) for (let x = 8; x < info.width - 8; x++) {
    if (data[y * info.width + x] < 100) points.push([x - info.width / 2, y - info.height / 2]);
  }
  if (points.length < 30) return 0;
  let best = 0; let bestScore = 0; let base = 0;
  for (let angle = -12; angle <= 12; angle += 0.5) {
    const rad = angle * Math.PI / 180, bins = new Float64Array(info.width + info.height + 10);
    for (const [x, y] of points) bins[Math.round(x * Math.sin(rad) + y * Math.cos(rad) + bins.length / 2)]++;
    let score = 0;
    for (let i = 0; i < bins.length; i++) score += bins[i] ** 2;
    if (angle === 0) base = score;
    if (score > bestScore) { bestScore = score; best = angle; }
  }
  return bestScore > base * 1.15 ? best : 0;
}
export async function editImage(root: string, source: string, edit: ImageEdit) {
  const file = await safeFile(root, source);
  let bytes = await sharp(file, { limitInputPixels: 40_000_000 }).autoOrient().toBuffer();
  if (edit.crop) {
    if (!Object.values(edit.crop).every(Number.isSafeInteger)) throw new Error('Crop coordinates must be whole pixels.');
    bytes = await sharp(bytes).extract(edit.crop).toBuffer();
  }
  const rotate = edit.rotate ?? 0;
  if (!Number.isFinite(rotate) || Math.abs(rotate) > 360) throw new Error('Rotation must be between -360 and 360 degrees.');
  if (rotate) bytes = await sharp(bytes).rotate(rotate, { background: 'white' }).toBuffer();
  const deskewAngle = edit.deskew ? await skewAngle(bytes) : 0;
  let image = sharp(bytes);
  if (deskewAngle) image = image.rotate(deskewAngle, { background: 'white' });
  if (edit.contrast) image = image.normalise();
  bytes = await image.jpeg({ quality: 95 }).toBuffer();
  const output = path.join(root, 'output'); await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink()) throw new Error('Invalid output directory.');
  const relative = 'output/image-' + randomUUID().slice(0, 8) + '.jpg';
  await writeFile(path.join(root, relative), bytes, { flag: 'wx', mode: 0o600 });
  const meta = await sharp(bytes).metadata();
  return { path: relative, width: meta.width, height: meta.height, deskewAngle, originalPreserved: true };
}
export function validateBill(rows: { label: string; quantity: number; rate: number; amount: number }[], total: number, charges = 0, discount = 0, uncertain: string[] = []) {
  const issues = uncertain.map(x => `Needs clarification: ${x}`);
  if (![total, charges, discount, ...rows.flatMap(r => [r.quantity, r.rate, r.amount])].every(Number.isFinite)) throw new Error('Bill values must be finite numbers.');
  const round = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
  for (const row of rows) if (Math.abs(round(row.quantity * row.rate) - row.amount) > 0.02) issues.push(`${row.label}: quantity × rate = ${round(row.quantity * row.rate)}, written amount = ${row.amount}.`);
  const expectedTotal = round(rows.reduce((sum, row) => sum + row.amount, 0) + charges - discount);
  if (Math.abs(expectedTotal - total) > 0.02) issues.push(`Calculated total ${expectedTotal} differs from written total ${total}.`);
  return { ready: issues.length === 0, expectedTotal, writtenTotal: total, issues,
    note: 'Arithmetic checks do not prove OCR accuracy. Never invent missing or unclear values; ask the owner with a crop.' };
}
