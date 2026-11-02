import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from './config.js';
import type { StateStore } from './state.js';
import { safeFile } from './safety.js';

export class TranscriptionError extends Error {}
export type AudioProbe = (file: string, signal?: AbortSignal) => Promise<{ durationSeconds: number; hasAudio: boolean }>;
const exec = promisify(execFile);
export const probeAudio: AudioProbe = async (file, signal) => {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { signal, timeout: 15000, maxBuffer: 100000 });
    const data = JSON.parse(stdout); const durationSeconds = Number(data.format?.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error();
    return { durationSeconds, hasAudio: data.streams?.some((s: { codec_type?: string }) => s.codec_type === 'audio') === true };
  } catch { signal?.throwIfAborted(); throw new TranscriptionError('Cannot inspect this media. Send a valid audio/video file; ffprobe must be installed.'); }
};
const responseSchema = z.object({
  text: z.string().max(2_000_000), language_code: z.string().optional(), language_probability: z.number().optional(),
  words: z.array(z.object({ text: z.string(), start: z.number().nullable().optional(), end: z.number().nullable().optional(), type: z.string().optional(), speaker_id: z.string().nullable().optional(), characters: z.array(z.object({ text: z.string(), start: z.number().nullable().optional(), end: z.number().nullable().optional() })).optional() })).max(500000).optional(),
  transcription_id: z.string().optional(),
});
const cacheSchema = z.object({ version: z.literal(1), durationSeconds: z.number().positive(), transcript: responseSchema });
type Cached = z.infer<typeof cacheSchema>;
export interface Transcript {
  text: string; language?: string; durationSeconds: number; provider: 'ElevenLabs'; model: 'scribe_v2';
  cached: boolean; hasSpeech: boolean; transcriptFile: string; metadataFile: string;
}
export type TranscriptionService = Pick<Transcriber, 'transcribe'>;

export class Transcriber {
  private pending = new Map<string, Promise<Cached>>();
  constructor(private config: Config, private store: StateStore, private fetcher: typeof fetch = fetch, private probe: AudioProbe = probeAudio) {}

