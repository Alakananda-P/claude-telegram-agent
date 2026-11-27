import path from 'node:path';
import { lstat, realpath, readFile } from 'node:fs/promises';

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
  /** Telegram partial quote: the part of reply_to_message the owner selected. */
  quote?: { text: string };
}
export interface Callback { id: string; from: { id: number }; data?: string; message?: Message }

export function authorized(message: Message, owner: number): boolean {
  return message.from?.id === owner && message.chat.type === 'private' && message.chat.id === owner;
}

/** H-11 / C1: one table of well-known token shapes for redact(), detectTokens() and maskTokens(). */
const TOKEN_PATTERNS: [string, RegExp][] = [
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{8,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['Kaggle token', /\bKGAT_[A-Za-z0-9_-]{16,}/g],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['OpenAI key', /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['ElevenLabs key', /\bsk_[a-f0-9]{32,}\b/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{25,}/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Render API key', /\brnd_[A-Za-z0-9]{20,}/g],
  ['Slack token', /\bxox[abposre]-[A-Za-z0-9-]{10,}/g],
  ['Modal token', /\ba[ks]-[A-Za-z0-9]{20,}\b/g],
];
// Verhoeff tables: a bare 12-digit number is masked as Aadhaar only when its check digit is valid.
const VD = ['0123456789', '1234067895', '2340178956', '3401289567', '4012395678', '5987604321', '6598710432', '7659821043', '8765932104', '9876543210'].map(r => [...r].map(Number));
const VP = ['0123456789', '1576283094', '5803796142', '8916043527', '9453126870', '4286573901', '2793806415', '7046913258'].map(r => [...r].map(Number));
export function verhoeffValid(digits: string): boolean { if (!/^\d+$/.test(digits)) return false; let c = 0; [...digits].reverse().forEach((d, i) => { c = VD[c][VP[i % 8][Number(d)]]; }); return c === 0; }

export function redact(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
  result = result.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bbot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]')
    .replace(/\b(bot)?\d{6,14}:[A-Za-z0-9_-]{20,}/g, (_all, bot) => (bot ?? '') + '[REDACTED]');
  for (const [, re] of TOKEN_PATTERNS) result = result.replace(re, '[REDACTED]');
  result = result.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, '$1[REDACTED]$2');
  result = result.replace(/(\b(?:[a-z][a-z0-9_]*_)?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passwd|secret|token|kaggle[_ -]?key)\b["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s&;,<>{}"']+)/gi, (all, label, value) => {
    if (/^(?:["']?(?:process\.env\.|os\.environ|your_|replace_|<[^>]+>|\[REDACTED\]))/i.test(value)) return all;
    const quote = /^["']/.test(value) ? value[0] : '';
    return label + quote + '[REDACTED]' + quote;
  });
  return result.replace(/(\b(?:aadhaar|aadhar|adhaar|uidai)(?:\s*(?:number|no\.?))?\s*[:=]\s*)(?:\d[ -]?){11}\d\b/gi, '$1[REDACTED]')
    // C1: a bare Aadhaar (2-9 first, 12 digits or 4-4-4) only when the Verhoeff check digit holds; amounts and most invoice numbers stay.
    .replace(/(?<![\w.,/-])([2-9]\d{3})([ -]?)(\d{4})\2(\d{4})(?![\w]|[.,/-]\d)/g, (all, a, _sep, b, c) => verhoeffValid(a + b + c) ? '[REDACTED]' : all)
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

// C2: key files and secret folders never leave through /get, deliver_file, /files, auto-send or project backups.
export function secretPath(relative: string): boolean {
  return relative.split(/[\\/]/).some(part => /^(\.env(?:\..*)?|\.git|\.ssh|\.aws|\.claude|\.kaggle|\.docker|\.gnupg|\.secrets?|secrets?(?:\.[a-z0-9]+)?|kaggle\.json|\.netrc|_netrc|\.pgpass|\.git-credentials|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(part)
    || /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i.test(part));
}
/** C3: configured credentials or a recognizable token shape inside file bytes. */
export function credentialContent(bytes: Buffer, secrets: string[] = []): boolean {
  return secrets.some(s => s.length > 5 && bytes.includes(Buffer.from(s))) || detectTokens(bytes.toString('latin1')).length > 0;
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

/** C3 / H-25: one gate for owner-bound transfers (/get, deliver_file): safe path, 49 MB, readable, no credentials; reasons are owner-readable. */
export async function sendableFile(root: string, relative: string, secrets: string[] = []): Promise<{ file: string; bytes: Buffer }> {
  const file = await safeFile(root, relative);
  if ((await lstat(file)).size > 49_000_000) throw new PathAccessError('File exceeds the 49 MB download limit.');
  const bytes = await readFile(file).catch((error: NodeJS.ErrnoException) => { throw new PathAccessError(error.code === 'EACCES' || error.code === 'EPERM' ? 'File cannot be read: storage permission was denied. Fix its permissions (for example chmod u+r) and try again.'
    : error.code === 'ENOENT' ? 'File was removed before it could be sent.' : 'File could not be read from project storage. Check storage and try again.', error.code); });
  if (credentialContent(bytes, secrets)) throw new PathAccessError('This file appears to contain an API key or token, so it was not sent. Remove the credential from the file first.');
  return { file, bytes };
}
/** Names of the token kinds found in a text (no values). */
export function detectTokens(text: string): string[] { return TOKEN_PATTERNS.filter(([, re]) => { re.lastIndex = 0; return re.test(text); }).map(([name]) => name); }
/** The text with every recognizable token replaced by a label, for archives and previews. */
export function maskTokens(text: string): string { return TOKEN_PATTERNS.reduce((t, [name, re]) => t.replace(re, `[hidden ${name}]`), text); }
