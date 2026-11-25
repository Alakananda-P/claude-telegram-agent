import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentApiError, type Runner } from '../src/agent.js';
import type { Config } from '../src/config.js';
import { SharedMemory } from '../src/memory.js';
import {
  ProviderHealthTracker,
  ProviderRunner,
  RoutedRunner,
  configuredProviderModels,
  providerModel,
  stripThinking,
} from '../src/providers.js';

function testConfig(dataDir: string): Config {
  return {
    token: '123456:abcdefghijklmnopqrstuvwxyz',
    owner: 123,
    apiKey: 'sk-ant-test-key',
    dataDir,
    model: 'claude-opus-5-5',
    effort: 'high',
    fast: false,
    permissionMode: 'auto',
    maxTurns: 10,
    timeoutMs: 60_000,
    modelFamilies: ['fable', 'opus', 'sonnet'],
    providers: {
      keys: {
        gemini: ['gem-key'],
        xai: ['xai-key'],
        minimax: ['mm-key'],
        openrouter: ['or-key'],
      },
    },
  };
}

test('stripThinking removes closed and unclosed <think> blocks', () => {
  assert.equal(stripThinking('<think>internal thoughts</think>\n\nHello!'), 'Hello!');
  assert.equal(stripThinking('Hi <THINK>secret</THINK> there'), 'Hi  there');
  assert.equal(stripThinking('Answer first\n<think>unclosed reasoning'), 'Answer first');
});

test('configuredProviderModels consolidates Opus/Gemma and hides unconfigured providers', () => {
  const onlyXai = configuredProviderModels({ keys: { xai: ['k1'] } });
  assert.deepEqual(onlyXai.map(m => m.id), ['grok-4.7']);

  const all = configuredProviderModels({
    keys: { gemini: ['g'], xai: ['x'], minimax: ['m'], openrouter: ['o'] },
  });
  assert.ok(all.some(m => m.id === 'gemma-4-31b-it'));
  assert.ok(!all.some(m => m.id === 'anthropic/claude-opus-latest'));
  assert.ok(!all.some(m => m.id === 'google/gemma-4-31b-it:free'));
  assert.ok(providerModel('anthropic/claude-opus-latest')?.fallbackOnly);
  assert.ok(providerModel('google/gemma-4-31b-it:free')?.fallbackOnly);
});

