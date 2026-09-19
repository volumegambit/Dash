import { wavFromPcm16 } from './wav.js';

function chunkString(bytes: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + len));
}

describe('wavFromPcm16', () => {
  it('writes a 44-byte RIFF/WAVE header for 1s of silence at 16kHz mono', () => {
    const sampleRate = 16000;
    const pcm = new Uint8Array(sampleRate * 2); // 1s, 16-bit mono, all-zero samples

    const wav = wavFromPcm16(pcm, sampleRate);

    expect(wav.length).toBe(44 + pcm.length);
    expect(chunkString(wav, 0, 4)).toBe('RIFF');
    expect(chunkString(wav, 8, 4)).toBe('WAVE');
    expect(chunkString(wav, 12, 4)).toBe('fmt ');
    expect(chunkString(wav, 36, 4)).toBe('data');

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(4, true)).toBe(36 + pcm.length); // RIFF chunk size
    expect(view.getUint32(16, true)).toBe(16); // fmt subchunk size (PCM)
    expect(view.getUint16(20, true)).toBe(1); // audio format = PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(sampleRate);
    expect(view.getUint32(28, true)).toBe(sampleRate * 1 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(pcm.length); // data subchunk size
  });

  it('carries the PCM bytes unchanged after the header', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = wavFromPcm16(pcm, 8000);
    expect(wav.slice(44)).toEqual(pcm);
  });

  it('defaults channels to 1 when the argument is omitted', () => {
    const pcm = new Uint8Array(8);
    const withDefault = wavFromPcm16(pcm, 8000);
    const explicit = wavFromPcm16(pcm, 8000, 1);
    expect(withDefault).toEqual(explicit);
  });
});