  async transcribe(root: string, relative: string, language?: string, signal?: AbortSignal): Promise<Transcript> {
    signal?.throwIfAborted();
    const file = await safeFile(root, relative);
    if (!/\.(ogg|oga|opus|mp3|wav|m4a|aac|flac|aiff?|wma|mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|3gp)$/i.test(file)) throw new TranscriptionError('Choose a supported audio or video file.');
    if (language && !/^[a-z]{2,3}$/i.test(language)) throw new TranscriptionError('Use a two- or three-letter language code, or omit it for automatic detection.');
    if ((await lstat(file)).size > 50_000_000) throw new TranscriptionError('Transcription accepts files up to 50 MB. Split larger media first.');
    const bytes = await readFile(file);
    const hash = createHash('sha256').update('scribe_v2:diarize:events:character:verbatim:v1:' + (language?.toLowerCase() ?? 'auto')).update(bytes).digest('hex');
    const cacheDir = path.join(this.config.dataDir, 'bot', 'transcripts');
    const cachePath = path.join(cacheDir, hash + '.json');
    let data: Cached | undefined; let cached = true;
    try { data = cacheSchema.parse(JSON.parse(await readFile(cachePath, 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new TranscriptionError('Saved transcription cannot be read. Inspect storage before retrying; no new API request was sent.'); }
    if (!data) {
      let work = this.pending.get(hash);
      if (!work) {
        if (!this.config.elevenLabsKey) throw new TranscriptionError('ElevenLabs transcription is not configured. Set ELEVENLABS_API_KEY in the private service environment.');
        cached = false;
        work = this.convert(file, bytes, language, signal).then(async result => {
          await mkdir(cacheDir, { recursive: true, mode: 0o700 });
          const temp = cachePath + '.' + randomUUID() + '.tmp';
          await writeFile(temp, JSON.stringify(result), { mode: 0o600, flag: 'wx' }); await rename(temp, cachePath);
          const usage = this.store.data.transcriptionUsage ??= { completedRequests: 0, seconds: 0, cachedRequests: 0 };
          usage.completedRequests++; usage.seconds += result.durationSeconds; usage.lastSuccessAt = new Date().toISOString();
          await this.store.save(); return result;
        });
        this.pending.set(hash, work);
        void work.finally(() => this.pending.delete(hash)).catch(() => {});
      }
      data = await work;
    }
    signal?.throwIfAborted();
    if (cached) { const usage = this.store.data.transcriptionUsage ??= { completedRequests: 0, seconds: 0, cachedRequests: 0 }; usage.cachedRequests++; await this.store.save(); }
    // Source media is untouched. Transcripts live outside automatic output delivery;
    // Claude can deliver them on request, without cluttering every voice instruction.
    const dir = path.join(root, 'transcripts'); await mkdir(dir, { recursive: true });
    if ((await lstat(dir)).isSymbolicLink()) throw new TranscriptionError('Transcript directory must not be a symlink.');
    const stem = 'transcripts/' + path.basename(file, path.extname(file)).slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '_') + '-' + randomUUID().slice(0, 8);
    const transcriptFile = stem + '.txt'; const metadataFile = stem + '.json';
    await writeFile(path.join(root, transcriptFile), data.transcript.text, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(root, metadataFile), JSON.stringify({ provider: 'ElevenLabs', model: 'scribe_v2', source: relative, ...data }, null, 2), { flag: 'wx', mode: 0o600 });
    return { text: data.transcript.text, language: data.transcript.language_code, durationSeconds: data.durationSeconds, provider: 'ElevenLabs', model: 'scribe_v2', cached,
      hasSpeech: !!data.transcript.text.trim() && (!data.transcript.words?.length || data.transcript.words.some(w => w.type === 'word' && !!w.text.trim())), transcriptFile, metadataFile };
  }

  private async convert(file: string, bytes: Buffer, language?: string, signal?: AbortSignal): Promise<Cached> {
    const metadata = await this.probe(file, signal);
    if (!metadata.hasAudio) throw new TranscriptionError('This file has no audio stream to transcribe.');
    signal?.throwIfAborted();
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(bytes)]), path.basename(file));
    for (const [key, value] of Object.entries({ model_id: 'scribe_v2', diarize: 'true', tag_audio_events: 'true', timestamps_granularity: 'character', no_verbatim: 'false' })) form.set(key, value);
    if (language) form.set('language_code', language.toLowerCase());
    let response: Response;
    try { response = await this.fetcher('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': this.config.elevenLabsKey! }, body: form, signal: AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]), redirect: 'error' }); }
    catch { signal?.throwIfAborted(); throw new TranscriptionError('ElevenLabs connection failed or timed out. No automatic retry was performed; the provider may have received this request.'); }
    let raw: unknown; try { raw = await response.json(); } catch { throw new TranscriptionError('ElevenLabs returned an unreadable response. No automatic retry was performed.'); }
    if (!response.ok) {
      const detail = (raw as { detail?: { status?: string } })?.detail?.status ?? '';
      throw new TranscriptionError(/quota|credit|insufficient/i.test(detail) || response.status === 402 ? 'ElevenLabs credits/quota are exhausted. Audio is saved; retry from /queue after restoring credits.'
        : response.status === 401 || response.status === 403 ? 'ElevenLabs access was rejected. Check the configured key and speech-to-text permission.'
        : response.status === 429 ? 'ElevenLabs is rate limited. Audio is saved; retry later from /queue.'
        : `ElevenLabs transcription failed (HTTP ${response.status}). Audio is saved; no automatic retry was performed.`);
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new TranscriptionError('ElevenLabs returned an invalid transcript. No automatic retry was performed.');
    return { version: 1, durationSeconds: metadata.durationSeconds, transcript: parsed.data };
  }
}
