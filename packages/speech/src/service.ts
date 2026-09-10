import type { SpeechConfig } from './config.js';
import { SpeechError } from './errors.js';
import { parsePcmContentType, pcmFormatFor, speechRequestFormat } from './pcm-formats.js';
import { createOpenRouterSpeechProvider } from './providers/openrouter.js';
import type {
  AudioFormat,
  SpeechCapabilities,
  SpeechModel,
  SpeechModelKind,
  SpeechProvider,
  Transcription,
} from './types.js';

const AVAILABILITY_CACHE_MS = 30_000;
const MODEL_CACHE_MS = 60 * 60 * 1000;
const MAX_SYNTHESIZE_CHARS = 4_000;

export type SpeechProviderReason = 'no_credential' | 'no_provider_offers_realtime';

export interface SpeechProviderStatus {
  id: string;
  capabilities: SpeechCapabilities;
  available: boolean;
  reason?: SpeechProviderReason;
}

export interface SpeechServiceOptions {
  config: () => Promise<SpeechConfig>;
  /** e.g. credentialStore.readProviderApiKeys — provider id -> API key. */
  providerKeys: () => Promise<Record<string, string>>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SpeechService {
  /**
   * The speech config in force right now, re-read from the options' `config`
   * on every call (never cached) — a caller that needs a field of it, such as
   * `stt.language` for a transcription, must see a config change immediately.
   */
  currentConfig(): Promise<SpeechConfig>;
  /** Always includes the 'openrouter' entry and the 'realtime' pseudo-entry. */
  providers(): Promise<SpeechProviderStatus[]>;
  /** Cached 1h per (provider, kind). */
  listModels(kind: SpeechModelKind): Promise<SpeechModel[]>;
  transcribe(audio: Uint8Array, format: AudioFormat, language?: string): Promise<Transcription>;
  /**
   * Derived from speechRequestFormat(config.tts.model, 'pcm16'), with the
   * sampleRate (when applicable) coming from the static pcmFormatFor table
   * — there's no live response yet to declare one.
   */
  speechFormat(): Promise<{ format: 'pcm16' | 'mp3'; sampleRate?: number }>;
  /**
   * `format` is the caller's WANTED format: omitted, it defaults to
   * 'pcm16'; given, it's still resolved through speechRequestFormat against
   * the configured model rather than used as-is — a PCM-only model (e.g.
   * Gemini TTS) upgrades an 'mp3' request to 'pcm16' since it would
   * otherwise reject the request outright, and a non-PCM model downgrades
   * a 'pcm16' request to 'mp3'.
   */
  synthesize(
    text: string,
    format?: 'pcm16' | 'mp3',
  ): Promise<{ format: 'pcm16' | 'mp3'; sampleRate?: number; audio: AsyncIterable<Uint8Array> }>;
  /** Any provider with transcription && speech available. Cached 30s. */
  available(): Promise<boolean>;
  /** Drops the availability cache and the model cache. */
  invalidate(): void;
}

/** Capabilities of the providers this service knows how to build. Only 'openrouter' is real today. */
const PROVIDER_CAPABILITIES: Record<string, SpeechCapabilities> = {
  openrouter: { transcription: true, speech: true, realtime: false },
};

const REALTIME_PSEUDO_STATUS: SpeechProviderStatus = {
  id: 'realtime',
  capabilities: { transcription: false, speech: false, realtime: true },
  available: false,
  reason: 'no_provider_offers_realtime',
};

interface ModelCacheEntry {
  models: SpeechModel[];
  expiresAt: number;
}

export function createSpeechService(opts: SpeechServiceOptions): SpeechService {
  const now = opts.now ?? Date.now;

  let availabilityCache: { value: boolean; expiresAt: number } | null = null;
  const modelCache = new Map<string, ModelCacheEntry>();

  /** Builds a provider lazily from the current key set; null if unconfigured/unknown. */
  async function getProvider(id: string): Promise<SpeechProvider | null> {
    const keys = await opts.providerKeys();
    const apiKey = keys[id];
    if (!apiKey) return null;
    if (id === 'openrouter') {
      return createOpenRouterSpeechProvider({ apiKey, fetch: opts.fetch });
    }
    return null;
  }

  async function currentConfig(): Promise<SpeechConfig> {
    return opts.config();
  }

  async function providers(): Promise<SpeechProviderStatus[]> {
    const keys = await opts.providerKeys();
    const openrouterKey = keys.openrouter;
    const openrouterStatus: SpeechProviderStatus = {
      id: 'openrouter',
      capabilities: PROVIDER_CAPABILITIES.openrouter,
      available: Boolean(openrouterKey),
      ...(openrouterKey ? {} : { reason: 'no_credential' as const }),
    };
    return [openrouterStatus, REALTIME_PSEUDO_STATUS];
  }

  async function listModels(kind: SpeechModelKind): Promise<SpeechModel[]> {
    const config = await opts.config();
    const providerId = kind === 'transcription' ? config.stt.provider : config.tts.provider;
    const cacheKey = `${providerId}:${kind}`;

    const cached = modelCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      return cached.models;
    }

    const provider = await getProvider(providerId);
    if (!provider) {
      throw new SpeechError('unavailable', 'No speech provider is configured');
    }

    const models = await provider.listModels(kind);
    modelCache.set(cacheKey, { models, expiresAt: now() + MODEL_CACHE_MS });
    return models;
  }

