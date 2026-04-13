export interface VoiceConfig {
  enabled: boolean;
  defaultProvider?: string;
  providers: {
    openai?: {
      stt: { model?: string; language?: string; temperature?: number };
      tts: { model?: string; voice?: string; speed?: number };
    };
    google?: {
      stt: { model?: string; languageCode?: string };
      tts: { languageCode?: string; name?: string; speakingRate?: number };
    };
  };
  audio?: {
    inputFormat?: 'pcm16' | 'wav' | 'mp3';
    inputSampleRate?: number;
    outputFormat?: 'mp3' | 'wav' | 'ogg';
    chunkDurationMs?: number;
    maxFileSizeMB?: number;
  };
}

export interface ParsedVoiceConfig extends Required<VoiceConfig> {
  audio: Required<VoiceConfig['audio']>;
}

const DEFAULT_AUDIO_CONFIG = {
  inputFormat: 'pcm16' as const,
  inputSampleRate: 24000,
  outputFormat: 'mp3' as const,
  chunkDurationMs: 100,
  maxFileSizeMB: 25
};

export function validateVoiceConfig(config: VoiceConfig): void {
  if (!config.enabled) return;

  if (config.defaultProvider && !config.providers[config.defaultProvider]) {
    throw new Error(`Default provider "${config.defaultProvider}" not found in providers`);
  }

  if (Object.keys(config.providers).length === 0) {
    throw new Error('At least one voice provider must be configured when voice is enabled');
  }

  if (config.audio?.inputSampleRate && config.audio.inputSampleRate < 8000) {
    throw new Error('Input sample rate must be at least 8000 Hz');
  }
}

export function getVoiceConfig(partial: Partial<VoiceConfig>): ParsedVoiceConfig {
  const config = {
    enabled: partial.enabled ?? false,
    defaultProvider: partial.defaultProvider ?? Object.keys(partial.providers ?? {})[0],
    providers: partial.providers ?? {},
    audio: { ...DEFAULT_AUDIO_CONFIG, ...partial.audio }
  };

  validateVoiceConfig(config);
  return config;
}