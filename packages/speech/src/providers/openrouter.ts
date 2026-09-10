import { SpeechError } from '../errors.js';
import type {
  SpeechCapabilities,
  SpeechModel,
  SpeechModelKind,
  SpeechProvider,
  SynthesizeOptions,
  TranscribeOptions,
  Transcription,
} from '../types.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

const CAPABILITIES: SpeechCapabilities = { transcription: true, speech: true, realtime: false };

export interface OpenRouterSpeechProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  /** Defaults to https://openrouter.ai/api/v1 */
  baseUrl?: string;
}

/** Best-effort extraction of an OpenRouter/OpenAI-shaped `{ error: { message } }` body. */
function upstreamMessage(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

/**
 * Maps a non-ok OpenRouter response to a {@link SpeechError} per the
 * provider's status-code contract: 401/403 -> unauthorized, 413 -> too_large,
 * 429/5xx -> unavailable (message calls out that it's retryable), any other
 * 4xx -> provider carrying the upstream `error.message`.
 */
async function errorFromResponse(res: Response): Promise<SpeechError> {
  const bodyText = await res.text().catch(() => '');
  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    parsed = undefined;
  }
  const message = upstreamMessage(parsed);

  if (res.status === 401 || res.status === 403) {
    return new SpeechError(
      'unauthorized',
      message ?? 'openrouter rejected the API key',
      res.status,
    );
  }
  if (res.status === 413) {
    return new SpeechError('too_large', message ?? 'openrouter request body too large', res.status);
  }
  if (res.status === 429 || res.status >= 500) {
    const base = message ?? `openrouter request failed with status ${res.status}`;
    return new SpeechError('unavailable', `${base} (retryable)`, res.status);
  }
  return new SpeechError(
    'provider',
    message ?? `openrouter request failed with status ${res.status}`,
    res.status,
  );
}

/**
 * OpenRouter-backed `SpeechProvider`. Plain `fetch` (injectable for tests),
 * no SDK. Transcription and speech both hit unified OpenRouter endpoints
 * (`/audio/transcriptions`, `/audio/speech`); realtime is not supported.
 */
export function createOpenRouterSpeechProvider(
  opts: OpenRouterSpeechProviderOptions,
): SpeechProvider {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetch ?? fetch;

  function headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${opts.apiKey}`,
      'HTTP-Referer': 'https://dash.app',
      'X-Title': 'Dash',
      'Content-Type': 'application/json',
    };
  }

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SpeechError('network', err instanceof Error ? err.message : 'network error');
    }
  }

  async function get(path: string): Promise<Response> {
    try {
      return await fetchImpl(`${baseUrl}${path}`, { headers: headers() });
    } catch (err) {
      throw new SpeechError('network', err instanceof Error ? err.message : 'network error');
    }
  }

  async function listModels(kind: SpeechModelKind): Promise<SpeechModel[]> {
    const res = await get(`/models?output_modalities=${kind}`);
    if (!res.ok) throw await errorFromResponse(res);

    const json = (await res.json()) as { data?: unknown[] };
    const data = Array.isArray(json.data) ? json.data : [];

    const models: SpeechModel[] = [];
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const id = e.id;
      const architecture = e.architecture as Record<string, unknown> | undefined;
      const outputModalities = architecture?.output_modalities;
      if (
        typeof id !== 'string' ||
        !Array.isArray(outputModalities) ||
        !outputModalities.includes(kind)
      ) {
        continue;
      }
      const name = e.name;
      models.push({ id, name: typeof name === 'string' && name.length > 0 ? name : id, kind });
    }
    return models;
  }

  async function transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<Transcription> {
    const body: Record<string, unknown> = {
      model: opts.model,
      input_audio: { data: Buffer.from(audio).toString('base64'), format: opts.format },
    };
    if (opts.language) body.language = opts.language;

    const res = await post('/audio/transcriptions', body);
    if (!res.ok) throw await errorFromResponse(res);

    const json = (await res.json()) as { text?: unknown; duration?: unknown };
    if (typeof json.text !== 'string' || json.text.length === 0) {
      throw new SpeechError('provider', 'openrouter returned an empty transcription');
    }
    return {
      text: json.text,
      durationSeconds: typeof json.duration === 'number' ? json.duration : undefined,
    };
  }

  async function* synthesize(text: string, opts: SynthesizeOptions): AsyncGenerator<Uint8Array> {
    const body: Record<string, unknown> = {
      model: opts.model,
      input: text,
      voice: opts.voice,
      response_format: opts.format === 'pcm16' ? 'pcm' : 'mp3',
    };
    if (opts.speed !== undefined) body.speed = opts.speed;

    const res = await post('/audio/speech', body);
    if (!res.ok) throw await errorFromResponse(res);
    if (!res.body) throw new SpeechError('provider', 'openrouter returned no response body');

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      yield chunk;
    }
  }

  return {
    id: 'openrouter',
    capabilities: CAPABILITIES,
    listModels,
    transcribe,
    synthesize,
  };
}
