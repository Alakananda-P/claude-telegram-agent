import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

interface TelegramFile { file_id: string; file_name?: string; file_size?: number; mime_type?: string }
interface TelegramVideo extends TelegramFile { width?: number; height?: number; duration?: number; thumbnail?: { file_id: string } }

export interface Message {
  message_id?: number;
  from?: { id: number };
  chat: { id: number; type: string };
  text?: string; caption?: string;
  document?: TelegramFile;
  video?: TelegramVideo;
  animation?: TelegramVideo;
  video_note?: TelegramFile & { length?: number; duration?: number };
  photo?: { file_id: string; file_unique_id?: string; width: number; height: number; file_size?: number }[];
  media_group_id?: string;
}
export interface Callback { id: string; from: { id: number }; data?: string; message?: Message }

export function authorized(message: Message, owner: number): boolean {
  return message.from?.id === owner && message.chat.type === 'private' && message.chat.id === owner;
}

export function redact(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
  return result.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
}

export function chunks(text: string, limit = 3500): string[] {
  const result: string[] = [];
  let rest = text;
  while (rest.length) {
    let end = Math.min(limit, rest.length);
    if (end < rest.length && /[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    result.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return result.length ? result : ['(No text output)'];
}

export function projectName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name)) throw new Error('Use a project name of 1-48 letters, digits, hyphens or underscores.');
  return name;
}

export function secretPath(relative: string): boolean {
  return relative.split(/[\\/]/).some(part => /^(\.env(?:\..*)?|\.git|\.ssh|\.aws|\.claude|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part)
    || /\.(pem|key|p12|pfx)$/i.test(part));
}

export async function safeFile(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\\') || secretPath(relative)) throw new Error('File path is not allowed.');
  const parts = relative.split('/');
  if (parts.some(p => p === '..' || p === '.' || !p)) throw new Error('File path is not allowed.');
  const base = await realpath(root);
  let target = base;
  for (const part of parts) {
    target = path.join(target, part);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('Symlink transfers are not allowed.');
  }
  if (!(await lstat(target)).isFile()) throw new Error('Choose a regular file.');
  const resolved = await realpath(target);
  if (!resolved.startsWith(base + path.sep)) throw new Error('File path is outside the project.');
  return resolved;
}
