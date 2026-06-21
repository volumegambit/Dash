/**
 * Frame codec for the single gateway↔relay multiplexing socket.
 *
 * One outbound WebSocket carries every phone stream. Each logical phone
 * connection is a `streamId`; `target` routes it to the gateway's loopback
 * management (9300) or chat (9200) server. Body bytes ride in `data` frames as
 * base64 (binary-safe over a JSON/text WebSocket). This codec is duplicated on
 * the gateway side (apps/gateway/src/mux.ts) — keep the two in lock-step.
 */
export type Target = 'mgmt' | 'chat';
export type StreamKind = 'http' | 'ws';

export type Frame =
  | {
      t: 'open';
      streamId: number;
      target: Target;
      kind: StreamKind;
      method?: string;
      path: string;
      headers: Record<string, string>;
    }
  | { t: 'data'; streamId: number; chunk: string }
  | { t: 'end'; streamId: number }
  | { t: 'close'; streamId: number; code?: number; reason?: string }
  | { t: 'credit'; streamId: number; bytes: number }
  | { t: 'ping' }
  | { t: 'pong' };

const FRAME_TYPES: ReadonlySet<string> = new Set([
  'open',
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
