import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transcriber, type AudioProbe } from '../src/transcription.js';
import { StateStore } from '../src/state.js';
import { loadConfig, configSecrets } from '../src/config.js';
import { agentEnvironment } from '../src/agent.js';

async function setup(fetcher: typeof fetch, probe: AudioProbe = async () => ({ durationSeconds: 3, hasAudio: true })) {
  const dir = await mkdtemp(path.join(tmpdir(), 'stt-test-'));
  const root = path.join(dir, 'workspaces', 'default'); await mkdir(path.join(root, 'uploads'), { recursive: true });
  await writeFile(path.join(root, 'uploads', 'voice.ogg'), 'synthetic audio');
  const store = await StateStore.open(path.join(dir, 'bot', 'state.json'));
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuvw', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'test-only', ELEVENLABS_API_KEY: 'private-eleven-key', DATA_DIR: dir });
  return { config, root, store, service: new Transcriber(config, store, fetcher, probe) };
}
const transcript = { language_code: 'hin', language_probability: 0.98, text: 'Kal meeting hai.', words: [{ text: 'Kal', start: 0, end: 0.4, speaker_id: 'speaker_0', type: 'word' }] };

test('Scribe tool preserves originals, exports transcripts, caches across restarts and counts actual requests', async () => {
  let calls = 0;
  const fetcher = (async (url: unknown, init: RequestInit) => {
    calls++; assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
    const form = init.body as FormData;
    assert.equal(form.get('model_id'), 'scribe_v2'); assert.equal(form.get('diarize'), 'true');
    assert.equal(form.get('timestamps_granularity'), 'character'); assert.equal(form.get('no_verbatim'), 'false');
    assert.equal(form.get('language_code'), null);
    return new Response(JSON.stringify(transcript));
  }) as typeof fetch;
  const { service, root, config, store } = await setup(fetcher);
  const first = await service.transcribe(root, 'uploads/voice.ogg');
  assert.equal(first.cached, false); assert.equal(first.text, transcript.text);
  assert.match(await readFile(path.join(root, first.transcriptFile), 'utf8'), /Kal meeting/);
  assert.equal(await readFile(path.join(root, 'uploads/voice.ogg'), 'utf8'), 'synthetic audio');
  const reopened = await StateStore.open(store.file);
  const next = new Transcriber(config, reopened, fetcher, async () => ({ hasAudio: true, durationSeconds: 3 }));
  assert.equal((await next.transcribe(root, 'uploads/voice.ogg')).cached, true); assert.equal(calls, 1);
  assert.equal(reopened.data.transcriptionUsage!.completedRequests, 1); assert.equal(reopened.data.transcriptionUsage!.seconds, 3);
  assert.ok(configSecrets(config).includes('private-eleven-key'));
  assert.ok(!Object.values(agentEnvironment(config)).includes('private-eleven-key'));
});

test('path traversal, secrets, unsupported files and silent video streams fail before provider calls', async () => {
  let calls = 0; const { service, root } = await setup((async () => { calls++; return new Response('{}'); }) as typeof fetch);
  await assert.rejects(service.transcribe(root, '../voice.ogg'), /not allowed/);
  await assert.rejects(service.transcribe(root, '.env'), /not allowed/);
  await writeFile(path.join(root, 'script.ts'), 'not audio');
  await assert.rejects(service.transcribe(root, 'script.ts'), /supported audio or video/);
  const silent = await setup((async () => { calls++; return new Response('{}'); }) as typeof fetch, async () => ({ durationSeconds: 3, hasAudio: false }));
  await assert.rejects(silent.service.transcribe(silent.root, 'uploads/voice.ogg'), /no audio stream/);
  assert.equal(calls, 0);
});

test('provider rejection is redacted, is not retried and does not create a success cache', async () => {
  let calls = 0; const { service, root, store } = await setup((async () => { calls++; return new Response(JSON.stringify({ detail: { status: 'quota_exceeded', message: 'private-eleven-key secret upstream detail' } }), { status: 401 }); }) as typeof fetch);
  await assert.rejects(service.transcribe(root, 'uploads/voice.ogg'), e => e instanceof Error && /credits|quota/i.test(e.message) && !/private-eleven-key|upstream detail/.test(e.message));
  assert.equal(calls, 1); assert.equal(store.data.transcriptionUsage?.completedRequests ?? 0, 0);
  assert.ok(!JSON.stringify(store.data).includes('private-eleven-key'));
});

test('concurrent identical tool calls use one provider request; changed audio is a new request', async () => {
  let calls = 0; const { service, root } = await setup((async () => { calls++; return new Response(JSON.stringify(transcript)); }) as typeof fetch);
  await Promise.all([service.transcribe(root, 'uploads/voice.ogg'), service.transcribe(root, 'uploads/voice.ogg')]);
  assert.equal(calls, 1);
  await writeFile(path.join(root, 'uploads/voice.ogg'), 'different audio'); await service.transcribe(root, 'uploads/voice.ogg');
  assert.equal(calls, 2);
});

test('missing key and cancelled work do not send audio to a provider', async () => {
  let calls = 0; const { service, root, config, store } = await setup((async () => { calls++; return new Response('{}'); }) as typeof fetch);
  await assert.rejects(new Transcriber({ ...config, elevenLabsKey: undefined }, store).transcribe(root, 'uploads/voice.ogg'), /not configured/);
  await assert.rejects(service.transcribe(root, 'uploads/voice.ogg', undefined, AbortSignal.abort()));
  assert.equal(calls, 0);
});
