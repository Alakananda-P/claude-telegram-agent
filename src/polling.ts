import { setTimeout as delay } from 'node:timers/promises';
import { TelegramError } from './telegram.js';
import type { Message, Callback } from './safety.js';
import type { StateStore, TelegramOutage } from './state.js';

interface PollClient { call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> }
interface PollOptions { now?: () => number; wait?: (ms: number, signal: AbortSignal) => Promise<void> }

function safeReason(error: unknown): string {
  if (!(error instanceof TelegramError)) return 'unclassified';
  if (error.code >= 100 && error.code <= 599) return `telegram_${error.code}`;
  return error.networkCode && /^(?:E[A-Z_]+|UND_ERR_[A-Z_]+)$/.test(error.networkCode) && error.networkCode.length <= 64 ? error.networkCode : 'network_error';
}

export async function poll(client: PollClient, store: StateStore, handle: (message: Message) => Promise<void>, signal: AbortSignal, handleCallback?: (callback: Callback) => Promise<void>, onRecovery?: (failures: number, outage: TelegramOutage) => Promise<void>, options: PollOptions = {}): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }).catch(() => {}));
  let failures = store.data.health?.telegramOutage?.failures ?? 0;
  let connected = false; let saveWarned = false;
  // B6: a full or failing disk must not stop polling; warn once per failure streak.
  const save = async () => {
    try { await store.save(); saveWarned = false; }
    catch (error) { if (!saveWarned) console.error(`Polling state could not be saved (${error instanceof Error ? error.name : 'unknown'}); polling continues in memory.`); saveWarned = true; }
  };
  while (!signal.aborted) {
    let updates: { update_id: number; message?: Message; callback_query?: Callback }[];
    try {
      updates = await client.call('getUpdates', { offset: store.data.offset, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query'] }, signal);
    } catch (error) {
      if (signal.aborted) return;
      failures++;
      const health = store.data.health ??= {};
      const outage = health.telegramOutage ??= { startedAt: new Date(now()).toISOString(), failures, reason: safeReason(error) };
      outage.failures = failures; outage.reason = safeReason(error);
      await save();
      if (error instanceof TelegramError && [401, 403, 409].includes(error.code)) throw error;
      const backoff = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      // B6: honour Telegram's retry_after on 429 (capped at one hour).
      const retryMs = error instanceof TelegramError && error.code === 429 && error.retryAfter > 0 ? Math.min(3_600_000, Math.max(backoff, error.retryAfter * 1000)) : backoff;
      console.warn(`Telegram polling unavailable (${outage.reason}); retrying with backoff.`);
      await wait(retryMs, signal);
      continue;
    }
    const health = store.data.health ??= {};
    health.telegramAt = new Date(now()).toISOString();
    let recovered: TelegramOutage | undefined;
    if (health.telegramOutage) {
      recovered = { ...health.telegramOutage, endedAt: health.telegramAt, durationMs: Math.max(0, now() - Date.parse(health.telegramOutage.startedAt)) };
      health.telegramOutages = [...(health.telegramOutages ?? []), recovered].slice(-50);
      delete health.telegramOutage;
    }
    await save();
    if (!connected || failures) console.log(`Telegram polling connected; recoveredFailures=${failures}${recovered ? '; outageMs=' + recovered.durationMs + '; reason=' + recovered.reason : ''}.`);
    connected = true; failures = 0;
    // A best-effort recovery notice must never throw fetched owner updates away.
    if (recovered && recovered.durationMs >= 60_000) {
      try { await onRecovery?.(recovered.failures, recovered); }
      catch { console.warn('Telegram recovery notice could not be delivered; continuing update dispatch.'); }
    }
    for (const update of updates) {
      if (signal.aborted) return;
      if (!Number.isSafeInteger(update.update_id) || update.update_id < store.data.offset) continue;
      store.data.offset = update.update_id + 1;
      // At-most-once dispatch: never blindly replay a destructive task after restart.
      await save();
      // M1: one failing update must not end polling (and with it the running task).
      try {
        if (update.message) await handle(update.message);
        if (update.callback_query && handleCallback) await handleCallback(update.callback_query);
      } catch (error) {
        if (error instanceof TelegramError && [401, 403, 409].includes(error.code)) throw error;
        if (signal.aborted) return;
        console.warn(`Update ${update.update_id} could not be handled (${error instanceof TelegramError ? safeReason(error) : error instanceof Error ? error.name : 'unknown'}); polling continues.`);
      }
    }
  }
}
