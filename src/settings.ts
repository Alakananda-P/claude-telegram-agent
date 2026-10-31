export const MODELS = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' } as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
export interface AgentSettings { model: string; effort: Effort; fast: boolean }
export function validSettings(value: unknown): value is AgentSettings {
  const s = value as AgentSettings | undefined;
  return !!s && Object.values(MODELS).includes(s.model as typeof MODELS.opus)
    && EFFORTS.includes(s.effort) && typeof s.fast === 'boolean';
}
export function effectiveSettings(settings: AgentSettings): AgentSettings {
  return { ...settings, fast: settings.fast && settings.model === MODELS.opus };
}
export function modelLabel(model: string): string {
  return model === MODELS.fable ? 'Fable 5.1' : model === MODELS.opus ? 'Opus 5.5' : model === MODELS.sonnet ? 'Sonnet 5.5' : model;
}
export function settingsLabel(settings: AgentSettings): string {
  const s = effectiveSettings(settings);
  return `${modelLabel(s.model)} · ${s.fast ? 'Fast' : 'Standard'} · ${s.effort} effort`;
}
