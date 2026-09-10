export type {
  AudioFormat,
  SpeechCapabilities,
  SpeechModel,
  SpeechModelKind,
  SpeechProvider,
  SynthesizeOptions,
  Transcription,
  TranscribeOptions,
} from './types.js';
export { SpeechError, httpStatusFor } from './errors.js';
export type { SpeechErrorCode } from './errors.js';
export {
  DEFAULT_SPEECH_CONFIG,
  mergeSpeechConfig,
  validateSpeechConfigPatch,
} from './config.js';
export type { SpeechConfig, SpeechConfigPatch, ValidationResult } from './config.js';
export { pcmFormatFor } from './pcm-formats.js';
export type { Pcm16Format } from './pcm-formats.js';
export { wavFromPcm16 } from './wav.js';
export { createOpenRouterSpeechProvider } from './providers/openrouter.js';
export type { OpenRouterSpeechProviderOptions } from './providers/openrouter.js';
export { createSpeechService } from './service.js';
export type {
  SpeechProviderReason,
  SpeechProviderStatus,
  SpeechService,
  SpeechServiceOptions,
} from './service.js';
