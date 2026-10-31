import path from 'node:path';

export interface Config {
  token: string; owner: number; apiKey: string; dataDir: string;
  model: string; effort: 'high'; permissionMode: 'auto';
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
  if ((env.CLAUDE_EFFORT ?? 'high') !== 'high') throw new Error('CLAUDE_EFFORT must be high.');
  const model = env.CLAUDE_MODEL ?? 'claude-sonnet-5-5';
  if (model !== 'claude-sonnet-5-5') throw new Error('CLAUDE_MODEL must be claude-sonnet-5-5; review code before changing models.');
  const maxTurns = positive('MAX_TURNS', 50);
  if (!Number.isInteger(maxTurns)) throw new Error('MAX_TURNS must be an integer.');
  return { token, owner, apiKey: required('ANTHROPIC_API_KEY'), model,
    effort: 'high', permissionMode: 'auto', maxTurns,
    timeoutMs: positive('JOB_TIMEOUT_MINUTES', 20) * 60_000,
    dataDir: path.resolve(env.DATA_DIR ?? './data') };
}
