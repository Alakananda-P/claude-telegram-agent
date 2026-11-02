import { setTimeout as delay } from 'node:timers/promises';
import { chunks, redact, type Message } from './safety.js';
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
  constructor(public code: number, public retryAfter = 0, public unchanged = false, public networkCode?: string, public messageMissing = false) { super(`Telegram request failed (status ${code}).`); }
}

export interface MessageListOptions { limit?: number; beforeMessageId?: number; messageId?: number; includeUi?: boolean }
export interface MessageDeletion { deleted: number[]; alreadyMissing: number[]; failed: { id: number; reason: string }[] }

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
        const sent = body.result as { message_id?: number; date?: number; text?: string; caption?: string; document?: { file_name?: string }; chat?: { id: number } } | undefined;
        if (this.timeline && method.startsWith('send') && sent?.message_id) {
          const ids = this.timeline.data.visibleMessageIds ??= [];
          if (!ids.includes(sent.message_id)) ids.push(sent.message_id);
          const chat = Number(sent.chat?.id ?? (form ? (payload as FormData).get('chat_id') : (payload as Record<string, unknown>).chat_id));
          const preview = sent.text ?? sent.caption ?? (sent.document?.file_name ? '[File: ' + sent.document.file_name + ']' : undefined) ?? String(form ? (payload as FormData).get('caption') ?? '' : (payload as Record<string, unknown>).text ?? (payload as Record<string, unknown>).caption ?? '');
          this.rememberSent(chat, sent.message_id, preview, sent.date ? sent.date * 1000 : Date.now(), method.slice(4).toLowerCase());
          await this.timeline.save();
        }
        if (this.timeline && method === 'editMessageText' && !form) {
          const p = payload as Record<string, unknown>;
          const record = this.timeline.data.botMessages?.find(m => m.chat === Number(p.chat_id) && m.id === Number(p.message_id));
          if (record) { record.preview = redact(String(p.text ?? ''), [this.token, ...this.secrets]).slice(0, 1000); await this.timeline.save(); }
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
      throw new TelegramError(code, retryAfter, code === 400 && /message is not modified/i.test(body.description ?? ''), undefined, code === 400 && /message to delete not found/i.test(body.description ?? ''));
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

  async remove(chat: number, id: number, signal?: AbortSignal): Promise<void> {
    await this.call('deleteMessage', { chat_id: chat, message_id: id }, signal);
    await this.forgetUi(chat, id, true);
  }

  private rememberSent(chat: number, id: number, preview: string, sentAt: number, kind: string): void {
    if (!this.timeline || !Number.isSafeInteger(chat) || chat <= 0 || !Number.isSafeInteger(id) || id <= 0) return;
    const records = this.timeline.data.botMessages ??= [];
    if (!records.some(m => m.chat === chat && m.id === id)) records.push({ id, chat, sentAt, preview: redact(preview, [this.token, ...this.secrets]).slice(0, 1000), kind });
    this.timeline.data.botMessages = records.slice(-2000);
  }

  async rememberBotReply(chat: number, message: Message): Promise<boolean> {
    if (!this.timeline || message.from?.id !== Number(this.token.split(':')[0]) || message.chat.id !== chat || message.chat.type !== 'private' || !Number.isSafeInteger(message.message_id) || message.message_id! <= 0 || !Number.isSafeInteger(message.date) || message.date! <= 0) return false;
    this.rememberSent(chat, message.message_id!, message.text ?? message.caption ?? '[Bot attachment]', message.date! * 1000, message.text ? 'message' : 'attachment');
    const ids = this.timeline.data.visibleMessageIds ??= []; if (!ids.includes(message.message_id!)) ids.push(message.message_id!);
    await this.timeline.save(); return true;
  }

  listBotMessages(chat: number, options: MessageListOptions = {}) {
    const visible = new Set(this.timeline?.data.visibleMessageIds ?? []);
    const ui = new Set([...(this.timeline?.data.uiMessages ?? []).filter(m => m.chat === chat).map(m => m.id), ...(this.timeline?.data.indicatorIds ?? [])]);
    const records = (this.timeline?.data.botMessages ?? []).filter(m => m.chat === chat && visible.has(m.id) && (options.messageId === undefined || m.id === options.messageId) && (options.beforeMessageId === undefined || m.id < options.beforeMessageId) && (options.includeUi || !ui.has(m.id))).sort((a, b) => b.id - a.id);
    return { messages: records.slice(0, Math.max(1, Math.min(50, options.limit ?? 20))).map(({ chat: _chat, ...m }) => ({ ...m, deletable: Date.now() - m.sentAt < 48 * 3600000 })), total: records.length,
      note: 'Only verified outgoing bot messages are listed. Telegram deletion normally requires age under 48 hours. Reply to an older unlisted bot message to identify it. Saved sessions and memory are separate.' };
  }

  async deleteBotMessages(chat: number, ids: number[], signal?: AbortSignal): Promise<MessageDeletion> {
    if (!ids.length || ids.length > 20 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Choose 1-20 valid message IDs from list_telegram_messages.');
    const result: MessageDeletion = { deleted: [], alreadyMissing: [], failed: [] };
    for (const id of new Set(ids)) {
      signal?.throwIfAborted();
      const record = this.timeline?.data.botMessages?.find(m => m.chat === chat && m.id === id);
      if (!record) { result.failed.push({ id, reason: 'untracked_or_not_owned' }); continue; }
      if (Date.now() - record.sentAt >= 48 * 3600000) { result.failed.push({ id, reason: 'too_old' }); continue; }
      try { await this.remove(chat, id, signal); result.deleted.push(id); }
      catch (error) {
        signal?.throwIfAborted();
        if (error instanceof TelegramError && error.messageMissing) { await this.forgetUi(chat, id, true); result.alreadyMissing.push(id); }
        else result.failed.push({ id, reason: error instanceof TelegramError && error.code >= 400 && error.code < 500 ? 'telegram_rejected' : 'unconfirmed' });
      }
    }
    return result;
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
    if (deleted) this.timeline.data.botMessages = this.timeline.data.botMessages?.filter(m => m.chat !== chat || m.id !== id);
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
    this.timeline.data.botMessages = this.timeline.data.botMessages?.filter(m => m.chat !== chat || remaining.includes(m.id));
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
