import { setTimeout as delay } from 'node:timers/promises';
import { chunks, redact } from './safety.js';

export class TelegramError extends Error {
  constructor(public code: number, public retryAfter = 0) { super(`Telegram request failed (status ${code}).`); }
}

export class Telegram {
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
        ok: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number };
      };
      if (response.ok && body.ok) return body.result as T;
      const code = body.error_code ?? response.status;
      const retryAfter = body.parameters?.retry_after ?? 0;
      // Only retry explicit rate-limit rejections, not ambiguous sent messages.
      if (code === 429 && retryAfter > 0 && retryAfter <= 10 && attempt < 2) {
        await delay(retryAfter * 1000, undefined, { signal });
        continue;
      }
      throw new TelegramError(code, retryAfter);
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
