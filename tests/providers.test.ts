import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  modelSupportsVision,
  providerModel,
  stripThinking,
} from '../src/providers.js';
import { MAX_IMAGE_BYTES } from '../src/provider-tools.js';

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
  assert.ok(!all.some(m => m.id === 'anthropic/claude-opus-5.5'));
  assert.ok(!all.some(m => m.id === 'google/gemma-4-31b-it:free'));
  assert.ok(providerModel('anthropic/claude-opus-5.5')?.fallbackOnly);
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
  assert.equal(openrouterModels[0], 'anthropic/claude-opus-5.5');
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

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('vision flag follows model metadata, not a separate list', () => {
  assert.equal(modelSupportsVision('gemini-4-argon'), true);
  assert.equal(modelSupportsVision('grok-4.7'), true);
  assert.equal(modelSupportsVision('deepseek/deepseek-v4.1-flash-1017'), false);
  assert.equal(modelSupportsVision('MiniMax-M3.1-Flash'), false);
  assert.equal(modelSupportsVision('missing-model'), false);
});

test('ProviderRunner sends attached photos to Gemini and OpenAI-compatible models', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myra-vis-'));
  try {
    await mkdir(path.join(dir, 'uploads'), { recursive: true });
    await writeFile(path.join(dir, 'uploads', 'photo.png'), TINY_PNG);
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (String(url).includes('generativelanguage')) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Bill dekhi.' }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Bill dekhi.' } }] }), { status: 200 });
    };
    const cfg = testConfig(dir);
    const runner = new ProviderRunner(cfg.providers, cfg, fakeFetch);
    const gemini = await runner.run({
      prompt: 'Is bill ko dekho', cwd: dir, attachedFiles: ['uploads/photo.png'],
      settings: { model: 'gemini-4-argon', effort: 'high', fast: false },
    }, () => {}, new AbortController());
    assert.equal(gemini.text, 'Bill dekhi.');
    const parts = ((seen[0].body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts);
    assert.equal(parts[0].text, 'Is bill ko dekho');
    assert.equal((parts[1].inlineData as { mimeType: string }).mimeType, 'image/png');
    assert.equal((parts[1].inlineData as { data: string }).data, TINY_PNG.toString('base64'));

    const grok = await runner.run({
      prompt: 'Is bill ko dekho', cwd: dir, attachedFiles: ['uploads/photo.png'],
      settings: { model: 'grok-4.7', effort: 'high', fast: false },
    }, () => {}, new AbortController());
    assert.equal(grok.text, 'Bill dekhi.');
    const content = (seen[1].body.messages as Array<{ role: string; content: unknown }>).find(m => m.role === 'user')?.content as Array<{ type: string; image_url?: { url: string } }>;
    assert.equal(content[0].type, 'text');
    assert.equal(content[1].image_url?.url, `data:image/png;base64,${TINY_PNG.toString('base64')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Read returns an image the model can see, and a binary file as a hint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myra-read-'));
  try {
    await mkdir(path.join(dir, 'uploads'), { recursive: true });
    await writeFile(path.join(dir, 'uploads', 'photo.jpg'), TINY_PNG);
    await writeFile(path.join(dir, 'notes.pdf'), Buffer.from('%PDF-1.4 not text'));
    const seen: unknown[] = [];
    let step = 0;
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { contents?: Array<{ parts?: unknown[] }> };
      step++;
      if (step === 1) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: { file_path: 'uploads/photo.jpg' } } }] } }] }), { status: 200 });
      }
      if (step === 2) {
        seen.push(body.contents?.at(-1)?.parts);
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: { file_path: 'notes.pdf' } } }] } }],
        }), { status: 200 });
      }
      seen.push(body.contents?.at(-1)?.parts);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Dekh liya.' }] } }] }), { status: 200 });
    };
    const cfg = testConfig(dir);
    const runner = new ProviderRunner(cfg.providers, cfg, fakeFetch);
    const res = await runner.run({
      prompt: 'Photo aur pdf dekho', cwd: dir,
      settings: { model: 'gemini-4-neon', effort: 'high', fast: false },
    }, () => {}, new AbortController());
    assert.equal(res.text, 'Dekh liya.');
    const imageTurn = JSON.stringify(seen[0]);
    assert.match(imageTurn, /inlineData/);
    assert.match(imageTurn, new RegExp(TINY_PNG.toString('base64')));
    assert.doesNotMatch(imageTurn, /JFIF/);
    const pdfTurn = JSON.stringify(seen[1]);
    assert.match(pdfTurn, /binary file, not text/);
    assert.doesNotMatch(pdfTurn, /%PDF/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('text-only models are not sent picture bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myra-novis-'));
  try {
    await mkdir(path.join(dir, 'uploads'), { recursive: true });
    await writeFile(path.join(dir, 'uploads', 'photo.png'), TINY_PNG);
    const seen: Array<Record<string, unknown>> = [];
    let step = 0;
    const notes: string[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      step++;
      if (step === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'tc', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'uploads/photo.png' }) } }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Text only reply.' } }] }), { status: 200 });
    };
    const cfg = testConfig(dir);
    const runner = new ProviderRunner(cfg.providers, cfg, fakeFetch);
    const res = await runner.run({
      prompt: 'Photo padho', cwd: dir, attachedFiles: ['uploads/photo.png'],
      settings: { model: 'deepseek/deepseek-v4.1-flash-1017', effort: 'high', fast: false },
    }, ev => { if (ev.type === 'commentary') notes.push(ev.text); }, new AbortController());
    assert.equal(res.text, 'Text only reply.');
    assert.match(notes.join('\n'), /cannot look at pictures/);
    const firstUser = (seen[0].messages as Array<{ role: string; content: unknown }>).find(m => m.role === 'user');
    assert.equal(typeof firstUser?.content, 'string');
    const second = JSON.stringify(seen[1]);
    assert.doesNotMatch(second, /image_url/);
    assert.doesNotMatch(second, new RegExp(TINY_PNG.toString('base64')));
    assert.match(second, /cannot look at pictures/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fallback keeps the existing chat id instead of minting a new one each turn', async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'via fallback' } }] }), { status: 200 });
  const providers = new ProviderRunner({ keys: { openrouter: ['or-1'] } }, undefined, fakeFetch);
  const claude: Runner = { async run() { throw new AgentApiError('billing_error', 'Out of credits'); } };
  const routed = new RoutedRunner(claude, providers);
  const ids: string[] = [];
  const emit = async (ev: { type: string; id?: string }) => { if (ev.type === 'session' && ev.id) ids.push(ev.id); };
  const settings = { model: 'claude-opus-5-5', effort: 'high' as const, fast: false };
  const first = await routed.run({ prompt: 'hi', cwd: '.', session: 'office-chat', settings }, emit, new AbortController());
  const second = await routed.run({ prompt: 'again', cwd: '.', session: 'office-chat', settings }, emit, new AbortController());
  assert.equal(first.session, 'office-chat');
  assert.equal(second.session, 'office-chat');
  assert.deepEqual(ids, ['office-chat', 'office-chat']);
});

test('a new provider chat gets one id and the next turn reuses it', async () => {
  const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  const cfg = testConfig(await mkdtemp(path.join(os.tmpdir(), 'myra-ses-')));
  try {
    const runner = new ProviderRunner(cfg.providers, cfg, fakeFetch);
    const settings = { model: 'grok-4.7', effort: 'high' as const, fast: false };
    const first = await runner.run({ prompt: 'hi', cwd: cfg.dataDir, settings }, () => {}, new AbortController());
    const second = await runner.run({ prompt: 'next', cwd: cfg.dataDir, session: first.session, settings }, () => {}, new AbortController());
    assert.match(first.session, /^provider-/);
    assert.equal(second.session, first.session);
  } finally {
    await rm(cfg.dataDir, { recursive: true, force: true });
  }
});

test('unsupported image formats are not sent as picture bytes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myra-heic-'));
  try {
    await mkdir(path.join(dir, 'uploads'), { recursive: true });
    await writeFile(path.join(dir, 'uploads', 'bill.heic'), TINY_PNG);
    const seen: string[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      seen.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'No picture.' }] } }] }), { status: 200 });
    };
    const cfg = testConfig(dir);
    const runner = new ProviderRunner(cfg.providers, cfg, fakeFetch);
    await runner.run({
      prompt: 'Heic bill', cwd: dir, attachedFiles: ['uploads/bill.heic'],
      settings: { model: 'gemini-4-argon', effort: 'high', fast: false },
    }, () => {}, new AbortController());
    assert.doesNotMatch(seen[0], /inlineData/);
    assert.doesNotMatch(seen[0], new RegExp(TINY_PNG.toString('base64')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an oversized image is not sent and Read says so', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myra-big-'));
  try {
    await mkdir(path.join(dir, 'uploads'), { recursive: true });
    await writeFile(path.join(dir, 'uploads', 'big.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1, 1));
    const seen: string[] = [];
    let step = 0;
    const notes: string[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      seen.push(String(init?.body ?? ''));
      step++;
      if (step === 1) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: { file_path: 'uploads/big.png' } } }] } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Too big.' }] } }] }), { status: 200 });
    };
    const cfg = testConfig(dir);
    const runner = new ProviderRunner(cfg.providers, cfg, fakeFetch);
    await runner.run({
      prompt: 'Badi photo', cwd: dir, attachedFiles: ['uploads/big.png'],
      settings: { model: 'gemini-4-argon', effort: 'high', fast: false },
    }, ev => { if (ev.type === 'commentary') notes.push(ev.text); }, new AbortController());
    assert.doesNotMatch(seen[0], /inlineData/);
    assert.match(notes.join('\n'), /could not be sent/);
    assert.match(seen[1], /over the 8 MB limit/);
    assert.doesNotMatch(seen[1], /inlineData/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
