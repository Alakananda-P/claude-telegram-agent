import { setTimeout as delay } from 'node:timers/promises';
import { chunks, redact } from './safety.js';
import type { Buttons } from './ui.js';
import type { StateStore } from './state.js';
import { Agent, fetch, FormData } from 'undici';
import type { LookupFunction } from 'node:net';

export function createTelegramDispatcher(lookup?: LookupFunction): Agent {
  // Render's dual-stack fetch attempted an unreachable IPv6 path after the
  // IPv4 attempt timed out; a same-host IPv4-only Telegram probe returned 200.
  return new Agent({ connect: { family: 4, autoSelectFamily: false, lookup } });
}
const telegramDispatcher = createTelegramDispatcher();

export class TelegramError extends Error {
  constructor(public code: number, public retryAfter = 0, public unchanged = false, public networkCode?: string) { super(`Telegram request failed (status ${code}).`); }
}

function networkCode(error: unknown): string {
  const e = error as { name?: string; cause?: { code?: string } };
  const code = e?.cause?.code;
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return code;
  return e?.name === 'TimeoutError' ? 'TIMEOUT' : e?.name === 'AbortError' ? 'ABORTED' : 'NETWORK';
}

export class Telegram {
  timeline?: StateStore;
  private uiWork: Promise<unknown> = Promise.resolve();
  constructor(private token: string, private secrets: string[], private base = 'https://api.telegram.org', private dispatcher = telegramDispatcher) {}

