export type SpeechModelKind = 'transcription' | 'speech';
export type AudioFormat = 'wav' | 'm4a' | 'mp3' | 'flac' | 'ogg' | 'webm' | 'aac';

export interface SpeechModel {
  id: string;
  name: string;
  kind: SpeechModelKind;
  voices?: string[];
}

export interface Transcription {
  text: string;
  durationSeconds?: number;
}

export interface TranscribeOptions {
  model: string;
  format: AudioFormat;
  language?: string;
}

export interface SynthesizeOptions {
  model: string;
  voice: string;
  format: 'pcm16' | 'mp3';
  speed?: number;
}

export interface SpeechCapabilities {
  transcription: boolean;
  speech: boolean;
  realtime: boolean;
}

/**
 * A provider's raw synthesis response: the audio stream plus the raw
 * upstream `content-type` header (`null` if the provider didn't send one),
 * so a caller can recover PCM shape (sample rate, channels) that a provider
 * like OpenRouter declares there rather than in the response body.
 */
export interface SynthesisStream {
  contentType: string | null;
  audio: AsyncIterable<Uint8Array>;
}

export interface SpeechProvider {
  readonly id: string;
  readonly capabilities: SpeechCapabilities;
  listModels(kind: SpeechModelKind): Promise<SpeechModel[]>;
  transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<Transcription>;
  synthesize(text: string, opts: SynthesizeOptions): Promise<SynthesisStream>;
}
