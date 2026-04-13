import { AudioFormatError } from '../errors.js';
import type { AudioMetadata } from '../types.js';

const SUPPORTED_MIME_TYPES = [
  'audio/mpeg',      // MP3
  'audio/wav',       // WAV
  'audio/ogg',       // OGG
  'audio/webm',      // WebM
  'audio/mp4',       // M4A
  'audio/x-m4a',     // M4A alternative
  'application/ogg'  // OGG alternative
];

const MAX_AUDIO_SIZE_MB = 25;
const MIN_DURATION_MS = 100;
const MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export function validateAudioBuffer(buffer: Buffer, mimeType: string): void {
  if (buffer.length === 0) {
    throw new AudioFormatError('Audio buffer is empty');
  }

  if (buffer.length > MAX_AUDIO_SIZE_MB * 1024 * 1024) {
    throw new AudioFormatError(
      `Audio file exceeds maximum size limit of ${MAX_AUDIO_SIZE_MB}MB`,
      { size: buffer.length, maxSize: MAX_AUDIO_SIZE_MB * 1024 * 1024 }
    );
  }

  if (!SUPPORTED_MIME_TYPES.includes(mimeType)) {
    throw new AudioFormatError(
      `Unsupported audio format: ${mimeType}`,
      { mimeType, supportedTypes: SUPPORTED_MIME_TYPES }
    );
  }

  // Basic header validation for common formats
  validateAudioHeader(buffer, mimeType);
}

export function validateAudioMetadata(metadata: AudioMetadata): void {
  if (metadata.duration < MIN_DURATION_MS / 1000) {
    throw new AudioFormatError(
      `Audio too short: ${metadata.duration}s (minimum ${MIN_DURATION_MS / 1000}s)`,
      { duration: metadata.duration, minimum: MIN_DURATION_MS / 1000 }
    );
  }

  if (metadata.duration > MAX_DURATION_MS / 1000) {
    throw new AudioFormatError(
      `Audio too long: ${metadata.duration}s (maximum ${MAX_DURATION_MS / 1000}s)`,
      { duration: metadata.duration, maximum: MAX_DURATION_MS / 1000 }
    );
  }

  if (metadata.sampleRate < 8000 || metadata.sampleRate > 48000) {
    throw new AudioFormatError(
      `Invalid sample rate: ${metadata.sampleRate}Hz (must be 8000-48000Hz)`,
      { sampleRate: metadata.sampleRate }
    );
  }

  if (metadata.channels < 1 || metadata.channels > 2) {
    throw new AudioFormatError(
      `Invalid channel count: ${metadata.channels} (must be 1-2)`,
      { channels: metadata.channels }
    );
  }

  if (metadata.size <= 0) {
    throw new AudioFormatError('Invalid file size', { size: metadata.size });
  }
}

function validateAudioHeader(buffer: Buffer, mimeType: string): void {
  if (buffer.length < 4) {
    throw new AudioFormatError('Audio file too short to validate header');
  }

  switch (mimeType) {
    case 'audio/mpeg':
      // MP3 header starts with 0xFF 0xFB or 0xFF 0xFA
      if (!(buffer[0] === 0xFF && (buffer[1] & 0xF0) === 0xF0)) {
        throw new AudioFormatError('Invalid MP3 header');
      }
      break;

    case 'audio/wav':
      // WAV header starts with "RIFF"
      if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') {
        throw new AudioFormatError('Invalid WAV header');
      }
      break;

    case 'audio/ogg':
    case 'application/ogg':
      // OGG header starts with "OggS"
      if (buffer.subarray(0, 4).toString('ascii') !== 'OggS') {
        throw new AudioFormatError('Invalid OGG header');
      }
      break;

    // Other formats - basic size check only
    default:
      break;
  }
}

export function getSupportedMimeTypes(): string[] {
  return [...SUPPORTED_MIME_TYPES];
}

export function isAudioMimeType(mimeType: string): boolean {
  return SUPPORTED_MIME_TYPES.includes(mimeType);
}