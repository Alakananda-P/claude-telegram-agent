/** D4: one edited status message per long-running helper group or background job.
 * Telegram failures are swallowed: a status line must never break the work it describes. */
export interface StatusMessenger { temporary(chat: number, text: string): Promise<number>; edit(chat: number, id: number, text: string): Promise<void> }

const span = (ms: number) => { const m = Math.floor(Math.max(0, ms) / 60_000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
export function statusLine(description: string, startedAt: number, lastActivity: number | undefined, now: number): string {
  return `⏳ ${description} chal rha h · ${span(now - startedAt)}` + (lastActivity !== undefined ? ` · last activity ${now - lastActivity < 60_000 ? 'just now' : span(now - lastActivity) + ' ago'}` : '');
}

export class LiveStatus {
  id?: number;
  lastActivity?: number;
  private timer?: ReturnType<typeof setInterval>;
  private work: Promise<void> = Promise.resolve();
  private done = false;
  readonly startedAt: number;
  /** The first message appears after one interval, so short work stays silent. */
  constructor(private messenger: StatusMessenger, private chat: number, public description: string, private intervalMs = 50_000, private now = () => Date.now(), private activity?: () => number | undefined) {
    this.startedAt = now();
    this.timer = setInterval(() => void this.update(), intervalMs); this.timer.unref?.();
  }
  touch(): void { this.lastActivity = this.now(); }
  private queue(action: () => Promise<void>): Promise<void> { this.work = this.work.then(action).catch(() => {}); return this.work; }
  update(): Promise<void> {
    return this.queue(async () => {
      if (this.done) return;
      const text = statusLine(this.description, this.startedAt, this.activity?.() ?? this.lastActivity, this.now());
      if (this.id === undefined) this.id = await this.messenger.temporary(this.chat, text);
      else await this.messenger.edit(this.chat, this.id, text);
    });
  }
  /** Final ✅/❌ line; only edits a message that was already shown. */
  finish(ok: boolean, note = ''): Promise<void> {
    clearInterval(this.timer);
    return this.queue(async () => {
      if (this.done) return; this.done = true;
      if (this.id !== undefined) await this.messenger.edit(this.chat, this.id, `${ok ? '✅' : '❌'} ${this.description} · ${span(this.now() - this.startedAt)}${note ? ' · ' + note : ''}`);
    });
  }
}