  async call<T = unknown>(method: string, payload: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const form = payload instanceof FormData;
      const response = await fetch(`${this.base}/bot${this.token}/${method}`, {
        dispatcher: this.dispatcher,
        method: 'POST', headers: form ? undefined : { 'Content-Type': 'application/json' },
        body: form ? payload : JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
      }).catch(error => { throw new TelegramError(0, 0, false, networkCode(error)); });
      const body = await response.json().catch(() => { throw new TelegramError(response.status); }) as {
        ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number };
      };
      if (response.ok && body.ok) {
        const sent = body.result as { message_id?: number } | undefined;
        if (this.timeline && method.startsWith('send') && sent?.message_id) {
          const ids = this.timeline.data.visibleMessageIds ??= [];
          if (!ids.includes(sent.message_id)) ids.push(sent.message_id);
          await this.timeline.save();
        }
        return body.result as T;
      }
      const code = body.error_code ?? response.status;
      const retryAfter = body.parameters?.retry_after ?? 0;
      // Only retry explicit rate-limit rejections, not ambiguous sent messages.
      if (code === 429 && retryAfter > 0 && retryAfter <= 10 && attempt < 2) {
        await delay(retryAfter * 1000, undefined, { signal });
        continue;
      }
      throw new TelegramError(code, retryAfter, code === 400 && /message is not modified/i.test(body.description ?? ''));
    }
    throw new TelegramError(429);
  }

  async send(chat: number, text: string): Promise<void> {
    const parts = chunks(redact(text, [this.token, ...this.secrets]));
    for (let i = 0; i < parts.length; i++) {
      await this.call('sendMessage', { chat_id: chat, text: parts[i], link_preview_options: { is_disabled: true } });
      if (i < parts.length - 1) await delay(1100);
    }
  }

  async temporary(chat: number, text: string): Promise<number> {
    const result = await this.call<{ message_id: number }>('sendMessage', { chat_id: chat, text, disable_notification: true });
    return result.message_id;
  }

  async edit(chat: number, id: number, text: string): Promise<void> {
    await this.call('editMessageText', { chat_id: chat, message_id: id, text: redact(text, [this.token, ...this.secrets]) });
  }

  async remove(chat: number, id: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chat, message_id: id });
    await this.forgetUi(chat, id, true);
  }

  async typing(chat: number): Promise<void> { await this.call('sendChatAction', { chat_id: chat, action: 'typing' }); }

  async panel(chat: number, text: string, buttons: Buttons, editId?: number, scope = 'controls'): Promise<void> {
    return this.serializeUi(async () => {
      editId ??= this.timeline?.data.uiMessages?.findLast(m => m.chat === chat && m.kind === 'panel' && m.scope === scope)?.id;
    const payload = { chat_id: chat, text: redact(text, [this.token, ...this.secrets]),
      reply_markup: { inline_keyboard: buttons }, link_preview_options: { is_disabled: true } };
    let id = editId;
    if (editId !== undefined) {
      try { await this.call('editMessageText', { ...payload, message_id: editId }); }
      catch (e) {
        if (!(e instanceof TelegramError) || (!e.unchanged && e.code !== 400)) throw e;
        if (!e.unchanged) { await this.forgetUi(chat, editId); id = undefined; }
      }
      // A removed/too-old panel is replaced. Ordinary navigation edits in place.
    }
    if (id === undefined) id = (await this.call<{ message_id: number }>('sendMessage', payload)).message_id;
    await this.trackUi(chat, id, 'panel', scope);
    for (const previous of this.timeline?.data.uiMessages ?? []) {
      if (previous.chat === chat && previous.kind === 'panel' && previous.scope === scope && previous.id !== id) previous.expiresAt = Date.now();
    }
    await this.cleanupUi(chat, Date.now());
    });
  }

  private serializeUi<T>(action: () => Promise<T>): Promise<T> {
    const task = this.uiWork.then(action); this.uiWork = task.catch(() => {}); return task;
  }
  private async trackUi(chat: number, id: number, kind: 'panel' | 'notice', scope: string, ttlMs = 300000): Promise<void> {
    if (!this.timeline) return;
    const list = this.timeline.data.uiMessages ??= [];
    const previous = list.find(m => m.chat === chat && m.id === id);
    const record = { id, chat, kind, scope, createdAt: previous?.createdAt ?? Date.now(), expiresAt: Date.now() + ttlMs };
    if (previous) Object.assign(previous, record, { retryAt: undefined, attempts: undefined }); else list.push(record);
    await this.timeline.save();
  }
  private async forgetUi(chat: number, id: number, deleted = false): Promise<void> {
    if (!this.timeline) return;
    this.timeline.data.uiMessages = this.timeline.data.uiMessages?.filter(m => m.chat !== chat || m.id !== id);
    if (deleted) this.timeline.data.visibleMessageIds = this.timeline.data.visibleMessageIds?.filter(m => m !== id);
    await this.timeline.save();
  }
  async notice(chat: number, text: string, scope = 'notices', ttlMs = 300000): Promise<void> {
    return this.serializeUi(async () => {
      for (const part of chunks(redact(text, [this.token, ...this.secrets]))) {
        const sent = await this.call<{ message_id: number }>('sendMessage', { chat_id: chat, text: part, disable_notification: true, link_preview_options: { is_disabled: true } });
        await this.trackUi(chat, sent.message_id, 'notice', scope, ttlMs);
      }
    });
  }
  async dismiss(chat: number, scope?: string, graceMs = 0): Promise<void> {
    return this.serializeUi(async () => {
      if (!this.timeline) return;
      const due = Date.now() + graceMs;
      let changed = false;
      for (const m of this.timeline.data.uiMessages ?? []) if (m.chat === chat && (scope === undefined || m.scope === scope)) { m.expiresAt = Math.min(m.expiresAt, due); changed = true; }
      if (changed) await this.timeline.save();
      if (!graceMs) await this.cleanupUi(chat, Date.now());
    });
  }
  async cleanup(chat: number, now = Date.now()): Promise<void> { return this.serializeUi(() => this.cleanupUi(chat, now)); }
  private async cleanupUi(chat: number, now: number): Promise<void> {
    if (!this.timeline) return;
    const due = (this.timeline.data.uiMessages ?? []).filter(m => m.chat === chat && m.expiresAt <= now && (m.retryAt ?? 0) <= now).slice(0, 20);
    let removed = 0;
    for (const m of due) {
      try { await this.remove(chat, m.id); removed++; }
      catch (e) {
        if (e instanceof TelegramError && e.code === 400) { await this.forgetUi(chat, m.id); continue; }
        m.attempts = (m.attempts ?? 0) + 1;
        m.retryAt = now + Math.min(300000, 5000 * 2 ** Math.min(m.attempts, 6));
        await this.timeline.save();
        break; // Do not flood an unavailable or rate-limited Telegram endpoint.
      }
    }
    if (removed) console.log(`Temporary UI cleanup: removed=${removed}.`);
  }

  async acknowledge(id: string): Promise<void> { await this.call('answerCallbackQuery', { callback_query_id: id }); }

  async clear(chat: number, includeLegacy = false): Promise<boolean> {
    if (!this.timeline) return false;
    if (includeLegacy) {
      const last = await this.temporary(chat, 'Preparing your new workspace…');
      // Explicit one-time owner-requested reset of this dedicated private chat.
      this.timeline.data.visibleMessageIds = Array.from({ length: last }, (_, i) => i + 1);
      await this.timeline.save();
    }
    const ids = [...new Set(this.timeline.data.visibleMessageIds ?? [])];
    const remaining: number[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      try { await this.call('deleteMessages', { chat_id: chat, message_ids: batch }); }
      catch (error) {
        if (!(error instanceof TelegramError) || error.code !== 400) { remaining.push(...batch); continue; }
        // One old message can reject the entire batch. Still remove the newer
        // messages that Telegram permits instead of leaving the whole view.
        for (const id of batch) {
          try { await this.remove(chat, id); } catch { remaining.push(id); }
        }
      }
    }
    this.timeline.data.visibleMessageIds = remaining;
    this.timeline.data.uiMessages = this.timeline.data.uiMessages?.filter(m => remaining.includes(m.id));
    await this.timeline.save();
    return remaining.length === 0;
  }

  async sendFile(chat: number, name: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 49_000_000) throw new Error('File exceeds the 49 MB transfer limit.');
    for (const secret of [this.token, ...this.secrets].filter(Boolean)) {
      if (Buffer.from(bytes).includes(Buffer.from(secret))) throw new Error('File contains a configured secret; transfer refused.');
    }
    const form = new FormData();
    form.set('chat_id', String(chat));
    form.set('document', new Blob([new Uint8Array(bytes)]), name);
    await this.call('sendDocument', form);
  }
  async sendPhoto(chat: number, name: string, bytes: Uint8Array, caption = ''): Promise<void> {
    if (bytes.byteLength > 9_500_000) return this.sendFile(chat, name, bytes);
    for (const secret of [this.token, ...this.secrets].filter(Boolean)) if (Buffer.from(bytes).includes(Buffer.from(secret))) throw new Error('Image contains a configured secret.');
    const form = new FormData(); form.set('chat_id', String(chat));
    form.set('photo', new Blob([new Uint8Array(bytes)]), name);
    if (caption) form.set('caption', redact(caption, [this.token, ...this.secrets]).slice(0, 1000));
    await this.call('sendPhoto', form);
  }

  async download(fileId: string): Promise<Buffer> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!file.file_path || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) || file.file_path.split('/').includes('..')) throw new Error('Invalid Telegram file path.');
    if ((file.file_size ?? 0) > 20_000_000) throw new Error('Upload exceeds the 20 MB limit.');
    const response = await fetch(`${this.base}/file/bot${this.token}/${file.file_path}`, { dispatcher: this.dispatcher, signal: AbortSignal.timeout(45_000), redirect: 'error' })
      .catch(() => { throw new TelegramError(0); });
    if (!response.ok || !response.body) throw new TelegramError(response.status);
    const reader = response.body.getReader();
    const buffers: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 20_000_000) throw new Error('Upload exceeds the 20 MB limit.');
        buffers.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(buffers);
  }
}
