import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStatus, statusLine } from '../src/live-status.js';

const fake = (failEdits = false) => {
  const sent: string[] = [], edits: { id: number; text: string }[] = [];
  return { sent, edits, messenger: { async temporary(_c: number, text: string) { sent.push(text); return 7; }, async edit(_c: number, id: number, text: string) { if (failEdits) throw new Error('telegram down'); edits.push({ id, text }); } } };
};

test('status line shows elapsed time and last activity', () => {
  assert.equal(statusLine('Background job “sync”', 0, 5 * 60_000, 6 * 60_000), '⏳ Background job “sync” chal rha h · 6m · last activity 1m ago');
  assert.equal(statusLine('2 helpers', 0, 6 * 60_000 - 5000, 6 * 60_000), '⏳ 2 helpers chal rha h · 6m · last activity just now');
  assert.equal(statusLine('x', 0, undefined, 125 * 60_000), '⏳ x chal rha h · 2h 5m');
});

test('one status message is sent, edited on each interval and finalised once; short work stays silent', async () => {
  const { sent, edits, messenger } = fake();
  let now = 0; const status = new LiveStatus(messenger, 1, 'Background job “sync”', 20, () => now);
  await new Promise(r => setTimeout(r, 70)); now = 6 * 60_000; status.touch(); await status.update();
  assert.equal(sent.length, 1); assert.ok(edits.length >= 1); assert.ok(edits.every(e => e.id === 7));
  assert.match(edits.at(-1)!.text, /chal rha h · 6m · last activity just now/);
  await status.finish(false, 'failed'); await status.finish(true);
  assert.equal(edits.at(-1)!.text, '❌ Background job “sync” · 6m · failed');
  const count = edits.length; await new Promise(r => setTimeout(r, 50)); assert.equal(edits.length, count, 'no edits after finish');
  const quiet = fake(); const short = new LiveStatus(quiet.messenger, 1, 'quick', 60_000);
  await short.finish(true); assert.equal(quiet.sent.length + quiet.edits.length, 0);
});

test('failed Telegram edits never throw', async () => {
  const { messenger } = fake(true);
  const status = new LiveStatus(messenger, 1, 'job', 60_000); await status.update(); await status.update(); await status.finish(true);
});
