import path from 'node:path';
import { MODELS, EFFORTS, type Effort } from './settings.js';

export interface Config {
  token: string; owner: number; apiKey: string; dataDir: string;
  model: string; effort: Effort; fast: boolean; permissionMode: 'auto';
  maxTurns: number; timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value || /^(replace|your_|<)/i.test(value)) throw new Error(`Set ${key} in the private environment.`);
    return value;
  };
  const positive = (key: string, fallback: number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be positive.`);
    return n;
  };
  const token = required('TELEGRAM_BOT_TOKEN');
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Invalid TELEGRAM_BOT_TOKEN format.');
  const ownerText = required('TELEGRAM_OWNER_ID');
  const owner = Number(ownerText);
  if (!/^\d+$/.test(ownerText) || !Number.isSafeInteger(owner) || owner <= 0) throw new Error('Invalid TELEGRAM_OWNER_ID.');
  if ((env.CLAUDE_PERMISSION_MODE ?? 'auto') !== 'auto') throw new Error('CLAUDE_PERMISSION_MODE must be auto; bypass is not enabled.');
  const effort = (env.CLAUDE_EFFORT ?? 'high') as Effort;
  if (!EFFORTS.includes(effort)) throw new Error('CLAUDE_EFFORT must be low, medium, high, xhigh or max.');
  const model = env.CLAUDE_MODEL ?? MODELS.opus;
  if (!Object.values(MODELS).includes(model as typeof MODELS.opus)) throw new Error('CLAUDE_MODEL must be claude-fable-5-1, claude-opus-5-5 or claude-sonnet-5-5.');
  if (!['true', 'false'].includes(env.CLAUDE_FAST_MODE ?? 'true')) throw new Error('CLAUDE_FAST_MODE must be true or false.');
  const maxTurns = positive('MAX_TURNS', 50);
  if (!Number.isInteger(maxTurns)) throw new Error('MAX_TURNS must be an integer.');
  return { token, owner, apiKey: required('ANTHROPIC_API_KEY'), model,
    effort, fast: (env.CLAUDE_FAST_MODE ?? 'true') === 'true', permissionMode: 'auto', maxTurns,
    timeoutMs: positive('JOB_TIMEOUT_MINUTES', 20) * 60_000,
    dataDir: path.resolve(env.DATA_DIR ?? './data') };
}