  async function transcribe(
    audio: Uint8Array,
    format: AudioFormat,
    language?: string,
  ): Promise<Transcription> {
    const config = await opts.config();
    const provider = await getProvider(config.stt.provider);
    if (!provider) {
      throw new SpeechError('unavailable', 'No speech provider is configured');
    }
    return provider.transcribe(audio, {
      model: config.stt.model,
      format,
      language: language ?? config.stt.language,
    });
  }

  async function speechFormat(): Promise<{ format: 'pcm16' | 'mp3'; sampleRate?: number }> {
    const config = await opts.config();
    const format = speechRequestFormat(config.tts.model, 'pcm16');
    if (format !== 'pcm16') return { format: 'mp3' };
    const pcm = pcmFormatFor(config.tts.model);
    return pcm ? { format: 'pcm16', sampleRate: pcm.sampleRate } : { format: 'pcm16' };
  }

  async function synthesize(
    text: string,
    format?: 'pcm16' | 'mp3',
  ): Promise<{ format: 'pcm16' | 'mp3'; sampleRate?: number; audio: AsyncIterable<Uint8Array> }> {
    if (text.length > MAX_SYNTHESIZE_CHARS) {
      throw new SpeechError('too_long', `text must be at most ${MAX_SYNTHESIZE_CHARS} characters`);
    }

    const config = await opts.config();
    const provider = await getProvider(config.tts.provider);
    if (!provider) {
      throw new SpeechError('unavailable', 'No speech provider is configured');
    }

    // format is an override of what the CALLER wants; speechRequestFormat
    // still has final say, since a PCM-only model (e.g. Gemini) rejects an
    // 'mp3' request outright and a non-PCM model can't honor 'pcm16'.
    const resolved = speechRequestFormat(config.tts.model, format ?? 'pcm16');

    const stream = await provider.synthesize(text, {
      model: config.tts.model,
      voice: config.tts.voice,
      format: resolved,
      speed: config.tts.speed,
    });

    let sampleRate: number | undefined;
    if (resolved === 'pcm16') {
      // The provider's declared content-type beats the static table — it
      // reflects what THIS response actually is; the table is only a
      // fallback for a provider that omits the rate.
      sampleRate =
        parsePcmContentType(stream.contentType)?.sampleRate ??
        pcmFormatFor(config.tts.model)?.sampleRate;
      if (sampleRate === undefined) {
        throw new SpeechError('provider', 'provider returned PCM without a sample rate');
      }
    }

    return { format: resolved, sampleRate, audio: stream.audio };
  }

  async function available(): Promise<boolean> {
    if (availabilityCache && availabilityCache.expiresAt > now()) {
      return availabilityCache.value;
    }

    const statuses = await providers();
    const value = statuses.some(
      (s) => s.capabilities.transcription && s.capabilities.speech && s.available,
    );
    availabilityCache = { value, expiresAt: now() + AVAILABILITY_CACHE_MS };
    return value;
  }

  function invalidate(): void {
    availabilityCache = null;
    modelCache.clear();
  }

  return {
    currentConfig,
    providers,
    listModels,
    transcribe,
    speechFormat,
    synthesize,
    available,
    invalidate,
  };
}
