import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** The SDK level snapshot owns liveness; completion turns own result delivery.
 * Keep both until the final notification has been consumed, in either ordering. */
export class NativeBackground {
  private level = false;
  private live = new Set<string>();
  private draining = new Set<string>();
  private notified = new Set<string>();
  private consumed = new Set<string>();
  /** Notified helpers that have already seen one result after their notification. */
  private waited = new Set<string>();
  private runs = new Map<string, string>();
  /** Keys that really ran in the background. A foreground task (a long Bash or MCP call) also
   * sends task_started/task_notification, but its result returns inside the running turn,
   * so it must never hold the turn open (W48-06). */
  private backgrounded = new Set<string>();
  get count() { return new Set([...this.live, ...this.draining, ...this.notified]).size; }
  private key(id: string, run?: string) { return id + ':' + (run ?? this.runs.get(id) ?? ''); }
  private forget(key: string) { this.live.delete(key); this.draining.delete(key); this.notified.delete(key); this.waited.delete(key); this.consumed.add(key); }
  observe(event: SDKMessage) {
    if (event.type === 'result') {
      const origin = event.origin;
      for (const key of this.notified) {
        // A helper can finish while a human reply is still being generated.
        // That reply has not consumed the queued hand-back. New SDKs identify
        // the notification run or the in-process helper that owns the result.
        const delivered = !origin
          || (origin.kind === 'task-notification' && (!origin.runId || key.endsWith(':' + origin.runId)))
          || (origin.kind === 'peer' && !!origin.senderTaskId && key === this.key(origin.senderTaskId));
        // The first result after a notification may belong to a turn that was
        // already running. Any later result comes from a turn that started after
        // the hand-back was queued, so a helper that has left the SDK's live list
        // is settled even when that result carries another origin (H-26).
        const settled = !this.live.has(key) && this.waited.has(key);
        if (delivered || settled) { this.consumed.add(key); this.draining.delete(key); this.notified.delete(key); this.waited.delete(key); }
        else this.waited.add(key);
      }
    }
    if (event.type !== 'system') return;
    if (event.subtype === 'background_tasks_changed') {
      this.level = true;
      const next = new Set<string>(), ambient = new Set<string>();
      for (const task of event.tasks) {
        if (task.run_id) this.runs.set(task.task_id, task.run_id);
        const key = this.key(task.task_id, task.run_id);
        if (task.ambient) ambient.add(key); else { next.add(key); this.backgrounded.add(key); }
      }
      // A task that turned ambient is housekeeping now; its notification is ambient too, so forget it.
      for (const key of ambient) this.forget(key);
      for (const key of this.live) if (!next.has(key) && !this.consumed.has(key)) this.draining.add(key);
      this.live = next;
    } else if (event.subtype === 'task_started' && !event.ambient && !event.skip_transcript) {
      if (event.run_id) {
        const previous = this.runs.get(event.task_id);
        if (previous && event.run_id < previous) return;
        this.runs.set(event.task_id, event.run_id);
      }
      if (event.is_backgrounded) { const key = this.key(event.task_id, event.run_id); this.backgrounded.add(key); if (!this.level) this.live.add(key); }
    } else if (event.subtype === 'task_updated' && event.patch.is_backgrounded) {
      const key = this.key(event.task_id, event.run_id); this.backgrounded.add(key);
      if (!this.level) this.live.add(key);
    } else if (event.subtype === 'task_notification' && !event.ambient && !event.skip_transcript) {
      if (event.run_id && this.runs.has(event.task_id) && event.run_id < this.runs.get(event.task_id)!) return;
      const key = this.key(event.task_id, event.run_id);
      // Foreground tasks finish inside the turn: no later hand-back will consume them.
      if (!this.backgrounded.has(key) && !this.live.has(key)) return;
      this.notified.add(key);
      if (!this.level) { this.live.delete(key); this.draining.add(key); }
    }
  }
}
