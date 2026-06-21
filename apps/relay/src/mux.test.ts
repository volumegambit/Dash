import { type Frame, decodeChunk, decodeFrame, encodeChunk, encodeFrame } from './mux.js';

describe('mux frame codec', () => {
  const frames: Frame[] = [
    {
      t: 'open',
      streamId: 1,
      target: 'mgmt',
      kind: 'http',
      method: 'GET',
      path: '/agents',
      headers: { authorization: 'Bearer t' },
    },
    { t: 'open', streamId: 2, target: 'chat', kind: 'ws', path: '/ws/chat?token=x', headers: {} },
    { t: 'head', streamId: 1, status: 200, headers: { 'content-type': 'application/json' } },
    { t: 'data', streamId: 1, chunk: 'aGk=' },
    { t: 'end', streamId: 1 },
    { t: 'close', streamId: 1, code: 4001, reason: 'Unauthorized' },
    { t: 'credit', streamId: 1, bytes: 65536 },
    { t: 'ping' },
    { t: 'pong' },
  ];

  it('round-trips every frame variant', () => {
    for (const f of frames) {
      expect(decodeFrame(encodeFrame(f))).toEqual(f);
    }
  });

  it('throws on malformed JSON', () => {
    expect(() => decodeFrame('{')).toThrow();
  });

  it('throws on an unknown frame type', () => {
    expect(() => decodeFrame(JSON.stringify({ t: 'bogus' }))).toThrow(/unknown type/);
  });

  it('preserves arbitrary binary bytes through a data frame', () => {
    // Includes a 0 byte, 0xFF, and an invalid UTF-8 sequence (0xC3 0x28).
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 0x7f, 0xc3, 0x28]);
    const frame: Frame = { t: 'data', streamId: 9, chunk: encodeChunk(bytes) };
    const decoded = decodeFrame(encodeFrame(frame)) as Extract<Frame, { t: 'data' }>;
    expect([...decodeChunk(decoded.chunk)]).toEqual([...bytes]);
  });
});
