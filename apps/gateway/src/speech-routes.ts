import type { AudioFormat, SpeechErrorCode, SpeechModelKind, SpeechService } from '@dash/speech';
import {
  SpeechError,
  httpStatusFor,
  mergeSpeechConfig,
  validateSpeechConfigPatch,
  wavFromPcm16,
} from '@dash/speech';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { SpeechConfigStore } from './speech-config-store.js';

/** Upstream limit: TTS input, matches `MAX_SYNTHESIZE_CHARS` in `@dash/speech`'s service. */
const MAX_TTS_CHARS = 4_000;
/** Upstream limit: transcription clip, decoded. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/**
 * Fast-reject ceiling on the RAW (base64, JSON-wrapped) request body via
 * `Content-Length`, checked before the body is read at all. Base64 inflates
 * bytes by 4/3; 12 MB comfortably covers an 8 MB clip plus JSON envelope
 * overhead while still rejecting anything that could not possibly decode
 * under the 8 MB cap.
 */
const MAX_CONTENT_LENGTH_BYTES = 12 * 1024 * 1024;

const AUDIO_FORMATS = new Set<AudioFormat>(['wav', 'm4a', 'mp3', 'flac', 'ogg', 'webm', 'aac']);

export interface SpeechRoutesOptions {
  speech: SpeechService;
  store: SpeechConfigStore;
  /** Called after a PATCH /config successfully persists a merged config. */
  onConfigChanged?: () => void;
}

/**
 * Parse the request body as JSON, returning a discriminated result. Copied
 * from `management-api.ts`'s `parseJsonBody` (module-private there) rather
 * than exported/shared, to keep this route file decoupled from the
 * management app's internals.
 */
async function parseJsonBody<T = unknown>(
  c: Context,
): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  try {
    const body = (await c.req.json()) as T;
    return { ok: true, body };
  } catch {
    return { ok: false, response: validationFailed(c, 'Invalid JSON') };
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validationFailed(c: Context, error: string): Response {
  return c.json({ code: 'validation_failed', error, retryable: false }, 400);
}

/** Every status `httpStatusFor` can produce, for `c.json`'s literal-status overload. */
type SpeechErrorStatus = 400 | 401 | 413 | 502 | 503;

function isRetryable(code: SpeechErrorCode): boolean {
  return code === 'unavailable' || code === 'network';
}

/** Map a caught error to the shared `{ code, error, retryable }` envelope, or rethrow. */
function speechErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof SpeechError) {
    return c.json(
      { code: err.code, error: err.message, retryable: isRetryable(err.code) },
      httpStatusFor(err.code) as SpeechErrorStatus,
    );
  }
  throw err;
}

/**
 * Same arithmetic as `decodedBase64Bytes` in `chat-ws.ts`: validates the
 * string is well-formed base64 (charset + length%4==0) before decoding, and
 * returns -1 for anything that isn't, so a caller can tell "invalid" apart
 * from "valid but huge".
 */
function decodedBase64Bytes(data: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return -1;
  return Buffer.from(data, 'base64').byteLength;
}

/**
 * Build a `ReadableStream<Uint8Array>` over an `AsyncIterable`, without
 * buffering — each `pull()` advances the source iterator by exactly one
 * step. The first element is passed in already resolved (the caller awaits
 * it up front so a `SpeechError` thrown before the first chunk can be
 * mapped to a JSON error response instead of a broken stream).
 */
function streamFromAsyncIterable(
  iterator: AsyncIterator<Uint8Array>,
  first: IteratorResult<Uint8Array>,
): ReadableStream<Uint8Array> {
  let firstPulled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!firstPulled) {
        firstPulled = true;
        if (first.done) {
          controller.close();
          return;
        }
        controller.enqueue(first.value);
        return;
      }
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    // `@hono/node-server` calls `cancel()` on client disconnect (or any
    // other abandonment before the stream drains) instead of pulling to
    // completion. Without this, `iterator` — which may be mid-`for await`
    // inside a provider (e.g. openrouter.ts's `for await (const chunk of
    // res.body)`) — is left suspended forever, pinning the upstream fetch
    // response body open and leaking its socket, once per abandoned
    // playback. `.return()` is the standard signal that unwinds a `for
    // await`'s generator/iterator, running any of its cleanup (e.g. the
    // response body's own reader release). Applies whether or not `first`
    // was ever enqueued — the iterator itself is live either way.
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * Fully drains a PCM audio stream into one buffer. Only used for a PCM-only
 * model's response (Gemini TTS today) — safe to buffer in full because TTS
 * input is capped at `MAX_TTS_CHARS` (4,000 chars), so the resulting PCM
 * clip is bounded.
 */
async function bufferAudio(audio: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of audio) {
    chunks.push(chunk);
    totalLength += chunk.byteLength;
  }
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

/**
 * Routes mounted at `/speech` on both the loopback admin app and
 * `/mobile/v1` (see `management-api.ts`). Both mounts share this exact
 * implementation — the two namespaces differ only in which bearer token
 * the surrounding auth middleware checks.
 */
