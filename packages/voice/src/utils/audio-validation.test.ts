import { describe, it, expect } from 'vitest';
import { validateAudioBuffer, validateAudioMetadata, getSupportedMimeTypes } from './audio-validation.js';
import { AudioFormatError } from '../errors.js';

describe('Audio Validation', () => {
  it('should validate supported audio buffer', () => {
    const mp3Header = Buffer.from([0xFF, 0xFB, 0x90, 0x00]); // MP3 header
    expect(() => validateAudioBuffer(mp3Header, 'audio/mpeg')).not.toThrow();
  });

  it('should reject empty audio buffer', () => {
    expect(() => validateAudioBuffer(Buffer.alloc(0), 'audio/mpeg'))
      .toThrow(AudioFormatError);
  });

  it('should reject oversized audio buffer', () => {
    const largeBuffer = Buffer.alloc(30 * 1024 * 1024); // 30MB
    expect(() => validateAudioBuffer(largeBuffer, 'audio/mpeg'))
      .toThrow('Audio file exceeds maximum size limit');
  });

  it('should validate audio metadata', () => {
    const metadata = {
      duration: 5.2,
      sampleRate: 24000,
      channels: 1,
      format: 'mp3',
      size: 1024
    };
    expect(() => validateAudioMetadata(metadata)).not.toThrow();
  });

  it('should reject invalid metadata', () => {
    const metadata = {
      duration: -1,
      sampleRate: 100,
      channels: 0,
      format: 'invalid',
      size: 0
    };
    expect(() => validateAudioMetadata(metadata)).toThrow();
  });

  it('should return supported MIME types', () => {
    const mimeTypes = getSupportedMimeTypes();
    expect(mimeTypes).toContain('audio/mpeg');
    expect(mimeTypes).toContain('audio/wav');
    expect(mimeTypes).toContain('audio/ogg');
  });
});