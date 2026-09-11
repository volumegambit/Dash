import { DEFAULT_SPEECH_CONFIG, type SpeechConfig } from './config.js';
import { SpeechError } from './errors.js';
import { createSpeechService } from './service.js';

interface Call {
  url: string;
  body: unknown;
}

/** Stub fetch that serves queued Responses in order and records each request. */
function queueFetch(responses: Response[]): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(input), body });
    const next = queue.shift();
    if (!next) throw new Error('queueFetch: no more stubbed responses');
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function streamResponse(
  status: number,
  chunks: Uint8Array[],
  headers?: Record<string, string>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

async function drain(audio: AsyncIterable<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of audio) total += chunk.byteLength;
  return total;
}

function configOf(config: SpeechConfig): () => Promise<SpeechConfig> {
  return async () => config;
}

// DEFAULT_SPEECH_CONFIG's tts model (minimax/speech-2.8-turbo) is MP3-only;
// these speechFormat/synthesize tests need a model on the pcm16 allow-list.
const PCM16_CONFIG: SpeechConfig = {
  ...DEFAULT_SPEECH_CONFIG,
  tts: { ...DEFAULT_SPEECH_CONFIG.tts, model: 'hexgrad/kokoro-82m' },
};

describe('createSpeechService', () => {
  describe('providers', () => {
    it('reports openrouter unavailable with no_credential when no key is configured', async () => {
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({}),
      });

      const statuses = await service.providers();
      const openrouter = statuses.find((s) => s.id === 'openrouter');
      expect(openrouter).toEqual({
        id: 'openrouter',
        capabilities: { transcription: true, speech: true, realtime: false },
        available: false,
        reason: 'no_credential',
      });
    });

    it('always includes the realtime pseudo-entry', async () => {
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({}),
      });

      const statuses = await service.providers();
      expect(statuses.find((s) => s.id === 'realtime')).toEqual({
        id: 'realtime',
        capabilities: { transcription: false, speech: false, realtime: true },
        available: false,
        reason: 'no_provider_offers_realtime',
      });
    });

    it('reports openrouter available when a key is configured', async () => {
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
      });

      const statuses = await service.providers();
      const openrouter = statuses.find((s) => s.id === 'openrouter');
      expect(openrouter?.available).toBe(true);
      expect(openrouter?.reason).toBeUndefined();
    });
  });

  describe('available', () => {
    it('is false with no key and true with a key', async () => {
      const noKeyService = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({}),
      });
      expect(await noKeyService.available()).toBe(false);

      const keyedService = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
      });
      expect(await keyedService.available()).toBe(true);
    });

    it('caches for 30s, using the injected now, and only re-reads keys after invalidate() or expiry', async () => {
      let now = 0;
      let calls = 0;
      const providerKeys = async () => {
        calls++;
        return { openrouter: 'sk-or-test' };
      };
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys,
        now: () => now,
      });

      expect(await service.available()).toBe(true);
      expect(calls).toBe(1);

      now += 29_000;
      expect(await service.available()).toBe(true);
      expect(calls).toBe(1); // still cached

      service.invalidate();
      expect(await service.available()).toBe(true);
      expect(calls).toBe(2); // invalidate() forced a re-read

      now += 30_001;
      expect(await service.available()).toBe(true);
      expect(calls).toBe(3); // window expired
    });
  });

  describe('listModels', () => {
    it('caches per (provider, kind) for 1h using the injected now, then refetches', async () => {
      let now = 0;
      const { impl, calls } = queueFetch([
        jsonResponse(200, {
          data: [
            {
              id: 'openai/whisper-large-v3',
              name: 'Whisper',
              architecture: { output_modalities: ['transcription'] },
            },
          ],
        }),
        jsonResponse(200, {
          data: [
            {
              id: 'openai/whisper-large-v3',
              name: 'Whisper v2',
              architecture: { output_modalities: ['transcription'] },
            },
          ],
        }),
      ]);
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
        now: () => now,
      });

      const first = await service.listModels('transcription');
      expect(first[0]?.name).toBe('Whisper');
      expect(calls.length).toBe(1);

      now += 3_599_000;
      const cached = await service.listModels('transcription');
      expect(cached[0]?.name).toBe('Whisper');
      expect(calls.length).toBe(1); // still cached within 1h

      now += 2_000; // crosses the 1h boundary
      const refreshed = await service.listModels('transcription');
      expect(refreshed[0]?.name).toBe('Whisper v2');
      expect(calls.length).toBe(2);
    });

    it('invalidate() drops the model cache too', async () => {
      const { impl, calls } = queueFetch([
        jsonResponse(200, { data: [] }),
        jsonResponse(200, { data: [] }),
      ]);
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      await service.listModels('transcription');
      expect(calls.length).toBe(1);
      await service.listModels('transcription');
      expect(calls.length).toBe(1);

      service.invalidate();
      await service.listModels('transcription');
      expect(calls.length).toBe(2);
    });
  });

  describe('transcribe', () => {
    it('throws unavailable when the configured provider has no key', async () => {
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({}),
      });

      await expect(service.transcribe(new Uint8Array([1]), 'wav')).rejects.toMatchObject({
        code: 'unavailable',
      });
      await expect(service.transcribe(new Uint8Array([1]), 'wav')).rejects.toBeInstanceOf(
        SpeechError,
      );
    });

    it('transcribes via the configured provider when a key is present', async () => {
      const { impl } = queueFetch([jsonResponse(200, { text: 'hello world', duration: 1.5 })]);
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      const result = await service.transcribe(new Uint8Array([1, 2, 3]), 'wav');
      expect(result).toEqual({ text: 'hello world', durationSeconds: 1.5 });
    });
  });

  describe('synthesize', () => {
    it('throws unavailable when the configured provider has no key', async () => {
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG),
        providerKeys: async () => ({}),
      });

      await expect(service.synthesize('hi')).rejects.toMatchObject({ code: 'unavailable' });
    });

    it('rejects text over 4000 characters with too_long, and accepts exactly 4000', async () => {
      const { impl } = queueFetch([streamResponse(200, [new Uint8Array([1, 2])])]);
      const service = createSpeechService({
        config: configOf(PCM16_CONFIG),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      await expect(service.synthesize('a'.repeat(4001))).rejects.toMatchObject({
        code: 'too_long',
      });

      const ok = await service.synthesize('a'.repeat(4000));
      expect(ok.format).toBe('pcm16');
      expect(await drain(ok.audio)).toBe(2);
    });

    it('defaults format from speechFormat() (pcm16 with sampleRate) when omitted', async () => {
      const { impl, calls } = queueFetch([streamResponse(200, [new Uint8Array([9, 9, 9])])]);
      const service = createSpeechService({
        config: configOf(PCM16_CONFIG),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      const result = await service.synthesize('hello');
      expect(result.format).toBe('pcm16');
      expect(result.sampleRate).toBe(24000);
      expect(await drain(result.audio)).toBe(3);
      const body = calls[0]?.body as { response_format?: string };
      expect(body.response_format).toBe('pcm');
    });

    it('uses the explicit format override instead of speechFormat(), with no sampleRate for mp3', async () => {
      const { impl, calls } = queueFetch([streamResponse(200, [new Uint8Array([9, 9, 9])])]);
      const service = createSpeechService({
        config: configOf(PCM16_CONFIG), // tts.model is pcm16-allow-listed -> speechFormat() would say pcm16
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      const result = await service.synthesize('hello', 'mp3');
      expect(result.format).toBe('mp3');
      expect(result.sampleRate).toBeUndefined();
      await drain(result.audio);
      const body = calls[0]?.body as { response_format?: string };
      expect(body.response_format).toBe('mp3');
    });

    it('prefers the provider-declared sample rate over the static table', async () => {
      const { impl } = queueFetch([
        streamResponse(200, [new Uint8Array([1, 2])], {
          'content-type': 'audio/pcm;rate=22050;channels=1',
        }),
      ]);
      const service = createSpeechService({
        config: configOf(PCM16_CONFIG), // table says 24000 for hexgrad/kokoro-82m
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      const result = await service.synthesize('hello');
      expect(result.format).toBe('pcm16');
      expect(result.sampleRate).toBe(22050);
    });

    it('falls back to the static table when the provider declares no rate', async () => {
      const { impl } = queueFetch([
        streamResponse(200, [new Uint8Array([1, 2])], { 'content-type': 'audio/pcm' }),
      ]);
      const service = createSpeechService({
        config: configOf(PCM16_CONFIG),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      const result = await service.synthesize('hello');
      expect(result.format).toBe('pcm16');
      expect(result.sampleRate).toBe(24000);
    });

    it('downgrades the MiniMax default from pcm16 wanted to mp3', async () => {
      const { impl, calls } = queueFetch([
        streamResponse(200, [new Uint8Array([1])], { 'content-type': 'audio/mpeg' }),
      ]);
      const service = createSpeechService({
        config: configOf(DEFAULT_SPEECH_CONFIG), // tts.model is minimax/speech-2.8-turbo
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      const result = await service.synthesize('hello'); // format omitted -> pcm16 wanted
      expect(result.format).toBe('mp3');
      expect(result.sampleRate).toBeUndefined();
      const body = calls[0]?.body as { response_format?: string };
      expect(body.response_format).toBe('mp3');
    });

    it('upgrades the Gemini TTS id from mp3 wanted to pcm16, using the declared rate', async () => {
      const { impl, calls } = queueFetch([
        streamResponse(200, [new Uint8Array([1, 2])], {
          'content-type': 'audio/pcm;rate=24000;channels=1',
        }),
      ]);
      const config: SpeechConfig = {
        ...DEFAULT_SPEECH_CONFIG,
        tts: { ...DEFAULT_SPEECH_CONFIG.tts, model: 'google/gemini-3.1-flash-tts-preview' },
      };
      const service = createSpeechService({
        config: configOf(config),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      const result = await service.synthesize('hello', 'mp3'); // caller wants mp3
      expect(result.format).toBe('pcm16');
      expect(result.sampleRate).toBe(24000);
      const body = calls[0]?.body as { response_format?: string };
      expect(body.response_format).toBe('pcm');
    });

    // F8: "no content-type header" and "a content-type that is not PCM" used
    // to be the same answer (`null` from `parsePcmContentType`), so an
    // allow-listed model answering `audio/mpeg` for a PCM request shipped MP3
    // bytes labelled `pcm16 @ 24 kHz` — noise on the phone.
    it('throws a provider error when a PCM request comes back with a non-PCM content-type', async () => {
      const { impl } = queueFetch([
        streamResponse(200, [new Uint8Array([1, 2])], { 'content-type': 'audio/mpeg' }),
      ]);
      const config: SpeechConfig = {
        ...DEFAULT_SPEECH_CONFIG,
        tts: { ...DEFAULT_SPEECH_CONFIG.tts, model: 'google/gemini-3.1-flash-tts-preview' },
      };
      const service = createSpeechService({
        config: configOf(config),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      await expect(service.synthesize('hello')).rejects.toMatchObject({
        code: 'provider',
        message: 'provider returned audio/mpeg for a PCM request',
      });
    });

    it('falls back to the static table when the provider declares NO content-type', async () => {
      const { impl } = queueFetch([streamResponse(200, [new Uint8Array([1, 2])], {})]);
      const service = createSpeechService({
        config: configOf(PCM16_CONFIG),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      const result = await service.synthesize('hello');
      expect(result.format).toBe('pcm16');
      expect(result.sampleRate).toBe(24000);
    });

    it('throws a provider error when pcm16 is required but neither the provider nor the static table declares a rate', async () => {
      const { impl } = queueFetch([streamResponse(200, [new Uint8Array([1])], {})]);
      const config: SpeechConfig = {
        ...DEFAULT_SPEECH_CONFIG,
        tts: { ...DEFAULT_SPEECH_CONFIG.tts, model: 'google/gemini-3.1-flash-tts-preview' },
      };
      const service = createSpeechService({
        config: configOf(config),
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
        fetch: impl,
      });

      await expect(service.synthesize('hello', 'mp3')).rejects.toMatchObject({
        code: 'provider',
        message: 'provider returned PCM without a sample rate',
      });
    });
  });

  describe('currentConfig', () => {
    it('returns the current speech config, re-reading it on every call', async () => {
      let config: SpeechConfig = DEFAULT_SPEECH_CONFIG;
      const service = createSpeechService({
        config: async () => config,
        providerKeys: async () => ({ openrouter: 'sk-or-test' }),
      });

      await expect(service.currentConfig()).resolves.toEqual(DEFAULT_SPEECH_CONFIG);

      config = { ...DEFAULT_SPEECH_CONFIG, stt: { ...DEFAULT_SPEECH_CONFIG.stt, language: 'de' } };
      await expect(service.currentConfig()).resolves.toMatchObject({ stt: { language: 'de' } });
    });
  });
});
