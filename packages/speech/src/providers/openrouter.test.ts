import { SpeechError } from '../errors.js';
import { createOpenRouterSpeechProvider } from './openrouter.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Stub fetch that serves queued Responses in order and records each request. */
function queueFetch(responses: Response[]): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}),
    );
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body });
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

function streamResponse(status: number, chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status });
}

describe('createOpenRouterSpeechProvider', () => {
  it('exposes id and capabilities', () => {
    const provider = createOpenRouterSpeechProvider({ apiKey: 'k' });
    expect(provider.id).toBe('openrouter');
    expect(provider.capabilities).toEqual({ transcription: true, speech: true, realtime: false });
  });

  describe('listModels', () => {
    it('GETs models?output_modalities and maps id/name, dropping mismatched-kind models', async () => {
      const { impl, calls } = queueFetch([
        jsonResponse(200, {
          data: [
            {
              id: 'openai/whisper-large-v3',
              name: 'Whisper Large v3',
              architecture: { output_modalities: ['transcription'] },
            },
            {
              id: 'minimax/speech-2.8-turbo',
              name: 'MiniMax: Speech 2.8 Turbo',
              architecture: { output_modalities: ['speech'] },
            },
          ],
        }),
      ]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      const models = await provider.listModels('transcription');

      expect(models).toEqual([
        { id: 'openai/whisper-large-v3', name: 'Whisper Large v3', kind: 'transcription' },
      ]);
      expect(calls[0]?.url).toBe(
        'https://openrouter.ai/api/v1/models?output_modalities=transcription',
      );
      expect(calls[0]?.method).toBe('GET');
      expect(calls[0]?.headers.Authorization).toBe('Bearer sk-or-test');
      expect(calls[0]?.headers['HTTP-Referer']).toBe('https://dash.app');
      expect(calls[0]?.headers['X-Title']).toBe('Dash');
    });

    it('honors a custom baseUrl', async () => {
      const { impl, calls } = queueFetch([jsonResponse(200, { data: [] })]);
      const provider = createOpenRouterSpeechProvider({
        apiKey: 'k',
        fetch: impl,
        baseUrl: 'https://example.test/v1',
      });
      await provider.listModels('speech');
      expect(calls[0]?.url).toBe('https://example.test/v1/models?output_modalities=speech');
    });

    it('throws a provider error on a non-JSON 200 body instead of a raw SyntaxError', async () => {
      const { impl } = queueFetch([new Response('not json', { status: 200 })]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      const err = await provider.listModels('transcription').catch((caught) => caught);
      expect(err).toBeInstanceOf(SpeechError);
      expect(err).toMatchObject({ code: 'provider' });
    });
  });

  describe('transcribe', () => {
    it('POSTs base64 audio + format + language and returns text/duration', async () => {
      const { impl, calls } = queueFetch([
        jsonResponse(200, { text: 'hello world', duration: 1.5 }),
      ]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });
      const audio = new Uint8Array([1, 2, 3, 4]);

      const result = await provider.transcribe(audio, {
        model: 'openai/whisper-large-v3',
        format: 'wav',
        language: 'en',
      });

      expect(result).toEqual({ text: 'hello world', durationSeconds: 1.5 });
      expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.headers.Authorization).toBe('Bearer sk-or-test');
      expect(calls[0]?.headers['HTTP-Referer']).toBe('https://dash.app');
      expect(calls[0]?.headers['X-Title']).toBe('Dash');
      expect(calls[0]?.body).toEqual({
        model: 'openai/whisper-large-v3',
        input_audio: { data: Buffer.from(audio).toString('base64'), format: 'wav' },
        language: 'en',
      });
    });

    it('omits language when not given', async () => {
      const { impl, calls } = queueFetch([jsonResponse(200, { text: 'hi' })]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      await provider.transcribe(new Uint8Array([9]), {
        model: 'openai/whisper-large-v3',
        format: 'wav',
      });

      expect(calls[0]?.body).toEqual({
        model: 'openai/whisper-large-v3',
        input_audio: { data: Buffer.from([9]).toString('base64'), format: 'wav' },
      });
    });

    it('throws a provider error on empty text in a 200', async () => {
      const { impl } = queueFetch([jsonResponse(200, { text: '' })]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      await expect(
        provider.transcribe(new Uint8Array([1]), { model: 'm', format: 'wav' }),
      ).rejects.toMatchObject({ code: 'provider' });
    });

    it('throws a provider error on a non-JSON 200 body instead of a raw SyntaxError', async () => {
      const { impl } = queueFetch([new Response('not json', { status: 200 })]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      const err = await provider
        .transcribe(new Uint8Array([1]), { model: 'm', format: 'wav' })
        .catch((caught) => caught);
      expect(err).toBeInstanceOf(SpeechError);
      expect(err).toMatchObject({ code: 'provider' });
    });
  });

  describe('synthesize', () => {
    it('maps pcm16 -> response_format "pcm" and streams chunks in order', async () => {
      const chunk1 = new Uint8Array([1, 2]);
      const chunk2 = new Uint8Array([3, 4]);
      const { impl, calls } = queueFetch([streamResponse(200, [chunk1, chunk2])]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      const chunks: Uint8Array[] = [];
      for await (const chunk of provider.synthesize('hello', {
        model: 'minimax/speech-2.8-turbo',
        voice: 'English_expressive_narrator',
        format: 'pcm16',
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([chunk1, chunk2]);
      expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/audio/speech');
      expect(calls[0]?.method).toBe('POST');
      expect(calls[0]?.headers.Authorization).toBe('Bearer sk-or-test');
      expect(calls[0]?.headers['HTTP-Referer']).toBe('https://dash.app');
      expect(calls[0]?.headers['X-Title']).toBe('Dash');
      expect(calls[0]?.body).toMatchObject({
        model: 'minimax/speech-2.8-turbo',
        input: 'hello',
        voice: 'English_expressive_narrator',
        response_format: 'pcm',
      });
    });

    it('maps mp3 -> response_format "mp3" and includes speed when given', async () => {
      const { impl, calls } = queueFetch([streamResponse(200, [new Uint8Array([9])])]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      const chunks: Uint8Array[] = [];
      for await (const chunk of provider.synthesize('hi', {
        model: 'm',
        voice: 'v',
        format: 'mp3',
        speed: 1.5,
      })) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(1);
      expect(calls[0]?.body).toMatchObject({ response_format: 'mp3', speed: 1.5 });
    });

    it('throws on a non-ok response before yielding any chunk', async () => {
      const { impl } = queueFetch([jsonResponse(401, { error: { message: 'no key' } })]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'bad', fetch: impl });

      const iter = provider
        .synthesize('hi', { model: 'm', voice: 'v', format: 'mp3' })
        [Symbol.asyncIterator]();

      await expect(iter.next()).rejects.toMatchObject({ code: 'unauthorized' });
    });
  });

  describe('error mapping', () => {
    const cases: Array<[number, string]> = [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [413, 'too_large'],
      [429, 'unavailable'],
      [500, 'unavailable'],
      [503, 'unavailable'],
      [400, 'provider'],
      [404, 'provider'],
    ];

    it.each(cases)('maps status %d to code %s', async (status, code) => {
      const { impl } = queueFetch([jsonResponse(status, { error: { message: 'upstream broke' } })]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      await expect(
        provider.transcribe(new Uint8Array([1]), { model: 'm', format: 'wav' }),
      ).rejects.toMatchObject({ code });
    });

    it('is a SpeechError instance carrying the HTTP status', async () => {
      const { impl } = queueFetch([jsonResponse(401, { error: { message: 'nope' } })]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      await expect(
        provider.transcribe(new Uint8Array([1]), { model: 'm', format: 'wav' }),
      ).rejects.toBeInstanceOf(SpeechError);
    });

    it('includes "retryable" in the message for 429/5xx', async () => {
      const { impl } = queueFetch([jsonResponse(429, { error: { message: 'rate limited' } })]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      await expect(
        provider.transcribe(new Uint8Array([1]), { model: 'm', format: 'wav' }),
      ).rejects.toThrow(/retryable/i);
    });

    it('surfaces the upstream error.message on other 4xx as a provider error', async () => {
      const { impl } = queueFetch([jsonResponse(400, { error: { message: 'bad model id' } })]);
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      await expect(
        provider.transcribe(new Uint8Array([1]), { model: 'm', format: 'wav' }),
      ).rejects.toThrow('bad model id');
    });

    it('maps a thrown fetch to a network error', async () => {
      const impl = (async () => {
        throw new Error('ECONNRESET');
      }) as typeof fetch;
      const provider = createOpenRouterSpeechProvider({ apiKey: 'sk-or-test', fetch: impl });

      await expect(
        provider.transcribe(new Uint8Array([1]), { model: 'm', format: 'wav' }),
      ).rejects.toMatchObject({ code: 'network' });
    });
  });
});
