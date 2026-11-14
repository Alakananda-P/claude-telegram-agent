import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** The SDK level snapshot owns liveness; completion turns own result delivery.
 * Keep both until the final notification has been consumed, in either ordering. */
export class NativeBackground {
  private level = false;
  private live = new Set<string>();
  private draining = new Set<string>();
  private notified = new Set<string>();
  private consumed = new Set<string>();
  private runs = new Map<string, string>();
  get count() { return new Set([...this.live, ...this.draining, ...this.notified]).size; }
  private key(id: string, run?: string) { return id + ':' + (run ?? this.runs.get(id) ?? ''); }
  observe(event: SDKMessage) {
    if (event.type === 'result') {
      for (const key of this.notified) { this.consumed.add(key); this.draining.delete(key); }
      this.notified.clear();
    }
    if (event.type !== 'system') return;
    if (event.subtype === 'background_tasks_changed') {
      this.level = true;
      const next = new Set<string>();
      for (const task of event.tasks.filter(t => !t.ambient)) {
        if (task.run_id) this.runs.set(task.task_id, task.run_id);
        next.add(this.key(task.task_id, task.run_id));
      }
      for (const key of this.live) if (!next.has(key) && !this.consumed.has(key)) this.draining.add(key);
      this.live = next;
    } else if (event.subtype === 'task_started' && !event.ambient && !event.skip_transcript) {
      if (event.run_id) {
        const previous = this.runs.get(event.task_id);
        if (previous && event.run_id < previous) return;
        this.runs.set(event.task_id, event.run_id);
      }
      if (!this.level && event.is_backgrounded) this.live.add(this.key(event.task_id, event.run_id));
    } else if (event.subtype === 'task_updated' && !this.level && event.patch.is_backgrounded) {
      this.live.add(this.key(event.task_id, event.run_id));
    } else if (event.subtype === 'task_notification' && !event.ambient && !event.skip_transcript) {
      if (event.run_id && this.runs.has(event.task_id) && event.run_id < this.runs.get(event.task_id)!) return;
      const key = this.key(event.task_id, event.run_id);
      this.notified.add(key);
      if (!this.level) { this.live.delete(key); this.draining.add(key); }
    }
  }
}
