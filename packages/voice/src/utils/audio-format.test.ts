import { describe, it, expect } from 'vitest';
import { 
  detectAudioFormat, 
  convertToPCM16, 
  estimateAudioDuration,
  generateSilence 
} from './audio-format.js';

describe('Audio Format Utils', () => {
  it('should detect MP3 format from buffer', () => {
    const mp3Buffer = Buffer.from([0xFF, 0xFB, 0x90, 0x00, 0x01, 0x02]);
    const format = detectAudioFormat(mp3Buffer);
    
    expect(format.mimeType).toBe('audio/mpeg');
    expect(format.extension).toBe('mp3');
  });

  it('should detect WAV format from buffer', () => {
    const wavHeader = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4), // File size
      Buffer.from('WAVE', 'ascii')
    ]);
    const format = detectAudioFormat(wavHeader);
    
    expect(format.mimeType).toBe('audio/wav');
    expect(format.extension).toBe('wav');
  });

  it('should estimate audio duration for WAV', () => {
    // Create minimal WAV header with known parameters
    const sampleRate = 24000;
    const channels = 1;
    const bytesPerSample = 2;
    const numSamples = sampleRate * 2; // 2 seconds
    
    const duration = estimateAudioDuration({
      sampleRate,
      channels,
      bytesPerSample,
      dataSize: numSamples * channels * bytesPerSample
    });
    
    expect(duration).toBeCloseTo(2.0, 1);
  });

  it('should generate silence buffer', () => {
    const silence = generateSilence(1000, 24000); // 1 second at 24kHz
    
    expect(silence.length).toBe(24000 * 2); // 16-bit samples
    expect(silence.every(byte => byte === 0)).toBe(true);
  });

  it('should convert PCM16 buffer format', async () => {
    const input = Buffer.from([0xFF, 0xFB, 0x90, 0x00]); // Mock MP3
    
    // Mock conversion (in real implementation would use audio library)
    const result = await convertToPCM16(input, 'audio/mpeg');
    expect(result).toBeInstanceOf(Buffer);
  });
});