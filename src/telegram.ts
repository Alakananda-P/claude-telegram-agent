import { setTimeout as delay } from 'node:timers/promises';
import { chunks, redact } from './safety.js';
import type { Buttons } from './ui.js';
import type { StateStore } from './state.js';

export class TelegramError extends Error {
  constructor(public code: number, public retryAfter = 0, public unchanged = false) { super(`Telegram request failed (status ${code}).`); }
}

export class Telegram {
  timeline?: StateStore;
  constructor(private token: string, private secrets: string[], private base = 'https://api.telegram.org') {}

  async call<T = unknown>(method: string, payload: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const form = payload instanceof FormData;
      const response = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST', headers: form ? undefined : { 'Content-Type': 'application/json' },
        body: form ? payload : JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
      }).catch(() => { throw new TelegramError(0); });
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
  }

  async typing(chat: number): Promise<void> { await this.call('sendChatAction', { chat_id: chat, action: 'typing' }); }

  async panel(chat: number, text: string, buttons: Buttons, editId?: number): Promise<void> {
    const payload = { chat_id: chat, text: redact(text, [this.token, ...this.secrets]),
      reply_markup: { inline_keyboard: buttons }, link_preview_options: { is_disabled: true } };
    if (editId !== undefined) {
      try { await this.call('editMessageText', { ...payload, message_id: editId }); return; }
      catch (e) { if (e instanceof TelegramError && e.unchanged) return; if (!(e instanceof TelegramError) || e.code !== 400) throw e; }
      // A removed/too-old panel is replaced. Ordinary navigation edits in place.
    }
    await this.call('sendMessage', payload);
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
      catch { remaining.push(...batch); }
    }
    this.timeline.data.visibleMessageIds = remaining;
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

  async download(fileId: string): Promise<Buffer> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
    if (!file.file_path || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) || file.file_path.split('/').includes('..')) throw new Error('Invalid Telegram file path.');
    if ((file.file_size ?? 0) > 20_000_000) throw new Error('Upload exceeds the 20 MB limit.');
    const response = await fetch(`${this.base}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(45_000), redirect: 'error' })
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