export function createSpeechRoutes(opts: SpeechRoutesOptions): Hono {
  const { speech, store } = opts;
  const app = new Hono();

  app.get('/config', async (c) => {
    const [config, providers] = await Promise.all([store.load(), speech.providers()]);
    return c.json({ config, providers });
  });

  app.patch('/config', async (c) => {
    const parsed = await parseJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const result = validateSpeechConfigPatch(parsed.body);
    if (!result.ok) return validationFailed(c, result.error);

    const base = await store.load();
    const merged = mergeSpeechConfig(base, result.patch);
    await store.save(merged);
    opts.onConfigChanged?.();

    const providers = await speech.providers();
    return c.json({ config: merged, providers });
  });

  app.get('/models', async (c) => {
    const kind = c.req.query('kind');
    if (kind !== 'transcription' && kind !== 'speech') {
      return validationFailed(c, "kind must be 'transcription' or 'speech'");
    }
    try {
      const models = await speech.listModels(kind satisfies SpeechModelKind);
      return c.json({ models });
    } catch (err) {
      return speechErrorResponse(c, err);
    }
  });

  app.post('/transcriptions', async (c) => {
    // Fast-reject on the declared Content-Length before reading any body —
    // avoids buffering a multi-hundred-MB request just to reject it.
    const contentLength = c.req.header('content-length');
    if (contentLength !== undefined && Number(contentLength) > MAX_CONTENT_LENGTH_BYTES) {
      return c.json({ code: 'too_large', error: 'request body too large', retryable: false }, 413);
    }

    const parsed = await parseJsonBody<Record<string, unknown>>(c);
    if (!parsed.ok) return parsed.response;
    if (!isJsonObject(parsed.body)) return validationFailed(c, 'body must be an object');

    const { audio, format, language } = parsed.body;
    if (typeof audio !== 'string') return validationFailed(c, 'audio must be a base64 string');
    if (typeof format !== 'string' || !AUDIO_FORMATS.has(format as AudioFormat)) {
      return validationFailed(c, 'format must be a supported AudioFormat');
    }
    if (language !== undefined && typeof language !== 'string') {
      return validationFailed(c, 'language must be a string');
    }

    const bytes = decodedBase64Bytes(audio);
    if (bytes < 0) return validationFailed(c, 'audio must be valid base64');
    if (bytes > MAX_AUDIO_BYTES) {
      return c.json(
        { code: 'too_large', error: 'audio exceeds the 8 MB limit', retryable: false },
        413,
      );
    }
    if (bytes === 0) return validationFailed(c, 'audio must not be empty');

    try {
      const decoded = Buffer.from(audio, 'base64');
      const result = await speech.transcribe(
        decoded,
        format as AudioFormat,
        language as string | undefined,
      );
      return c.json({
        text: result.text,
        ...(result.durationSeconds !== undefined
          ? { durationSeconds: result.durationSeconds }
          : {}),
      });
    } catch (err) {
      return speechErrorResponse(c, err);
    }
  });

  app.post('/speech', async (c) => {
    const parsed = await parseJsonBody<Record<string, unknown>>(c);
    if (!parsed.ok) return parsed.response;
    if (!isJsonObject(parsed.body)) return validationFailed(c, 'body must be an object');

    const { text } = parsed.body;
    if (typeof text !== 'string' || text.length === 0) {
      return validationFailed(c, 'text is required');
    }
    if (text.length > MAX_TTS_CHARS) {
      return c.json(
        {
          code: 'too_long',
          error: `text must be at most ${MAX_TTS_CHARS} characters`,
          retryable: false,
        },
        413,
      );
    }

    try {
      // This route always feeds a file player, so the format is pinned to
      // 'mp3' explicitly rather than deferring to speechFormat()'s
      // pcm16-for-realtime default (controller ruling, task-A5-brief.md).
      // A PCM-only model (e.g. Gemini TTS) can't honor that and comes back
      // with format: 'pcm16' instead — handled below by buffering into WAV.
      const result = await speech.synthesize(text, 'mp3');
      if (result.format === 'pcm16') {
        if (result.sampleRate === undefined) {
          throw new SpeechError('provider', 'pcm16 result is missing a sample rate');
        }
        const pcm = await bufferAudio(result.audio);
        const wav = wavFromPcm16(pcm, result.sampleRate);
        // Pass a plain ArrayBuffer rather than the Uint8Array view: under
        // some tsconfigs (e.g. apps/web's, which transitively typechecks
        // this file via mobile-test-harness.ts) TS's generic
        // `Uint8Array<ArrayBufferLike>` doesn't structurally match DOM's
        // `BodyInit`, while a bare `ArrayBuffer` always does. Sliced to
        // `wav`'s own byteOffset/byteLength rather than handed back as
        // `wav.buffer` directly, so this doesn't depend on wavFromPcm16
        // never returning a view over a larger/shared buffer.
        const wavBuffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
        return new Response(wavBuffer as ArrayBuffer, {
          headers: { 'content-type': 'audio/wav' },
        });
      }

      const iterator = result.audio[Symbol.asyncIterator]();
      // Await the first chunk BEFORE constructing the Response: a
      // SpeechError thrown here (e.g. no provider configured) must still
      // become a JSON error, not a broken audio/mpeg stream.
      const first = await iterator.next();
      const stream = streamFromAsyncIterable(iterator, first);
      return new Response(stream, { headers: { 'content-type': 'audio/mpeg' } });
    } catch (err) {
      return speechErrorResponse(c, err);
    }
  });

  return app;
}
