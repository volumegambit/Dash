import { describe, it, expect } from 'vitest';
import { 
  VoiceError, 
  TranscriptionError, 
  SynthesisError, 
  AudioFormatError,
  VoiceProviderError 
} from './errors.js';

describe('Voice Errors', () => {
  it('should create VoiceError with code', () => {
    const error = new VoiceError('Test message', 'TEST_CODE');
    
    expect(error.message).toBe('Test message');
    expect(error.code).toBe('TEST_CODE');
    expect(error.name).toBe('VoiceError');
    expect(error).toBeInstanceOf(Error);
  });

  it('should create TranscriptionError', () => {
    const error = new TranscriptionError('Failed to transcribe', { provider: 'openai' });
    
    expect(error.code).toBe('TRANSCRIPTION_FAILED');
    expect(error.details?.provider).toBe('openai');
  });

  it('should create SynthesisError', () => {
    const error = new SynthesisError('Failed to synthesize', { voice: 'alloy' });
    
    expect(error.code).toBe('SYNTHESIS_FAILED');
    expect(error.details?.voice).toBe('alloy');
  });

  it('should create AudioFormatError', () => {
    const error = new AudioFormatError('Unsupported format', { format: 'amr' });
    
    expect(error.code).toBe('AUDIO_FORMAT_ERROR');
    expect(error.details?.format).toBe('amr');
  });

  it('should create VoiceProviderError', () => {
    const error = new VoiceProviderError('Provider unavailable', 'openai');
    
    expect(error.code).toBe('VOICE_PROVIDER_ERROR');
    expect(error.provider).toBe('openai');
  });
});