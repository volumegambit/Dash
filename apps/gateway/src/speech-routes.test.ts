import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SPEECH_CONFIG, SpeechError } from '@dash/speech';
import type { SpeechConfig, SpeechModel, Transcription } from '@dash/speech';
import type { SpeechProviderStatus, SpeechService } from '@dash/speech';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonBody } from './json-body.test-helpers.js';
import { SpeechConfigStore } from './speech-config-store.js';
import { createSpeechRoutes } from './speech-routes.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const OK_PROVIDERS: SpeechProviderStatus[] = [
  {
    id: 'openrouter',
    capabilities: { transcription: true, speech: true, realtime: false },
    available: true,
  },
  {
    id: 'realtime',
    capabilities: { transcription: false, speech: false, realtime: true },
    available: false,
    reason: 'no_provider_offers_realtime',
  },
];

function makeSpeechService(overrides: Partial<SpeechService> = {}): SpeechService {
  return {
    providers: vi.fn().mockResolvedValue(OK_PROVIDERS),
    listModels: vi.fn().mockResolvedValue([{ id: 'm1', name: 'Model 1', kind: 'transcription' }]),
    transcribe: vi.fn().mockResolvedValue({ text: 'hello world' }),
    speechFormat: vi.fn().mockResolvedValue({ format: 'mp3' }),
    synthesize: vi.fn().mockResolvedValue({
      format: 'mp3',
      audio: (async function* () {
        yield new Uint8Array([1, 2, 3]);
      })(),
    }),
    available: vi.fn().mockResolvedValue(true),
    invalidate: vi.fn(),
    ...overrides,
  };
}

async function* twoChunks(second: Promise<void>): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([0xaa]);
  await second;
  yield new Uint8Array([0xbb]);
}