test('ProviderRunner executes multi-turn OpenAI tool_calls with memory and resumeContext', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myra-prov-'));
  try {
    const cfg = testConfig(dir);
    await new SharedMemory(dir, []).remember('Owner prefers Hinglish replies.', 'core');
    const seenBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;

    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      seenBodies.push(body);
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'tc_1',
                type: 'function',
                function: {
                  name: 'Write',
                  arguments: JSON.stringify({ file_path: 'output/hello.txt', content: 'Namaste Myra' }),
                },
              }],
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { content: '<think>done</think>\nFile likh diya hai.' },
        }],
      }), { status: 200 });
    };

    const runner = new ProviderRunner(cfg.providers, cfg, fakeFetch);
    const events: string[] = [];
    const res = await runner.run({
      prompt: 'Create output/hello.txt',
      cwd: dir,
      resumeContext: 'user: Mrya?\nassistant: Yes, ready.',
      settings: { model: 'MiniMax-M3', effort: 'high', fast: false },
    }, ev => { events.push(ev.type); }, new AbortController());

    assert.equal(res.text, 'File likh diya hai.');
    assert.ok(events.includes('effect'));
    assert.equal(await readFile(path.join(dir, 'output', 'hello.txt'), 'utf8'), 'Namaste Myra');
    const systemMsg = (seenBodies[0].messages as Array<{ role: string; content: string }>)[0].content;
    assert.match(systemMsg, /Owner prefers Hinglish replies/);
    assert.match(systemMsg, /Mrya\?/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ProviderRunner blocks mutating tools in planMode and supports Gemini functionCall', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myra-gem-'));
  try {
    const cfg = testConfig(dir);
    let step = 0;
    const seenToolResponses: unknown[] = [];

    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { contents?: Array<{ parts?: unknown[] }> };
      step++;
      if (step === 1) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{ functionCall: { name: 'Write', args: { file_path: 'blocked.txt', content: 'nope' } } }],
            },
          }],
        }), { status: 200 });
      }
      seenToolResponses.push(body.contents?.at(-1)?.parts);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Plan ready without edits.' }] } }],
      }), { status: 200 });
    };

    const runner = new ProviderRunner(cfg.providers, cfg, fakeFetch);
    const res = await runner.run({
      prompt: 'Plan changes',
      cwd: dir,
      planMode: true,
      settings: { model: 'gemini-4-argon', effort: 'high', fast: false },
    }, () => {}, new AbortController());

    assert.equal(res.text, 'Plan ready without edits.');
    assert.match(JSON.stringify(seenToolResponses), /Plan mode is read-only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('RoutedRunner sticks to OpenRouter during cooldown and recovers via background probe', async () => {
  let claudeCalls = 0;
  let nowMs = 1_000_000;
  const health = new ProviderHealthTracker(undefined, () => nowMs);
  let probeResult = false;
  let probeCalls = 0;

  const claude: Runner = {
    async run() {
      claudeCalls++;
      throw new AgentApiError('billing_error', 'Out of credits');
    },
  };

  const openrouterModels: string[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    openrouterModels.push(body.model ?? '');
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Answered via OpenRouter' } }],
    }), { status: 200 });
  };

  const providers = new ProviderRunner({ keys: { openrouter: ['or-1'], gemini: ['gem-1'] } }, undefined, fakeFetch);
  const routed = new RoutedRunner(claude, providers, health, async () => {
    probeCalls++;
    return probeResult;
  });

  // 1st request: Claude fails -> marks anthropic in cooldown -> routes to OpenRouter Opus
  const r1 = await routed.run({ prompt: 'hi', cwd: '.', settings: { model: 'claude-opus-5-5', effort: 'high', fast: false } }, () => {}, new AbortController());
  assert.equal(r1.text, 'Answered via OpenRouter');
  assert.equal(claudeCalls, 1);
  assert.equal(openrouterModels[0], 'anthropic/claude-opus-latest');
  assert.equal(health.isCoolingDown('anthropic'), true);

  // 2nd request within cooldown: skips Claude completely!
  const r2 = await routed.run({ prompt: 'hi again', cwd: '.', settings: { model: 'claude-opus-5-5', effort: 'high', fast: false } }, () => {}, new AbortController());
  assert.equal(r2.text, 'Answered via OpenRouter');
  assert.equal(claudeCalls, 1, 'must not re-hit failed primary during cooldown');
  assert.equal(probeCalls, 0);

  // Advance past 30 min cooldown -> triggers background probe (returns false -> stays in cooldown)
  nowMs += 31 * 60_000;
  await routed.run({ prompt: 'still cooling', cwd: '.', settings: { model: 'claude-opus-5-5', effort: 'high', fast: false } }, () => {}, new AbortController());
  await new Promise(r => setTimeout(r, 10));
  assert.equal(probeCalls, 1);
  assert.equal(health.isCoolingDown('anthropic'), true);
  assert.equal(claudeCalls, 1);

  // Advance again and probe succeeds -> recovers to healthy
  probeResult = true;
  nowMs += 31 * 60_000;
  await routed.run({ prompt: 'probe passes', cwd: '.', settings: { model: 'claude-opus-5-5', effort: 'high', fast: false } }, () => {}, new AbortController());
  await new Promise(r => setTimeout(r, 10));
  assert.equal(probeCalls, 2);
  assert.equal(health.isCoolingDown('anthropic'), false);
});

test('RoutedRunner falls back Gemma 4 31B IT to OpenRouter free and never replays after effect', async () => {
  const health = new ProviderHealthTracker();
  const seenModels: string[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), { status: 429 });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    seenModels.push(body.model ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Gemma via OR' } }] }), { status: 200 });
  };
  const providers = new ProviderRunner({ keys: { gemini: ['g-1'], openrouter: ['or-1'] } }, undefined, fakeFetch);
  const claude: Runner = {
    async run(_req, emit) {
      await emit({ type: 'effect', tool: 'Write' });
      throw new AgentApiError('server_error', 'Failed mid-task');
    },
  };
  const routed = new RoutedRunner(claude, providers, health);

  const res = await routed.run({ prompt: 'hello', cwd: '.', settings: { model: 'gemma-4-31b-it', effort: 'high', fast: false } }, () => {}, new AbortController());
  assert.equal(res.text, 'Gemma via OR');
  assert.deepEqual(seenModels, ['google/gemma-4-31b-it:free']);

  await assert.rejects(
    () => routed.run({ prompt: 'edit', cwd: '.', settings: { model: 'claude-opus-5-5', effort: 'high', fast: false } }, () => {}, new AbortController()),
    /Failed mid-task/,
  );
});
