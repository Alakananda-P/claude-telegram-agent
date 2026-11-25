/** Old ids per family. State stores only these (plus an optional family), so a rolled-back
 * version still accepts state.json; the newest model of the family is resolved at run time. */
export const MODELS = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' } as const;
const EXTERNAL_LABELS: Record<string, string> = {
  'gemini-4-neon': 'Gemini 4 Neon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemma-4-31b-it': 'Gemma 4 31B IT',
  'grok-4.7': 'Grok 4.7',
  'MiniMax-M3': 'MiniMax M3',
  'MiniMax-M3.1-Flash': 'MiniMax M3.1 Flash',
  'openai/gpt-6.2-sol': 'GPT 6.2 Sol',
  'deepseek/deepseek-v4.1-flash-1017': 'DeepSeek V4.1 Flash',
};
const FALLBACK_ONLY_LABELS: Record<string, string> = {
  'anthropic/claude-opus-5.5': 'Claude Opus 5.5',
  'anthropic/claude-sonnet-5.5': 'Claude Sonnet 5.5',
  'anthropic/claude-fable-5.2': 'Claude Fable 5.2',
  'google/gemma-4-31b-it:free': 'Gemma 4 31B IT Free',
};
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
export interface AgentSettings { model: string; effort: Effort; fast: boolean; family?: string }
export function isExternalModel(id: string): boolean {
  return Object.hasOwn(EXTERNAL_LABELS, id) || Object.hasOwn(FALLBACK_ONLY_LABELS, id);
}
export function validSettings(value: unknown): value is AgentSettings {
  const s = value as AgentSettings | undefined;
  return !!s && (Object.values(MODELS).includes(s.model as typeof MODELS.opus) || isExternalModel(s.model))
    && EFFORTS.includes(s.effort) && typeof s.fast === 'boolean'
    && (s.family === undefined || (typeof s.family === 'string' && /^[a-z]{1,32}$/.test(s.family)));
}
/** Family of a model id, e.g. claude-fable-5-2 -> fable. */
export function familyOf(id: string): string | undefined { return /^claude-([a-z]+)-/.exec(id)?.[1]; }
export function settingsFamily(s: AgentSettings): string | undefined {
  return isExternalModel(s.model) ? undefined : (s.family ?? familyOf(s.model) ?? 'opus');
}
/** Rollback-safe stored form of a family choice: its old id, or the opus id plus the new optional family field. */
export function familySettings(family: string): { model: string; family?: string } {
  return Object.hasOwn(MODELS, family) ? { model: MODELS[family as keyof typeof MODELS] } : { model: MODELS.opus, family };
}
/** Models with fast-mode prices in the built-in table; the price book adds any the pricing page lists. */
export const FAST_MODELS = ['claude-fable-5-2', 'claude-opus-5-5'];
export function effectiveSettings(settings: AgentSettings, fastAllowed: (model: string) => boolean = model => FAST_MODELS.includes(model)): AgentSettings {
  return { ...settings, fast: settings.fast && fastAllowed(settings.model) };
}
export function modelLabel(model: string): string {
  if (EXTERNAL_LABELS[model]) return EXTERNAL_LABELS[model];
  if (FALLBACK_ONLY_LABELS[model]) return FALLBACK_ONLY_LABELS[model];
  const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '') : model;
}
export function settingsLabel(settings: AgentSettings): string {
  // Callers pass settings that are already effective (fast and effort resolved for the model).
  const s = settings;
  return `${modelLabel(s.model)} · ${s.fast ? 'Fast' : 'Standard'} · ${s.effort} effort`;
}
