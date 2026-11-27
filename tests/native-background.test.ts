import test from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { NativeBackground } from '../src/native-background.js';

const sys = (x: Record<string, unknown>) => ({ type: 'system', ...x }) as unknown as SDKMessage;
const human = sys({}) && ({ type: 'result', subtype: 'success', origin: { kind: 'human' } } as unknown as SDKMessage);

test('foreground task pairs are not counted as pending helpers', () => {
  const b = new NativeBackground();
  b.observe(sys({ subtype: 'task_started', task_id: 'b1', run_id: 'r1', task_type: 'local_bash', description: 'x', is_backgrounded: false }));
  b.observe(sys({ subtype: 'task_notification', task_id: 'b1', run_id: 'r1', status: 'completed' }));
  b.observe(human);
  assert.equal(b.count, 0);
});

test('a backgrounded helper is counted until its hand-back is consumed', () => {
  const b = new NativeBackground();
  b.observe(sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', run_id: 'r1', task_type: 'local_agent', description: 'Audit' }] }));
  assert.equal(b.count, 1);
  b.observe(sys({ subtype: 'task_notification', task_id: 'a1', run_id: 'r1', status: 'completed' }));
  b.observe(sys({ subtype: 'background_tasks_changed', tasks: [] }));
  assert.equal(b.count, 1, 'notified but not yet delivered');
  b.observe({ type: 'result', subtype: 'success', origin: { kind: 'task-notification', runId: 'r1' } } as unknown as SDKMessage);
  assert.equal(b.count, 0);
});

test('a task that turns ambient stops counting', () => {
  const b = new NativeBackground();
  b.observe(sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'w1', run_id: 'r1', task_type: 'local_bash', description: 'watch' }] }));
  assert.equal(b.count, 1);
  b.observe(sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'w1', run_id: 'r1', task_type: 'local_bash', description: 'watch', ambient: true }] }));
  assert.equal(b.count, 0);
});

test('a foreground task later moved to the background is counted (task_updated)', () => {
  const b = new NativeBackground();
  b.observe(sys({ subtype: 'task_started', task_id: 'b2', run_id: 'r1', task_type: 'local_bash', description: 'long', is_backgrounded: false }));
  b.observe(sys({ subtype: 'task_updated', task_id: 'b2', run_id: 'r1', patch: { is_backgrounded: true } }));
  assert.equal(b.count, 1);
});