describe('createSpeechRoutes', () => {
  let dataDir: string;
  let store: SpeechConfigStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'speech-routes-'));
    store = new SpeechConfigStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('GET /config', () => {
    it('returns the persisted config and provider statuses', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/config');
      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonBody;
      expect(body.config).toEqual(DEFAULT_SPEECH_CONFIG as unknown as JsonBody);
      expect(body.providers).toEqual(OK_PROVIDERS as unknown as JsonBody);
    });
  });

  describe('PATCH /config', () => {
    it('validates, merges, persists, and returns the merged config', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tts: { voice: 'nova' } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonBody;
      expect(body.config.tts.voice).toBe('nova');
      const persisted = await store.load();
      expect(persisted.tts.voice).toBe('nova');
    });

    it('rejects an invalid patch with 400 validation_failed', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tts: { speed: 100 } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as JsonBody;
      expect(body.code).toBe('validation_failed');
      expect(body.error).toBeTruthy();
    });

    it('rejects a non-object body with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(['not', 'an', 'object']),
      });
      expect(res.status).toBe(400);
    });

    it('rejects unparseable JSON with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
    });

    it('calls onConfigChanged after a successful save', async () => {
      const speech = makeSpeechService();
      const onConfigChanged = vi.fn();
      const app = createSpeechRoutes({ speech, store, onConfigChanged });
      await app.request('/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tts: { voice: 'nova' } }),
      });
      expect(onConfigChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /models', () => {
    it('returns models for a valid kind', async () => {
      const models: SpeechModel[] = [{ id: 'm1', name: 'Model 1', kind: 'transcription' }];
      const speech = makeSpeechService({ listModels: vi.fn().mockResolvedValue(models) });
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/models?kind=transcription');
      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonBody;
      expect(body.models).toEqual(models as unknown as JsonBody);
      expect(speech.listModels).toHaveBeenCalledWith('transcription');
    });

    it('rejects an unknown kind with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/models?kind=bogus');
      expect(res.status).toBe(400);
    });

    it('rejects a missing kind with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/models');
      expect(res.status).toBe(400);
    });

    it('maps a SpeechError to httpStatusFor(code) with a retryable flag', async () => {
      const speech = makeSpeechService({
        listModels: vi.fn().mockRejectedValue(new SpeechError('unavailable', 'no provider')),
      });
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/models?kind=speech');
      expect(res.status).toBe(503);
      const body = (await res.json()) as JsonBody;
      expect(body).toEqual({ code: 'unavailable', error: 'no provider', retryable: true });
    });

    it('marks a non-network/unavailable SpeechError as not retryable', async () => {
      const speech = makeSpeechService({
        listModels: vi.fn().mockRejectedValue(new SpeechError('provider', 'boom')),
      });
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/models?kind=speech');
      expect(res.status).toBe(502);
      const body = (await res.json()) as JsonBody;
      expect(body.retryable).toBe(false);
    });
  });

  describe('POST /transcriptions', () => {
    const validBody = () => ({
      audio: Buffer.from('fake audio bytes').toString('base64'),
      format: 'wav',
      language: 'en',
    });

    it('transcribes and passes format and language through', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody()),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as JsonBody;
      expect(body.text).toBe('hello world');
      expect(speech.transcribe).toHaveBeenCalledWith(expect.any(Uint8Array), 'wav', 'en');
    });

    it('omits language when not provided', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: Buffer.from('abc').toString('base64'), format: 'mp3' }),
      });
      expect(speech.transcribe).toHaveBeenCalledWith(expect.any(Uint8Array), 'mp3', undefined);
    });

    it('returns durationSeconds when the service provides it', async () => {
      const speech = makeSpeechService({
        transcribe: vi
          .fn()
          .mockResolvedValue({ text: 'hi', durationSeconds: 1.5 } satisfies Transcription),
      });
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody()),
      });
      const body = (await res.json()) as JsonBody;
      expect(body.durationSeconds).toBe(1.5);
    });

    it('rejects a non-object body with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify('nope'),
      });
      expect(res.status).toBe(400);
    });

    it('rejects truncated/unparseable JSON with the shared validation_failed envelope', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"audio": "abc", "format": "wav"',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as JsonBody;
      expect(body).toEqual({ code: 'validation_failed', error: 'Invalid JSON', retryable: false });
    });

    it('rejects a format outside the AudioFormat set with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: Buffer.from('abc').toString('base64'), format: 'exe' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects empty audio with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: '', format: 'wav' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid base64 with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: '***not-base64***', format: 'wav' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects decoded audio over 8MB with 413 too_large', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const bigBuffer = Buffer.alloc(8 * 1024 * 1024 + 1);
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: bigBuffer.toString('base64'), format: 'wav' }),
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as JsonBody;
      expect(body.code).toBe('too_large');
      expect(speech.transcribe).not.toHaveBeenCalled();
    });

    it('accepts decoded audio at exactly 8MB', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const buffer = Buffer.alloc(8 * 1024 * 1024);
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: buffer.toString('base64'), format: 'wav' }),
      });
      expect(res.status).toBe(200);
    });

    it('rejects by Content-Length header before reading the body', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(12 * 1024 * 1024 + 1),
        },
        body: JSON.stringify(validBody()),
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as JsonBody;
      expect(body.code).toBe('too_large');
      expect(speech.transcribe).not.toHaveBeenCalled();
    });

    it('maps a provider SpeechError to httpStatusFor(code)', async () => {
      const speech = makeSpeechService({
        transcribe: vi.fn().mockRejectedValue(new SpeechError('unauthorized', 'bad key')),
      });
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/transcriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(validBody()),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as JsonBody;
      expect(body.code).toBe('unauthorized');
    });
  });

  describe('POST /speech', () => {
    it('always synthesizes mp3 explicitly', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/mpeg');
      expect(speech.synthesize).toHaveBeenCalledWith('hello', 'mp3');
    });

    it('streams chunks in order rather than buffering them', async () => {
      const gate = deferred<void>();
      const speech = makeSpeechService({
        synthesize: vi.fn().mockResolvedValue({ format: 'mp3', audio: twoChunks(gate.promise) }),
      });
      const app = createSpeechRoutes({ speech, store });

      const resPromise = app.request('/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      const res = await resPromise;
      // The response resolves (status/headers available) before the second
      // chunk's gate is released — proof this streams rather than buffers
      // the whole body before responding.
      expect(res.status).toBe(200);

      const reader = res.body?.getReader();
      const first = await reader?.read();
      expect(first?.value).toEqual(new Uint8Array([0xaa]));

      gate.resolve();
      const second = await reader?.read();
      expect(second?.value).toEqual(new Uint8Array([0xbb]));
      const third = await reader?.read();
      expect(third?.done).toBe(true);
    });

    it('calls the source iterator return() when the client cancels mid-stream', async () => {
      const returnSpy = vi.fn().mockResolvedValue({ done: true, value: undefined });
      const audio: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            next: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array([1]) }),
            return: returnSpy,
          };
        },
      };
      const speech = makeSpeechService({
        synthesize: vi.fn().mockResolvedValue({ format: 'mp3', audio }),
      });
      const app = createSpeechRoutes({ speech, store });

      const res = await app.request('/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(res.status).toBe(200);

      const reader = res.body?.getReader();
      await reader?.read();
      expect(returnSpy).not.toHaveBeenCalled();

      await reader?.cancel();
      expect(returnSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects empty text with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '' }),
      });
      expect(res.status).toBe(400);
      expect(speech.synthesize).not.toHaveBeenCalled();
    });

    it('rejects text over 4000 characters with 413 too_long', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'a'.repeat(4001) }),
      });
      expect(res.status).toBe(413);
      const body = (await res.json()) as JsonBody;
      expect(body.code).toBe('too_long');
      expect(speech.synthesize).not.toHaveBeenCalled();
    });

    it('accepts text at exactly 4000 characters', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'a'.repeat(4000) }),
      });
      expect(res.status).toBe(200);
    });

    it('maps a SpeechError thrown before the first chunk to httpStatusFor(code) JSON', async () => {
      const speech = makeSpeechService({
        synthesize: vi.fn().mockRejectedValue(new SpeechError('unavailable', 'no provider')),
      });
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).not.toBe('audio/mpeg');
      const body = (await res.json()) as JsonBody;
      expect(body.code).toBe('unavailable');
    });

    it('maps a SpeechError thrown by the async iterator before its first chunk', async () => {
      const throwingAudio: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<Uint8Array>> {
              return Promise.reject(new SpeechError('provider', 'upstream exploded'));
            },
          };
        },
      };
      const speech = makeSpeechService({
        synthesize: vi.fn().mockResolvedValue({ format: 'mp3', audio: throwingAudio }),
      });
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as JsonBody;
      expect(body.code).toBe('provider');
    });

    it('rejects a non-object body with 400', async () => {
      const speech = makeSpeechService();
      const app = createSpeechRoutes({ speech, store });
      const res = await app.request('/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(42),
      });
      expect(res.status).toBe(400);
    });
  });
});
