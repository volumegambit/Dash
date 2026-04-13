import { AudioFormatError } from '../errors.js';

export interface AudioFormat {
  mimeType: string;
  extension: string;
  codec?: string;
}

export interface AudioInfo {
  sampleRate: number;
  channels: number;
  bytesPerSample: number;
  dataSize: number;
}

export function detectAudioFormat(buffer: Buffer): AudioFormat {
  if (buffer.length < 4) {
    throw new AudioFormatError('Buffer too short to detect format');
  }

  // MP3 detection
  if (buffer[0] === 0xFF && (buffer[1] & 0xF0) === 0xF0) {
    return { mimeType: 'audio/mpeg', extension: 'mp3', codec: 'mp3' };
  }

  // WAV detection
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') {
    return { mimeType: 'audio/wav', extension: 'wav', codec: 'pcm' };
  }

  // OGG detection
  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') {
    return { mimeType: 'audio/ogg', extension: 'ogg', codec: 'vorbis' };
  }

  // WebM detection (simple check)
  if (buffer.subarray(0, 4).readUInt32BE(0) === 0x1A45DFA3) {
    return { mimeType: 'audio/webm', extension: 'webm', codec: 'opus' };
  }

  // M4A/MP4 detection
  if (buffer.includes(Buffer.from('ftyp'))) {
    return { mimeType: 'audio/mp4', extension: 'm4a', codec: 'aac' };
  }

  throw new AudioFormatError('Unknown audio format', {
    headerBytes: Array.from(buffer.subarray(0, 8))
  });
}

export function estimateAudioDuration(info: AudioInfo): number {
  const totalSamples = info.dataSize / (info.channels * info.bytesPerSample);
  return totalSamples / info.sampleRate;
}

export function generateSilence(durationMs: number, sampleRate: number): Buffer {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const bufferSize = samples * 2; // 16-bit samples = 2 bytes each
  return Buffer.alloc(bufferSize, 0);
}

export async function convertToPCM16(
  audioBuffer: Buffer, 
  inputFormat: string
): Promise<Buffer> {
  // For now, return as-is for PCM formats
  // In production, would use ffmpeg or similar for conversion
  
  if (inputFormat === 'audio/wav') {
    // Extract PCM data from WAV (skip 44-byte header)
    if (audioBuffer.length > 44) {
      return audioBuffer.subarray(44);
    }
  }

  // For other formats, would need actual conversion library
  // This is a placeholder that returns the input
  console.warn(`Audio conversion from ${inputFormat} not yet implemented`);
  return audioBuffer;
}

export function extractWAVInfo(buffer: Buffer): AudioInfo {
  if (buffer.length < 44) {
    throw new AudioFormatError('WAV file too short');
  }

  // WAV header parsing
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bytesPerSample = buffer.readUInt16LE(34) / 8;
  const dataSize = buffer.readUInt32LE(40);

  return {
    sampleRate,
    channels,
    bytesPerSample,
    dataSize
  };
}

export function createWAVHeader(
  sampleRate: number, 
  channels: number, 
  dataSize: number
): Buffer {
  const header = Buffer.alloc(44);
  
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  
  // Format chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // Byte rate
  header.writeUInt16LE(channels * 2, 32); // Block align
  header.writeUInt16LE(16, 34); // Bits per sample
  
  // Data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  
  return header;
}