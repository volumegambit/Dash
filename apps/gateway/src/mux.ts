/**
 * Frame codec for the gateway↔relay multiplexing socket.
 *
 * This is a verbatim copy of apps/relay/src/mux.ts — the two ends of the tunnel
 * must agree on the wire format. Keep them in lock-step (extract to a shared
 * package if it grows). See apps/relay for the protocol overview.
 */
export type Target = 'mgmt' | 'chat';
export type StreamKind = 'http' | 'ws';

export type Frame =
  // relay → gateway: start a stream (HTTP request line / WS upgrade)
  | {
      t: 'open';
      streamId: number;
      target: Target;
      kind: StreamKind;
      method?: string;
      path: string;
      headers: Record<string, string>;
    }
  // gateway → relay: response status + headers (HTTP), or 101 (WS upgrade ok)
  | { t: 'head'; streamId: number; status: number; headers: Record<string, string> }
  // either direction: body bytes / WS frame payload (base64 in `chunk`). For WS
  // frames, `binary` preserves the text/binary type — the gateway chat-ws only
  // accepts text frames, so this must round-trip faithfully.
  | { t: 'data'; streamId: number; chunk: string; binary?: boolean }
  // either direction: half-close (no more body / done)
  | { t: 'end'; streamId: number }
  // either direction: abort/teardown (carries a WS/HTTP close code when relevant)
  | { t: 'close'; streamId: number; code?: number; reason?: string }
  // either direction: flow-control grant (backpressure)
  | { t: 'credit'; streamId: number; bytes: number }
  | { t: 'ping' }
  | { t: 'pong' };

const FRAME_TYPES: ReadonlySet<string> = new Set([
  'open',
  'head',
  'data',
  'end',
  'close',
  'credit',
  'ping',
  'pong',
]);

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(text: string): Frame {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid frame: not an object');
  }
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== 'string' || !FRAME_TYPES.has(t)) {
    throw new Error(`Invalid frame: unknown type ${String(t)}`);
  }
  return parsed as Frame;
}

/** Encode raw body bytes for a `data` frame's `chunk` (base64). */
export function encodeChunk(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Decode a `data` frame's `chunk` back to raw bytes. */
export function decodeChunk(chunk: string): Buffer {
  return Buffer.from(chunk, 'base64');
}
