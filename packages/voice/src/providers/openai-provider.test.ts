import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIVoiceProvider } from './openai-provider.js';
import { TranscriptionError, SynthesisError } from '../errors.js';

// Mock OpenAI
vi.mock('openai', () => ({
  default: class MockOpenAI {
    audio = {
      transcriptions: {
        create: vi.fn()
      },
      speech: {
        create: vi.fn()
      }
    };
  }
}));

describe('OpenAIVoiceProvider', () => {
  let provider: OpenAIVoiceProvider;
  let mockOpenAI: any;

  beforeEach(() => {
    provider = new OpenAIVoiceProvider({
      apiKey: 'test-key',
      stt: { model: 'whisper-1' },
      tts: { model: 'tts-1', voice: 'alloy' }
    });
    mockOpenAI = (provider as any).openai;
  });

  describe('STT', () => {
    it('should transcribe audio successfully', async () => {
      const mockTranscription = { text: 'Hello world' };
      mockOpenAI.audio.transcriptions.create.mockResolvedValue(mockTranscription);

      const audioBuffer = Buffer.from('fake-audio-data');
      const result = await provider.stt.transcribe(audioBuffer);

      expect(result).toBe('Hello world');
      expect(mockOpenAI.audio.transcriptions.create).toHaveBeenCalledWith({
        file: expect.any(Object), // File object
        model: 'whisper-1',
        response_format: 'text'
      });
    });

    it('should handle transcription errors', async () => {
      mockOpenAI.audio.transcriptions.create.mockRejectedValue(
        new Error('API Error')
      );

      const audioBuffer = Buffer.from('fake-audio-data');
      
      await expect(provider.stt.transcribe(audioBuffer))
        .rejects.toThrow(TranscriptionError);
    });

    it('should use custom options', async () => {
      mockOpenAI.audio.transcriptions.create.mockResolvedValue({ text: 'Test' });

      await provider.stt.transcribe(Buffer.alloc(10), {
        language: 'es',
        temperature: 0.5
      });

      expect(mockOpenAI.audio.transcriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          language: 'es',
          temperature: 0.5
        })
      );
    });
  });

  describe('TTS', () => {
    it('should synthesize speech successfully', async () => {
      const mockResponse = {
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1024))
      };
      mockOpenAI.audio.speech.create.mockResolvedValue(mockResponse);

      const result = await provider.tts.synthesize('Hello world');

      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(1024);
      expect(mockOpenAI.audio.speech.create).toHaveBeenCalledWith({
        model: 'tts-1',
        voice: 'alloy',
        input: 'Hello world',
        speed: 1.0,
        response_format: 'mp3'
      });
    });

    it('should handle synthesis errors', async () => {
      mockOpenAI.audio.speech.create.mockRejectedValue(
        new Error('Quota exceeded')
      );

      await expect(provider.tts.synthesize('Hello world'))
        .rejects.toThrow(SynthesisError);
    });

    it('should use custom voice options', async () => {
      const mockResponse = {
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(512))
      };
      mockOpenAI.audio.speech.create.mockResolvedValue(mockResponse);

      await provider.tts.synthesize('Hello', {
        voice: 'nova',
        speed: 1.2
      });

      expect(mockOpenAI.audio.speech.create).toHaveBeenCalledWith(
        expect.objectContaining({
          voice: 'nova',
          speed: 1.2
        })
      );
    });
  });

  it('should have correct provider name', () => {
    expect(provider.name).toBe('openai');
  });
});