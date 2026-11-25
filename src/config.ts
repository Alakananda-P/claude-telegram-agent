import path from 'node:path';
import { MODELS, EFFORTS, familyOf, familySettings, type Effort } from './settings.js';
import type { ProviderConfig } from './providers.js';

export interface Config {
  token: string; owner: number; apiKey: string; dataDir: string;
  /** Claude Code OAuth is intentionally separate from API-key credentials. */
  oauthToken?: string;
  upgradeGithubToken?: string; upgradeRenderToken?: string; upgradeRenderServiceId?: string;
  model: string; effort: Effort; fast: boolean; permissionMode: 'auto';
  maxTurns: number; timeoutMs: number;
  /** Model families offered in /model (ALLOWED_MODEL_FAMILIES); the newest model of each comes from the Models API. */
  modelFamilies: string[];
  /** Set only when CLAUDE_MODEL names a family without an old id (see familySettings). */
  modelFamily?: string;
  /** RENDER_API_KEY and GITHUB_TOKEN when set: only redacted here, used by /update. */
  updateKeys?: string[];
  backupKeys?: string[]; backupEncryptionKey?: string;
  keyLabels?: string[]; elevenLabsKey?: string;
  providers: ProviderConfig;
}

export function configSecrets(c: Config): string[] { return [c.token, c.apiKey, ...(c.oauthToken ? [c.oauthToken] : []), ...(c.upgradeGithubToken ? [c.upgradeGithubToken] : []), ...(c.upgradeRenderToken ? [c.upgradeRenderToken] : []), ...(Object.values(c.providers.keys).flat()), ...(c.backupKeys ?? []), ...(c.backupEncryptionKey ? [c.backupEncryptionKey] : []), ...(c.elevenLabsKey ? [c.elevenLabsKey] : []), ...(c.updateKeys ?? [])].filter(Boolean); }

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
  if (!['true', 'false'].includes(env.CLAUDE_FAST_MODE ?? 'true')) throw new Error('CLAUDE_FAST_MODE must be true or false.');
  const families = (env.ALLOWED_MODEL_FAMILIES ?? 'fable,opus,sonnet').split(',').map(f => f.trim());
  if (!families.length || families.length > 8 || families.some(f => !/^[a-z]{1,32}$/.test(f))) throw new Error('ALLOWED_MODEL_FAMILIES must be a comma-separated list of model families, e.g. fable,opus,sonnet.');
  const modelFamilies = [...new Set(families)];
  // CLAUDE_MODEL names a family (opus) or any model id of an allowed family; the newest model of that family runs.
  const requested = env.CLAUDE_MODEL ?? MODELS.opus;
  const requestedFamily = /^[a-z]{1,32}$/.test(requested) ? requested : /^claude-[a-z0-9-]{1,80}$/.test(requested) ? familyOf(requested) : undefined;
  if (!requestedFamily || !modelFamilies.includes(requestedFamily)) throw new Error('CLAUDE_MODEL must be a model family from ALLOWED_MODEL_FAMILIES (for example opus) or a Claude model id in one of them.');
  const { model, family: modelFamily } = familySettings(requestedFamily);
  const maxTurns = positive('MAX_TURNS', 50);
  if (!Number.isInteger(maxTurns)) throw new Error('MAX_TURNS must be an integer.');
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || '';
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || '';
  if (!!apiKey === !!oauthToken) throw new Error('Set exactly one of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the private environment.');
  let backupKeys: string[] = [];
  try { backupKeys = JSON.parse(env.ANTHROPIC_BACKUP_KEYS ?? '[]'); if (!Array.isArray(backupKeys) || backupKeys.length > 5 || backupKeys.some(k => typeof k !== 'string' || !k.startsWith('sk-ant-'))) throw new Error(); }
  catch { throw new Error('Set ANTHROPIC_BACKUP_KEYS to a private JSON array of up to five API keys.'); }
  if (oauthToken && backupKeys.length) throw new Error('OAuth credentials cannot be mixed with ANTHROPIC_BACKUP_KEYS.');
  const backupEncryptionKey = env.BACKUP_ENCRYPTION_KEY;
  let keyLabels: string[] | undefined;
  if (env.ANTHROPIC_KEY_LABELS) {
    try { keyLabels = JSON.parse(env.ANTHROPIC_KEY_LABELS); if (!Array.isArray(keyLabels) || keyLabels.length !== new Set([apiKey || oauthToken, ...backupKeys]).size || keyLabels.some(x => typeof x !== 'string' || !/^[A-Za-z0-9 _-]{1,32}$/.test(x)) || new Set(keyLabels).size !== keyLabels.length) throw new Error(); }
    catch { throw new Error('Set ANTHROPIC_KEY_LABELS to unique non-secret labels for each unique configured key.'); }
  }
  if (backupEncryptionKey && !/^[a-f0-9]{64}$/i.test(backupEncryptionKey)) throw new Error('Set BACKUP_ENCRYPTION_KEY to 32 random bytes encoded as hex.');
  const split = (name: string) => (env[name] ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const providers: ProviderConfig = { keys: { gemini: split('GEMINI_API_KEYS'), xai: split('XAI_API_KEYS'), minimax: split('MINIMAX_API_KEYS'), openrouter: split('OPENROUTER_API_KEYS') } };
  return { token, owner, apiKey, oauthToken: oauthToken || undefined, upgradeGithubToken: env.BOT_UPGRADE_GITHUB_TOKEN?.trim() || undefined, upgradeRenderToken: env.BOT_UPGRADE_RENDER_API_KEY?.trim() || undefined, upgradeRenderServiceId: env.BOT_UPGRADE_RENDER_SERVICE_ID?.trim() || undefined, model, backupKeys, backupEncryptionKey, keyLabels, elevenLabsKey: env.ELEVENLABS_API_KEY?.trim() || undefined, providers,
    effort, fast: (env.CLAUDE_FAST_MODE ?? 'true') === 'true', permissionMode: 'auto', maxTurns, modelFamilies, ...(modelFamily ? { modelFamily } : {}), updateKeys: [env.RENDER_API_KEY, env.GITHUB_TOKEN].map(v => v?.trim()).filter((v): v is string => !!v),
    timeoutMs: positive('JOB_TIMEOUT_MINUTES', 20) * 60_000,
    dataDir: path.resolve(env.DATA_DIR ?? './data') };
}
