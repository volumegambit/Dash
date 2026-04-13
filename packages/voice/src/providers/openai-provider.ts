import OpenAI from 'openai';
import type { 
  VoiceProvider, 
  TranscriptionService, 
  SpeechService,
  TranscribeOptions,
  SynthesizeOptions 
} from '../types.js';
import { TranscriptionError, SynthesisError } from '../errors.js';

export interface OpenAIVoiceConfig {
  apiKey: string;
  stt: {
    model?: string;
    language?: string;
    temperature?: number;
  };
  tts: {
    model?: string;
    voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
    speed?: number;
  };
}

class OpenAITranscriptionService implements TranscriptionService {
  constructor(
    private openai: OpenAI,
    private config: OpenAIVoiceConfig['stt']
  ) {}

  async transcribe(audio: Buffer, options?: TranscribeOptions): Promise<string> {
    try {
      // Create a File object from buffer (Node.js 20+ supports this)
      const file = new File([audio], 'audio.wav', { type: 'audio/wav' });
      
      const transcription = await this.openai.audio.transcriptions.create({
        file,
        model: options?.model || this.config.model || 'whisper-1',
        language: options?.language || this.config.language,
        temperature: options?.temperature ?? this.config.temperature,
        response_format: 'text'
      });

      if (typeof transcription === 'string') {
        return transcription;
      }

      return transcription.text || '';
    } catch (error) {
      throw new TranscriptionError(
        `OpenAI transcription failed: ${error.message}`,
        { 
          provider: 'openai',
          model: options?.model || this.config.model,
          originalError: error 
        }
      );
    }
  }
}

class OpenAISpeechService implements SpeechService {
  constructor(
    private openai: OpenAI,
    private config: OpenAIVoiceConfig['tts']
  ) {}

  async synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer> {
    try {
      const response = await this.openai.audio.speech.create({
        model: options?.model || this.config.model || 'tts-1',
        voice: (options?.voice as any) || this.config.voice || 'alloy',
        input: text,
        speed: options?.speed || this.config.speed || 1.0,
        response_format: 'mp3'
      });

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      throw new SynthesisError(
        `OpenAI speech synthesis failed: ${error.message}`,
        {
          provider: 'openai',
          model: options?.model || this.config.model,
          voice: options?.voice || this.config.voice,
          originalError: error
        }
      );
    }
  }
}

export class OpenAIVoiceProvider implements VoiceProvider {
  readonly name = 'openai';
  readonly stt: TranscriptionService;
  readonly tts: SpeechService;
  private openai: OpenAI;

  constructor(config: OpenAIVoiceConfig) {
    this.openai = new OpenAI({
      apiKey: config.apiKey
    });

    this.stt = new OpenAITranscriptionService(this.openai, config.stt);
    this.tts = new OpenAISpeechService(this.openai, config.tts);
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Quick test with minimal audio
      const testAudio = Buffer.from([0x52, 0x49, 0x46, 0x46]); // WAV header start
      await this.stt.transcribe(testAudio);
      return true;
    } catch {
      return false;
    }
  }
}