import { query } from '@anthropic-ai/claude-agent-sdk';
import { agentEnvironment, type QueryFactory } from './agent.js';
import type { Config } from './config.js';
import type { UsageLedger } from './usage.js';

export const LIVE_STEER_TIMEOUT_MS = 45_000;
export interface LiveSteerRequest { session: string; cwd: string; model: string; text: string }
export interface QuickResponder { reply(request: LiveSteerRequest, signal: AbortSignal): Promise<string | null> }

/** D3: a one-turn, tool-less fork of the running chat answers a mid-task owner message in
 * seconds. The main task keeps running and still receives the message; any failure returns null. */
export class LiveSteerResponder implements QuickResponder {
  constructor(private config: Config, private ledger?: UsageLedger, private makeQuery: QueryFactory = query, private currentConfig?: () => Config | undefined, private timeoutMs = LIVE_STEER_TIMEOUT_MS) {}
  async reply(request: LiveSteerRequest, signal: AbortSignal): Promise<string | null> {
    const config = this.currentConfig ? this.currentConfig() : this.config;
    if (signal.aborted || !config || !request.text.trim()) return null;
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, this.timeoutMs);
    let stream: ReturnType<QueryFactory> | undefined;
    let text: string | null = null;
    try {
      // A resumed fork keeps the chat's recorded system prompt and tool list, so the mode instructions travel
      // in the message, and tools/speed match the main task: the fork then reads the chat from the prompt cache.
      const prompt = '[Live reply mode: the main task is still running in parallel. Answer this owner message briefly in the same language and voice. Do not use tools or change files; if a change is asked, say it will be applied in the next step of the running task. Never claim work is done unless the conversation shows it.]\n\n' + request.text.slice(0, 8000);
      stream = this.makeQuery({ prompt, options: {
        cwd: request.cwd, resume: request.session, forkSession: true, model: request.model, effort: 'low', thinking: { type: 'disabled' }, settings: { fastMode: config.fast },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are answering a mid-task message from the owner while the main task keeps running in parallel. Answer briefly in the same language and voice as the conversation. You cannot run tools or change files here. If the owner asks for a change, say it will be applied in the next step of the running task. Never claim work is done unless the conversation shows it. Never expose credentials or private configuration.' },
        tools: { type: 'preset', preset: 'claude_code' }, allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], skills: [],
        permissionMode: 'default', canUseTool: async () => ({ behavior: 'deny', message: 'Live replies cannot use tools.' }),
        persistSession: false, maxTurns: 2, env: { ...agentEnvironment(config), CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024' }, abortController: abort, stderr: () => {},
      } });
      for await (const event of stream) {
        if (abort.signal.aborted) return null;
        if (event.type === 'result') {
          await this.ledger?.recordResult(event.session_id, event.uuid, event.modelUsage, event.total_cost_usd).catch(() => {});
          if (event.subtype === 'success' && !event.is_error && event.result.trim()) text = event.result.trim();
        }
      }
      return abort.signal.aborted ? null : text;
    } catch {
      return null; // The main task still answers; a failed live reply sends nothing.
    } finally {
      stream?.close(); clearTimeout(timer); signal.removeEventListener('abort', stop);
    }
  }
}
