const WAV_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const PCM_AUDIO_FORMAT = 1;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Prepends a 44-byte canonical RIFF/WAVE header to raw 16-bit PCM samples,
 * so a PCM stream from a provider that only emits headerless `pcm16` can be
 * played or saved as a standard `.wav` file.
 */
export function wavFromPcm16(pcm: Uint8Array, sampleRate: number, channels: 1 = 1): Uint8Array {
  const blockAlign = channels * (BITS_PER_SAMPLE / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // RIFF chunk size: 36 + data size
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt subchunk size (16 for PCM)
  view.setUint16(20, PCM_AUDIO_FORMAT, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const out = new Uint8Array(buffer);
  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}
