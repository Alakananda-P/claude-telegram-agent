import path from 'node:path';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { agentEnvironment, type AgentRequest } from './agent.js';
import { configSecrets, type Config } from './config.js';
import { SharedMemory } from './memory.js';
import { MEMORY_TOOL_NAMES, memoryServer } from './memory-tools.js';
import { projectServer, projectToolAllowedDuringChange } from './project-tools.js';
import { PathAccessError, redact, safeJson, secretPath } from './safety.js';
import { sessionServer } from './sessions.js';
import { workspaceServer } from './workspace-tools.js';

const execFileAsync = promisify(execFile);

/** An image the model can actually look at. `data` is raw base64 without a data-URL prefix. */
export interface ToolImage { mimeType: string; data: string }
export interface AgentToolResult { text: string; isError?: boolean; images?: ToolImage[] }
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutating: boolean;
  progressLabel: string;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<AgentToolResult>;
}

/** Largest image passed to a provider in one part (8 MB). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Formats Gemini, OpenRouter and xAI accept as image parts. Other image types are not sent raw. */
const VISION_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};
const IMAGE_MIME: Record<string, string> = {
  ...VISION_MIME,
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};
/** Files that are never readable as text; they need a script instead of a text dump. */
const BINARY_EXT = new Set(['.pdf', '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.zip', '.7z', '.rar', '.gz', '.tar', '.mp3', '.mp4', '.mov', '.wav', '.woff', '.woff2', '.ttf', '.otf', '.exe', '.dll', '.so', '.dmg', '.apk', '.db', '.sqlite']);

export const imageMimeType = (file: string): string | undefined => IMAGE_MIME[path.extname(file).toLowerCase()];
/** Mime type only when the provider APIs can take the picture directly. */
export const visionMimeType = (file: string): string | undefined => VISION_MIME[path.extname(file).toLowerCase()];
export const isBinaryPath = (file: string): boolean => BINARY_EXT.has(path.extname(file).toLowerCase());

interface RegisteredToolEntry {
  description?: string;
  inputSchema?: z.ZodTypeAny;
  annotations?: { readOnlyHint?: boolean };
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{ isError?: boolean; content?: Array<{ type: string; text?: string }> }>;
}

const TOOL_LABELS: Record<string, string> = {
  Bash: 'Running code…',
  Read: 'Reading files…',
  Glob: 'Finding files…',
  Grep: 'Searching files…',
  Edit: 'Updating files…',
  Write: 'Creating files…',
};

export function cleanJsonSchema(schema: unknown, forGemini = false): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object', properties: {} };
  const input = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === '$schema' || key === 'default') continue;
    if (forGemini && (key === 'additionalProperties' || key === 'exclusiveMinimum' || key === 'exclusiveMaximum' || key === 'pattern' || key === 'minLength' || key === 'maxLength' || key === 'minimum' || key === 'maximum' || key === 'minItems' || key === 'maxItems')) continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) props[pk] = cleanJsonSchema(pv, forGemini);
      out.properties = props;
    } else if (key === 'items' && value && typeof value === 'object') {
      out.items = cleanJsonSchema(value, forGemini);
    } else if (forGemini && (key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      const first = value.find(v => v && typeof v === 'object' && (v as Record<string, unknown>).type !== 'null');
      if (first) Object.assign(out, cleanJsonSchema(first, forGemini));
    } else {
      out[key] = value;
    }
  }
  if (!out.type && out.properties) out.type = 'object';
  return out;
}

async function resolveProjectPath(cwd: string, rawPath: string, allowMissing = false): Promise<string> {
  if (!rawPath || typeof rawPath !== 'string') throw new PathAccessError('A file path is required.');
  const base = await realpath(cwd);
  const candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(base, rawPath);
  const relative = path.relative(base, candidate).replace(/\\/g, '/');
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathAccessError('Path is outside the current project directory.');
  }
  if (secretPath(relative)) throw new PathAccessError('Access to secret/credential files is not allowed.');
  const parts = relative.split('/').filter(Boolean);
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new PathAccessError('Symlinks are not allowed.');
    } catch (error) {
      if (error instanceof PathAccessError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) break;
      throw error;
    }
  }
  return candidate;
}

