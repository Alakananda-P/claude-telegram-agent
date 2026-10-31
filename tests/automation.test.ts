import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.js';
import { Automation, clockInfo } from '../src/automation.js';

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tg-automation-'));
  const store = await StateStore.open(path.join(dir, 'state.json'));
  return { store, engine: new Automation(store) };
}
test('queue survives restart; running work is interrupted, never blindly repeated', async () => {
  const { store, engine } = await setup();
  await engine.enqueue({ kind: 'agent', project: 'default', chatKey: 'draft-a', prompt: 'first' });
  const next = await engine.enqueue({ kind: 'agent', project: 'default', chatKey: 'draft-a', prompt: 'second' });
  const first = await engine.claim();
  assert.equal(first?.prompt, 'first');
  const reopened = await StateStore.open(store.file);
  assert.equal(reopened.data.tasks![0].status, 'interrupted');
  assert.equal((await new Automation(reopened).claim())?.id, next.id);
});
test('cron respects IST, claims a due run once and coalesces missed occurrences', async () => {
  const { store, engine } = await setup();
  const start = new Date('2026-10-31T01:00:00Z');
  const s = await engine.createSchedule({ name: 'Morning reminder', kind: 'reminder', prompt: 'Check bills', project: 'default', cron: '0 9 * * *', timezone: 'Asia/Kolkata' }, start);
  assert.equal(s.nextRun, '2026-10-31T03:30:00.000Z');
  await engine.tick(new Date('2026-11-02T04:00:00Z'));
  await engine.tick(new Date('2026-11-02T04:00:01Z'));
  assert.equal(store.data.tasks!.length, 1);
  assert.equal(s.nextRun, '2026-11-03T03:30:00.000Z');
  assert.equal(clockInfo('Asia/Kolkata', start).timezone, 'Asia/Kolkata');
});
test('schedule pause/resume, one-off execution and queue controls persist', async () => {
  const { store, engine } = await setup();
  const start = new Date('2026-10-31T01:00:00Z');
  const s = await engine.createSchedule({ name: 'One', kind: 'reminder', prompt: 'Call supplier', project: 'default', at: '2026-10-31T02:00:00Z' }, start);
  await engine.changeSchedule(s.id, 'pause');
  await engine.tick(new Date('2026-10-31T03:00:00Z'));
  assert.equal(store.data.tasks!.length, 0);
  await engine.changeSchedule(s.id, 'resume', new Date('2026-10-31T01:30:00Z'));
  await engine.tick(new Date('2026-10-31T02:00:01Z'));
  assert.equal(s.enabled, false);
  await engine.setPaused(true);
  assert.equal(await engine.claim(), undefined);
  await engine.cancelTask(store.data.tasks![0].id);
  await engine.setPaused(false);
  assert.equal(await engine.claim(), undefined);
});

test('DST recurrence follows local time and editing atomically replaces pending occurrences', async () => {
  const { store, engine } = await setup();
  const s = await engine.createSchedule({ name: 'Local nine', kind: 'reminder', prompt: 'Reminder', project: 'default', timezone: 'America/New_York', cron: '0 9 * * *' }, new Date('2026-10-31T00:00:00Z'));
  assert.equal(s.nextRun, '2026-10-31T13:00:00.000Z');
  await engine.tick(new Date('2026-10-31T13:00:01Z')); assert.equal(s.nextRun, '2026-11-01T14:00:00.000Z');
  await engine.editSchedule(s.id, { name: 'Edited', kind: 'reminder', prompt: 'New reminder', project: 'default', intervalMinutes: 5 });
  assert.equal(store.data.schedules!.length, 1); assert.equal(store.data.tasks![0].status, 'cancelled');
  await assert.rejects(engine.editSchedule(s.id, { name: 'Broken', kind: 'reminder', prompt: 'No', project: 'default', cron: 'invalid' }));
  assert.equal(store.data.schedules![0].name, 'Edited');
});
test('corrupt persisted queue records fail closed instead of executing malformed work', async () => {
  const { store } = await setup();
  await writeFile(store.file, JSON.stringify({ ...store.data, tasks: [{ id: 'bad', status: 'queued', project: '../outside', prompt: 'run' }] }));
  await assert.rejects(StateStore.open(store.file), /invalid automation/);
});
