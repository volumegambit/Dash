import { describe, it, expect } from 'vitest';
import type { 
  TranscriptionService, 
  SpeechService, 
  VoiceProvider, 
  TranscribeOptions,
  SynthesizeOptions 
} from './types.js';

describe('Voice Types', () => {
  it('should define TranscriptionService interface correctly', () => {
    // Type-only test - verifies interface structure
    const mockSTT: TranscriptionService = {
      transcribe: async (audio: Buffer, options?: TranscribeOptions) => 'test'
    };
    expect(typeof mockSTT.transcribe).toBe('function');
  });

  it('should define SpeechService interface correctly', () => {
    const mockTTS: SpeechService = {
      synthesize: async (text: string, options?: SynthesizeOptions) => Buffer.alloc(0)
    };
    expect(typeof mockTTS.synthesize).toBe('function');
  });

  it('should define VoiceProvider interface correctly', () => {
    const mockProvider: VoiceProvider = {
      name: 'test',
      stt: {
        transcribe: async () => 'test'
      },
      tts: {
        synthesize: async () => Buffer.alloc(0)
      }
    };
    expect(mockProvider.name).toBe('test');
    expect(mockProvider.stt).toBeDefined();
    expect(mockProvider.tts).toBeDefined();
  });
});