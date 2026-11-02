import test from 'node:test';
import assert from 'node:assert/strict';
import { SteeringInput } from '../src/steering.js';

test('steering preserves arrival order and fresh attempts replay only through a new cursor', async () => {
  const input = new SteeringInput(); const signal = new AbortController().signal;
  const first = input.stream('Initial task', signal); assert.equal((await first.next()).value!.message.content, 'Initial task');
  const next = first.next(); const one = input.add('Correction');
  const delivered = (await next).value!; assert.equal(delivered.message.content, 'Correction'); assert.equal(delivered.priority, 'next'); assert.equal(delivered.origin?.kind, 'human');
  const retry = input.stream('Initial task with recovered context', signal); await retry.next(); assert.equal((await retry.next()).value!.uuid, one.id);
  assert.equal(input.finish(), false); input.acknowledge([one.id]); assert.equal(input.finish(), true);
  assert.equal((await first.next()).done, true); assert.equal(input.reserve(), undefined); await retry.return(undefined);
});

test('an instruction being transcribed reserves the live session at a result boundary', async () => {
  const input = new SteeringInput(); const release = input.reserve()!; assert.equal(input.finish(), false);
  let settled = false; const ready = input.settled(new AbortController().signal).then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  const message = input.add('Spoken correction'); release(); await ready; assert.equal(input.finish(), false);
  input.acknowledge([message.id]); assert.equal(input.finish(), true);
});

test('abort releases an idle input iterator without publishing more work', async () => {
  const input = new SteeringInput(); const abort = new AbortController(); const stream = input.stream('Task', abort.signal); await stream.next();
  const pending = stream.next(); abort.abort(); await assert.rejects(pending); input.close();
});