/** Reads a project image as base64. Missing, secret, symlink, non-image, or oversized files are skipped. */
export async function readProjectImage(cwd: string, relative: string): Promise<ToolImage | undefined> {
  const mimeType = visionMimeType(relative);
  if (!mimeType) return undefined;
  try {
    const file = await resolveProjectPath(cwd, relative);
    const bytes = await readFile(file);
    if (bytes.length > MAX_IMAGE_BYTES) return undefined;
    return { mimeType, data: bytes.toString('base64') };
  } catch {
    return undefined;
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp('^' + escaped + '$');
}

async function walkProjectFiles(base: string, dir = base, out: string[] = [], limit = 2000): Promise<string[]> {
  if (out.length >= limit) return out;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (entry.name === 'node_modules' || entry.name === '.git' || secretPath(rel)) continue;
    if (entry.isDirectory()) await walkProjectFiles(base, full, out, limit);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function zodTool(
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  mutating: boolean,
  run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
  secrets: string[],
): AgentTool {
  const parsed = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    name,
    description,
    parameters: cleanJsonSchema(parsed, false),
    mutating,
    progressLabel: TOOL_LABELS[name] ?? 'Working…',
    async execute(rawArgs, signal) {
      try {
        const args = schema.parse(rawArgs) as Record<string, unknown>;
        const res = await run(args, signal);
        // A tool may hand back pictures the model can look at; the text part stays a summary.
        const images = res && typeof res === 'object' && Array.isArray((res as { images?: ToolImage[] }).images)
          ? (res as { images: ToolImage[] }).images : undefined;
        const body = res && typeof res === 'object' && 'images' in (res as object)
          ? Object.fromEntries(Object.entries(res as Record<string, unknown>).filter(([key]) => key !== 'images'))
          : res;
        const text = typeof body === 'string' ? redact(body, secrets) : safeJson(body, secrets);
        return images?.length ? { text, images } : { text };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Tool execution failed.';
        return { isError: true, text: redact(msg, secrets) };
      }
    },
  };
}

function extractMcpTools(serverName: string, server: { instance: unknown }, secrets: string[]): AgentTool[] {
  const registered = (server.instance as { _registeredTools?: Record<string, RegisteredToolEntry> })?._registeredTools ?? {};
  return Object.entries(registered).map(([toolName, entry]) => {
    const fullName = `mcp__${serverName}__${toolName}`;
    const schema = entry.inputSchema ? cleanJsonSchema(z.toJSONSchema(entry.inputSchema), false) : { type: 'object', properties: {} };
    const mutating = entry.annotations?.readOnlyHint !== true;
    return {
      name: fullName,
      description: entry.description ?? toolName,
      parameters: schema,
      mutating,
      progressLabel: 'Working…',
      async execute(args) {
        try {
          const parsed = entry.inputSchema ? entry.inputSchema.parse(args) : args;
          const out = await entry.handler(parsed as Record<string, unknown>, {});
          const text = (out.content ?? []).map(c => c.text ?? '').join('\n') || '{}';
          return { isError: out.isError, text: redact(text, secrets) };
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Tool execution failed.';
          return { isError: true, text: redact(msg, secrets) };
        }
      },
    };
  });
}

export function createProviderTools(request: AgentRequest, config: Config): AgentTool[] {
  const secrets = configSecrets(config);
  const tools: AgentTool[] = [
    zodTool('Read', 'Read a file in the current project with line numbers. Use offset and limit for large files. Images are returned as pictures you can look at directly.',
      z.object({ file_path: z.string().min(1), offset: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(500).default(200) }),
      false, async args => {
        const file = await resolveProjectPath(request.cwd, String(args.file_path));
        const relative = path.relative(request.cwd, file).replace(/\\/g, '/');
        const mimeType = imageMimeType(file);
        if (mimeType) {
          const bytes = await readFile(file);
          if (!visionMimeType(file)) {
            return { file: relative, mimeType, bytes: bytes.length, error: 'This image format cannot be sent to the model. Convert it to JPEG or PNG with Bash, then read that file.' };
          }
          if (bytes.length > MAX_IMAGE_BYTES) {
            return { file: relative, mimeType, bytes: bytes.length, error: `Image is ${(bytes.length / 1048576).toFixed(1)} MB, over the ${MAX_IMAGE_BYTES / 1048576} MB limit. Resize or crop it with Bash/sharp, then read it again.` };
          }
          return { file: relative, mimeType, bytes: bytes.length, content: 'Image attached. Look at it directly.', images: [{ mimeType, data: bytes.toString('base64') }] };
        }
        if (isBinaryPath(file)) {
          return { file: relative, error: 'This is a binary file, not text. Inspect it with a script (for example Python, pdftotext or ffmpeg) through Bash instead of reading it as text.' };
        }
        const raw = await readFile(file, 'utf8');
        const lines = raw.split(/\r?\n/);
        const offset = Number(args.offset ?? 1);
        const limit = Number(args.limit ?? 200);
        const slice = lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${offset + i}: ${l}`).join('\n');
        return { file: relative, totalLines: lines.length, content: slice.slice(0, 24000) };
      }, secrets),

    zodTool('Write', 'Create or overwrite a file in the current project.',
      z.object({ file_path: z.string().min(1), content: z.string() }),
      true, async args => {
        const file = await resolveProjectPath(request.cwd, String(args.file_path), true);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, String(args.content), { mode: 0o600 });
        return { written: path.relative(request.cwd, file).replace(/\\/g, '/'), bytes: Buffer.byteLength(String(args.content), 'utf8') };
      }, secrets),

    zodTool('Edit', 'Replace an exact string in a project file.',
      z.object({ file_path: z.string().min(1), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().default(false) }),
      true, async args => {
        const file = await resolveProjectPath(request.cwd, String(args.file_path));
        const current = await readFile(file, 'utf8');
        const oldStr = String(args.old_string);
        const newStr = String(args.new_string);
        if (!current.includes(oldStr)) throw new Error('old_string was not found in the file.');
        const count = current.split(oldStr).length - 1;
        if (count > 1 && !args.replace_all) throw new Error(`old_string matched ${count} times; provide more context or set replace_all=true.`);
        const updated = args.replace_all ? current.split(oldStr).join(newStr) : current.replace(oldStr, newStr);
        await writeFile(file, updated, { mode: 0o600 });
        return { edited: path.relative(request.cwd, file).replace(/\\/g, '/'), replacements: args.replace_all ? count : 1 };
      }, secrets),

    zodTool('Glob', 'Find project files matching a glob pattern (for example **/*.ts).',
      z.object({ pattern: z.string().min(1), limit: z.number().int().min(1).max(200).default(100) }),
      false, async args => {
        const base = await realpath(request.cwd);
        const files = await walkProjectFiles(base);
        const re = globToRegex(String(args.pattern));
        const matches = files.filter(f => re.test(f)).slice(0, Number(args.limit ?? 100));
        return { matches, total: matches.length };
      }, secrets),

    zodTool('Grep', 'Search project files for a text or regex pattern.',
      z.object({ pattern: z.string().min(1), file_glob: z.string().optional(), limit: z.number().int().min(1).max(100).default(40) }),
      false, async args => {
        const base = await realpath(request.cwd);
        const files = await walkProjectFiles(base);
        const filter = args.file_glob ? globToRegex(String(args.file_glob)) : undefined;
        const re = new RegExp(String(args.pattern));
        const hits: Array<{ file: string; line: number; text: string }> = [];
        const max = Number(args.limit ?? 40);
        for (const rel of files) {
          if (filter && !filter.test(rel)) continue;
          const content = await readFile(path.join(base, rel), 'utf8').catch(() => '');
          if (!content) continue;
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              hits.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) });
              if (hits.length >= max) return { hits, truncated: true };
            }
          }
        }
        return { hits, truncated: false };
      }, secrets),

    zodTool('Bash', 'Run a non-interactive shell command inside the current project directory.',
      z.object({ command: z.string().min(1).max(8000), timeout_ms: z.number().int().min(1000).max(120000).default(60000) }),
      true, async (args, signal) => {
        const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
        const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', String(args.command)] : ['-lc', String(args.command)];
        const timeout = Number(args.timeout_ms ?? 60000);
        const env = agentEnvironment({ ...config, apiKey: '', oauthToken: undefined });
        try {
          const res = await execFileAsync(shell, shellArgs, { cwd: request.cwd, env, timeout, maxBuffer: 256 * 1024, signal });
          return { exitCode: 0, stdout: res.stdout.slice(0, 16000), stderr: res.stderr.slice(0, 8000) };
        } catch (error) {
          const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
          return { exitCode: typeof e.code === 'number' ? e.code : 1, stdout: (e.stdout ?? '').slice(0, 16000), stderr: (e.stderr ?? e.message ?? 'Command failed').slice(0, 8000) };
        }
      }, secrets),
  ];

  if (request.memoryEnabled !== false) {
    const memory = new SharedMemory(config.dataDir, secrets);
    const memTools = extractMcpTools('memory', memoryServer(memory), secrets)
      .filter(t => MEMORY_TOOL_NAMES.includes(t.name));
    tools.push(...memTools);
  }
  if (request.sessions) tools.push(...extractMcpTools('sessions', sessionServer(request.sessions), secrets));
  if (request.projects) tools.push(...extractMcpTools('projects', projectServer(request.projects), secrets));
  if (request.workspace) tools.push(...extractMcpTools('workspace', workspaceServer({ ...request.workspace, secrets }), secrets));

  return tools.map(tool => ({
    ...tool,
    async execute(args, signal) {
      if (request.planMode && tool.mutating) {
        return { isError: true, text: 'Plan mode is read-only. Present your plan in text instead of modifying files or running commands.' };
      }
      if (request.projects?.pending() && !projectToolAllowedDuringChange(tool.name)) {
        return { isError: true, text: 'A project change is pending. Finish this turn so the host can switch to the target project directory.' };
      }
      return tool.execute(args, signal);
    },
  }));
}
