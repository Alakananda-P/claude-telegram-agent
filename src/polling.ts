import { setTimeout as delay } from 'node:timers/promises';
import { TelegramError } from './telegram.js';
import type { Message, Callback } from './safety.js';
import type { StateStore } from './state.js';

interface PollClient { call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> }

export async function poll(client: PollClient, store: StateStore, handle: (message: Message) => Promise<void>, signal: AbortSignal, handleCallback?: (callback: Callback) => Promise<void>): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    let updates: { update_id: number; message?: Message; callback_query?: Callback }[];
    try {
      updates = await client.call('getUpdates', { offset: store.data.offset, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query'] }, signal);
      failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof TelegramError && [401, 403, 409].includes(error.code)) throw error;
      const retryMs = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
      console.warn('Telegram polling unavailable; retrying with backoff.');
      await delay(retryMs, undefined, { signal }).catch(() => {});
      continue;
    }
    for (const update of updates) {
      if (signal.aborted) return;
      if (!Number.isSafeInteger(update.update_id) || update.update_id < store.data.offset) continue;
      store.data.offset = update.update_id + 1;
      // At-most-once dispatch: never blindly replay a destructive task after restart.
      await store.save();
      if (update.message) await handle(update.message);
      if (update.callback_query && handleCallback) await handleCallback(update.callback_query);
    }
  }
}
