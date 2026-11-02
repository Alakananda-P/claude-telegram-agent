import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export interface SteeringMessage { id: string; text: string; displayText: string; answered?: boolean }

/** One active conversation input. Each provider attempt gets its own cursor;
 * only pre-effect failover may replay it. Closing is atomic with accepting input. */
export class SteeringInput {
  readonly messages: SteeringMessage[] = [];
  private open = true;
  private preparing = 0;
  private listeners = new Set<() => void>();
  private changed() { for (const wake of [...this.listeners]) wake(); }
  get accepting() { return this.open; }
  reserve(): (() => void) | undefined {
    if (!this.open) return;
    this.preparing++; let released = false;
    return () => { if (!released) { released = true; this.preparing--; this.changed(); } };
  }
  add(text: string, displayText = text, id: string = randomUUID()): SteeringMessage {
    if (!this.open) throw new Error('Conversation input has closed.');
    const item = { id, text, displayText }; this.messages.push(item); this.changed(); return item;
  }
  acknowledge(ids: string[]) {
    // All messages use FIFO 'next' priority. The protocol retains at most 64
    // consumed UUIDs; the latest consumed ID also acknowledges earlier inputs.
    const last = this.messages.findLastIndex(m => ids.includes(m.id));
    this.messages.forEach((m, index) => { if (index <= last) m.answered = true; });
  }
  finish(): boolean {
    if (this.preparing || this.messages.some(m => !m.answered)) return false;
    this.close(); return true;
  }
  close() { this.open = false; this.changed(); }
  private wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const clean = () => { this.listeners.delete(wake); signal.removeEventListener('abort', cancel); };
      const wake = () => { clean(); resolve(); };
      const cancel = () => { clean(); reject(signal.reason); };
      this.listeners.add(wake); signal.addEventListener('abort', cancel, { once: true });
    });
  }
  async settled(signal: AbortSignal) { while (this.preparing && !signal.aborted) await this.wait(signal); signal.throwIfAborted(); }
  async complete(signal: AbortSignal): Promise<boolean> {
    // A reservation can arrive in the microtask between settled() resolving
    // and our continuation. Recheck synchronously before deciding to await a
    // provider result: a failed preparation may never send one more message.
    do { await this.settled(signal); } while (this.preparing);
    return this.finish();
  }
  async *stream(prompt: string, signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
    const frame = (text: string, uuid: string): SDKUserMessage => ({ type: 'user', uuid: uuid as SDKUserMessage['uuid'], parent_tool_use_id: null, message: { role: 'user', content: text }, priority: 'next', origin: { kind: 'human' } });
    yield frame(prompt, randomUUID());
    let cursor = 0;
    while (this.open || cursor < this.messages.length) {
      signal.throwIfAborted();
      if (cursor < this.messages.length) { const message = this.messages[cursor++]; yield frame(message.text, message.id); }
      else await this.wait(signal);
    }
  }
}
