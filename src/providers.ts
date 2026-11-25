import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRequest, AgentResult, Runner } from './agent.js';
import { AgentApiError } from './agent.js';

export type Provider = 'gemini' | 'xai' | 'minimax' | 'openrouter';
export interface ProviderModel { id: string; label: string; provider: Provider; fast?: boolean }
export const PROVIDER_MODELS: ProviderModel[] = [
  { id: 'gemini-4-neon', label: 'Gemini 4 Neon', provider: 'gemini' },
  { id: 'gemini-4-argon', label: 'Gemini 4 Argon', provider: 'gemini' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'gemini', fast: true },
  { id: 'gemma-4-31b-it', label: 'Gemma 4 31B IT', provider: 'gemini', fast: true },
  { id: 'grok-4.7', label: 'Grok 4.7', provider: 'xai' },
  { id: 'MiniMax-M3', label: 'MiniMax M3', provider: 'minimax' },
  { id: 'MiniMax-M3.1-Flash', label: 'MiniMax M3.1 Flash', provider: 'minimax', fast: true },
  { id: 'openai/gpt-6.2-sol', label: 'GPT 6.2 Sol', provider: 'openrouter' },
  { id: 'anthropic/claude-opus-latest', label: 'Claude Opus Latest', provider: 'openrouter' },
  { id: 'deepseek/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash', provider: 'openrouter', fast: true },
  { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B IT Free', provider: 'openrouter', fast: true },
];
export const providerModel = (id: string) => PROVIDER_MODELS.find(m => m.id === id);
export interface ProviderConfig { keys: Partial<Record<Provider, string[]>> }

/** Minimal native-provider runner. It is deliberately text-only: it never pretends that
 * Claude Code's file/shell/MCP permissions can be forwarded to another provider. */
export class ProviderRunner implements Runner {
  private next: Partial<Record<Provider, number>> = {};
  constructor(private config: ProviderConfig) {}
  hasConfigured(): boolean { return Object.values(this.config.keys).some(keys => !!keys?.length); }
  async run(request: AgentRequest, emit: (event: AgentEvent) => void | Promise<void>, abort: AbortController): Promise<AgentResult> {
    const model = providerModel(request.settings?.model ?? '');
    if (!model) throw new AgentApiError('model_not_found', 'The selected fallback model is not configured.');
    const keys = this.config.keys[model.provider] ?? [];
    if (!keys.length) throw new AgentApiError('credentials_exhausted', `${model.label} has no configured credential.`);
    const start = this.next[model.provider] ?? 0;
    let last: AgentApiError | undefined;
    for (let offset = 0; offset < keys.length; offset++) {
      const key = keys[(start + offset) % keys.length];
      try {
        await emit({ type: 'progress', text: `Using ${model.label}…` });
        const text = await this.call(model, key, request.prompt, abort.signal);
        this.next[model.provider] = (start + offset + 1) % keys.length;
        const session = request.session ?? `provider-${randomUUID()}`;
        await emit({ type: 'session', id: session });
        await emit({ type: 'commentary', id: randomUUID(), text: `Using ${model.label} fallback. This reply is text-only; Claude Code tools are unavailable on this provider.` });
        return { text, session, cumulativeCost: 0 };
      } catch (error) { last = error instanceof AgentApiError ? error : new AgentApiError('unknown', 'Fallback provider request failed.'); }
    }
    throw last ?? new AgentApiError('credentials_exhausted', 'No configured fallback provider credential completed this request.');
  }
  private async call(model: ProviderModel, key: string, prompt: string, signal: AbortSignal): Promise<string> {
    let url: string, headers: Record<string, string>, body: unknown, read: (v: any) => string | undefined;
    if (model.provider === 'gemini') {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.id)}:generateContent?key=${encodeURIComponent(key)}`;
      headers = { 'Content-Type': 'application/json' }; body = { systemInstruction: { parts: [{ text: 'You are a fallback text assistant inside a Telegram bot. You do not receive the bot\'s persistent memory, saved chats, files or tools in this request. Never claim that you can access or use them. State this briefly if asked.' }] }, contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8192 } };
      read = v => v?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('');
    } else {
      url = model.provider === 'xai' ? 'https://api.x.ai/v1/chat/completions' : model.provider === 'minimax' ? 'https://api.minimax.io/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
      headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }; body = { model: model.id, messages: [{ role: 'system', content: 'You are a fallback text assistant inside a Telegram bot. You do not receive the bot\'s persistent memory, saved chats, files or tools in this request. Never claim that you can access or use them. State this briefly if asked.' }, { role: 'user', content: prompt }], max_tokens: 8192 };
      read = v => v?.choices?.[0]?.message?.content;
    }
    let response: Response; try { response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) }); } catch { throw new AgentApiError('network_error', 'Fallback provider could not be reached.'); }
    const json = await response.json().catch(() => ({})); const text = read(json);
    if (response.ok && typeof text === 'string' && text.trim()) return text.trim();
    const kind = response.status === 401 || response.status === 403 ? 'authentication_failed' : response.status === 402 ? 'billing_error' : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'server_error' : response.status === 404 ? 'model_not_found' : 'invalid_request';
    throw new AgentApiError(kind, `Fallback provider request failed (${kind.replaceAll('_', ' ')}).`);
  }
}

export class RoutedRunner implements Runner {
  constructor(private claude: Runner, private providers: ProviderRunner) {}
  async run(request: AgentRequest, emit: (event: AgentEvent) => void | Promise<void>, abort: AbortController): Promise<AgentResult> {
    if (providerModel(request.settings?.model ?? '')) return this.providers.run(request, emit, abort);
    try { return await this.claude.run(request, emit, abort); }
    catch (error) {
      if (!(error instanceof AgentApiError) || !['authentication_failed', 'billing_error', 'credentials_exhausted', 'network_error', 'server_error', 'overloaded'].includes(error.kind)) throw error;
      const fallback = this.providers.hasConfigured() ? PROVIDER_MODELS.find(m => m.id === 'gemini-4-argon') : undefined;
      if (!fallback) throw error;
      return this.providers.run({ ...request, session: undefined, settings: { ...(request.settings ?? { effort: 'high', fast: false, model: fallback.id }), model: fallback.id, fast: false } }, emit, abort);
    }
  }
}
