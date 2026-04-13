import { describe, it, expect } from 'vitest';
import { VoiceConfig, validateVoiceConfig, getVoiceConfig } from './config.js';

describe('Voice Configuration', () => {
  it('should validate complete voice config', () => {
    const config: VoiceConfig = {
      enabled: true,
      defaultProvider: 'openai',
      providers: {
        openai: {
          stt: { model: 'whisper-1' },
          tts: { model: 'tts-1', voice: 'alloy' }
        }
      },
      audio: {
        inputFormat: 'pcm16',
        inputSampleRate: 24000,
        outputFormat: 'mp3',
        chunkDurationMs: 100
      }
    };

    expect(() => validateVoiceConfig(config)).not.toThrow();
  });

  it('should reject invalid provider name', () => {
    const config = {
      enabled: true,
      defaultProvider: 'invalid',
      providers: {}
    };

    expect(() => validateVoiceConfig(config)).toThrow('Default provider "invalid" not found');
  });

  it('should use defaults for missing audio config', () => {
    const config = getVoiceConfig({ 
      enabled: true,
      providers: {
        openai: {
          stt: { model: 'whisper-1' },
          tts: { model: 'tts-1' }
        }
      }
    });
    
    expect(config.audio.inputSampleRate).toBe(24000);
    expect(config.audio.outputFormat).toBe('mp3');
  });
});