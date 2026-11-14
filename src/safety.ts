import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

interface TelegramFile { file_id: string; file_name?: string; file_size?: number; mime_type?: string }
interface TelegramVideo extends TelegramFile { width?: number; height?: number; duration?: number; thumbnail?: { file_id: string } }

export interface Message {
  message_id?: number;
  date?: number;
  from?: { id: number; is_bot?: boolean };
  reply_to_message?: Message;
  chat: { id: number; type: string };
  text?: string; caption?: string;
  document?: TelegramFile;
  voice?: TelegramFile & { duration?: number };
  audio?: TelegramFile & { duration?: number; title?: string; performer?: string };
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

export function redact(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
  result = result.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bbot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|KGAT_[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{25,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
    .replace(/\b(bot)?\d{6,14}:[A-Za-z0-9_-]{20,}/g, (_all, bot) => (bot ?? '') + '[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, '$1[REDACTED]$2');
  result = result.replace(/(\b(?:[a-z][a-z0-9_]*_)?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passwd|secret|token|kaggle[_ -]?key)\b["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s&;,<>{}"']+)/gi, (all, label, value) => {
    if (/^(?:["']?(?:process\.env\.|os\.environ|your_|replace_|<[^>]+>|\[REDACTED\]))/i.test(value)) return all;
    const quote = /^["']/.test(value) ? value[0] : '';
    return label + quote + '[REDACTED]' + quote;
  });
  return result.replace(/(\b(?:aadhaar|aadhar|adhaar|uidai)(?:\s*(?:number|no\.?))?\s*[:=]\s*)(?:\d[ -]?){11}\d\b/gi, '$1[REDACTED]')
    .replace(/(\bpan(?:\s*(?:card|number|no\.?))?\s*[:=]\s*)[A-Z]{5}\d{4}[A-Z]\b/gi, '$1[REDACTED]');
}

export function privatePreview(text: string, secrets: string[], limit: number): string {
  const safe = redact(text, secrets), marker = safe.lastIndexOf('[REDACTED]', limit);
  return safe.slice(0, marker >= 0 && marker + 10 > limit ? marker + 10 : limit);
}

/** Sanitize values before JSON escaping so quoting cannot break masking or JSON. */
export function safeJson(value: unknown, secrets: string[] = []): string {
  return JSON.stringify(value, (key, item) => typeof item !== 'string' ? item
    : /^(?:[\w-]+[_-])?(?:password|passwd|token|api[_-]?key|client[_-]?secret|private[_-]?key)$/i.test(key) ? '[REDACTED]' : redact(item, secrets));
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

export class PathAccessError extends Error { constructor(message: string, readonly code?: string) { super(message); } }
export async function safeFile(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\\') || secretPath(relative)) throw new PathAccessError('File path is not allowed. Use a relative file inside the current project.');
  const parts = relative.split('/');
  if (parts.some(p => p === '..' || p === '.' || !p)) throw new PathAccessError('File path is not allowed. Use a relative file inside the current project.');
  try {
    const base = await realpath(root);
    let target = base;
    for (const part of parts) {
      target = path.join(target, part);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new PathAccessError('Symlink transfers are not allowed. Choose a regular project file.');
    }
    if (!(await lstat(target)).isFile()) throw new PathAccessError('Choose a regular file, not a directory.');
    const resolved = await realpath(target);
    if (!resolved.startsWith(base + path.sep)) throw new PathAccessError('File path is outside the project.');
    return resolved;
  } catch (error) {
    if (error instanceof PathAccessError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new PathAccessError(code === 'ENOENT' || code === 'ENOTDIR' ? 'File not found in the current project. Check its relative path.'
      : code === 'EACCES' || code === 'EPERM' ? 'File access was denied by storage permissions.' : 'Project file storage is unavailable. Check storage and try again.', code);
  }
}
