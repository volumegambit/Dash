export interface TranscribeOptions {
  language?: string;
  temperature?: number;
  model?: string;
}

export interface SynthesizeOptions {
  voice?: string;
  speed?: number;
  model?: string;
}

export interface TranscriptionService {
  transcribe(audio: Buffer, options?: TranscribeOptions): Promise<string>;
  streamTranscribe?(stream: AsyncIterable<ArrayBuffer>): AsyncIterable<string>;
}

export interface SpeechService {
  synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer>;
  streamSynthesize?(text: AsyncIterable<string>): AsyncIterable<ArrayBuffer>;
}

export interface VoiceProvider {
  readonly name: string;
  stt: TranscriptionService;
  tts: SpeechService;
}

export interface VoiceEvent {
  type: 'transcription_start' | 'transcription_complete' | 'voice_generation_start' | 
        'voice_generation_complete' | 'voice_chunk' | 'error';
  text?: string;
  audio?: ArrayBuffer;
  duration?: number;
  error?: Error;
  timestamp?: number;
}

export interface AudioMetadata {
  duration: number;
  sampleRate: number;
  channels: number;
  format: string;
  size: number;
}

export interface VoiceMessage {
  id: string;
  conversationId: string;
  type: 'user' | 'assistant';
  text?: string;
  audioUrl?: string;
  audioMetadata?: AudioMetadata;
  timestamp: Date;
}