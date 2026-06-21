import http from 'node:http';
import { type RawData, WebSocket } from 'ws';
import { type Frame, decodeChunk, decodeFrame, encodeChunk, encodeFrame } from './mux.js';

export interface RelayClientLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RelayClientOptions {
  /** Relay base URL, e.g. `wss://relay.example.com` (no `/gw` path). */
  relayUrl: string;
  /** Bearer presented on dial-in so the relay admits this gateway. */
  relayToken: string;
  /** Stable per-gateway id; the relay addresses streams to `/gw/<gatewayId>`. */
  gatewayId: string;
  managementPort: number;
  channelPort: number;
  logger?: RelayClientLogger;
}

export interface RelayClient {
  stop(): void;
}

/** Per-stream flow-control window (bytes); the loopback source pauses past it. */
const FLOW_WINDOW = 256 * 1024;

/** A phone stream replayed against the gateway's loopback servers. */
interface LocalConn {
  kind: 'http' | 'ws';
  req?: http.ClientRequest;
  res?: http.IncomingMessage;
  ws?: WebSocket;
  /** Bytes sent to the relay but not yet credited back (HTTP/SSE flow control). */
  unacked: number;
}

/**
 * Dials one outbound WebSocket to the relay and replays the phone traffic it
 * frames against the gateway's own `127.0.0.1` servers. The gateway is "just
 * another localhost client": the two HTTP servers and their auth middleware are
 * untouched. Returns a handle whose `stop()` tears the tunnel down.
 *
 * R3 implements HTTP replay; SSE (R4), WebSocket (R5), backpressure (R6), and
 * reconnect (R7) extend this file.
 */
export function startRelayClient(opts: RelayClientOptions): RelayClient {
  const streams = new Map<number, LocalConn>();
  let socket: WebSocket | null = null;
  let stopped = false;

  const connect = (): void => {
    if (stopped) return;
    const url = `${opts.relayUrl.replace(/\/+$/, '')}/gw/${encodeURIComponent(opts.gatewayId)}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${opts.relayToken}` } });
    socket = ws;

    ws.on('open', () => opts.logger?.info(`[relay] connected to ${opts.relayUrl}`));
    ws.on('message', (raw: Buffer) => {
      let frame: Frame;
      try {
        frame = decodeFrame(raw.toString());
      } catch {
        return;
      }
      handleFrame(ws, frame);
    });
    ws.on('error', (err) => opts.logger?.warn(`[relay] socket error: ${err.message}`));
    ws.on('close', () => {
      // Reconnect logic lands in R7; for now the tunnel simply ends.
      resetStreams();
    });
  };

  const handleFrame = (ws: WebSocket, frame: Frame): void => {
    if (frame.t === 'ping') {
      ws.send(encodeFrame({ t: 'pong' }));
      return;
    }
    if (frame.t === 'pong' || !('streamId' in frame)) return;

    switch (frame.t) {
      case 'open':
        openStream(ws, frame);
        break;
      case 'data': {
        const conn = streams.get(frame.streamId);
        if (!conn) break;
        if (conn.kind === 'ws') {
          const bytes = decodeChunk(frame.chunk);
          conn.ws?.send(frame.binary ? bytes : bytes.toString('utf8'));
        } else {
          conn.req?.write(decodeChunk(frame.chunk));
        }
        break;
      }
      case 'end':
        streams.get(frame.streamId)?.req?.end();
        break;
      case 'close': {
        const conn = streams.get(frame.streamId);
        conn?.req?.destroy();
        conn?.ws?.close();
        streams.delete(frame.streamId);
        break;
      }
      case 'credit': {
        // The relay acknowledges bytes the phone has drained; release the
        // loopback source if it was paused past the flow-control window.
        const conn = streams.get(frame.streamId);
        if (conn) {
          conn.unacked = Math.max(0, conn.unacked - frame.bytes);
          if (conn.res?.isPaused() && conn.unacked < FLOW_WINDOW) conn.res.resume();
        }
        break;
      }
      default:
        break; // 'head' from the relay is not expected on the request path
    }
  };

  const openStream = (ws: WebSocket, frame: Extract<Frame, { t: 'open' }>): void => {
    const port = frame.target === 'chat' ? opts.channelPort : opts.managementPort;
    if (frame.kind === 'ws') {
      openLoopbackWs(ws, frame, port);
      return;
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: frame.method ?? 'GET',
        path: frame.path,
        headers: { ...frame.headers, host: `127.0.0.1:${port}` },
      },
      (res) => {
        const conn = streams.get(frame.streamId);
        if (conn) conn.res = res;
        ws.send(
          encodeFrame({
            t: 'head',
            streamId: frame.streamId,
            status: res.statusCode ?? 502,
            headers: flattenHeaders(res.headers),
          }),
        );
        res.on('data', (chunk: Buffer) => {
          ws.send(encodeFrame({ t: 'data', streamId: frame.streamId, chunk: encodeChunk(chunk) }));
          if (conn) {
            conn.unacked += chunk.length;
            // Pause the source when the relay is behind; resumed on a credit frame.
            if (conn.unacked >= FLOW_WINDOW) res.pause();
          }
        });
        res.on('end', () => {
          ws.send(encodeFrame({ t: 'end', streamId: frame.streamId }));
          streams.delete(frame.streamId);
        });
      },
    );
    req.on('error', (err) => {
      ws.send(encodeFrame({ t: 'close', streamId: frame.streamId, reason: err.message }));
      streams.delete(frame.streamId);
    });
    streams.set(frame.streamId, { kind: 'http', req, unacked: 0 });
  };

  /** Bridge a phone WebSocket onto a loopback ws client (/ws/chat, /projects/ws). */
  const openLoopbackWs = (
    relaySocket: WebSocket,
    frame: Extract<Frame, { t: 'open' }>,
    port: number,
  ): void => {
    // frame.path includes the `?token=` query the gateway's auth checks.
    const local = new WebSocket(`ws://127.0.0.1:${port}${frame.path}`);
    streams.set(frame.streamId, { kind: 'ws', ws: local, unacked: 0 });

    local.on('open', () => {
      relaySocket.send(
        encodeFrame({ t: 'head', streamId: frame.streamId, status: 101, headers: {} }),
      );
    });
    local.on('message', (data: RawData, isBinary: boolean) => {
      relaySocket.send(
        encodeFrame({
          t: 'data',
          streamId: frame.streamId,
          chunk: encodeChunk(toBuffer(data)),
          binary: isBinary,
        }),
      );
    });
    local.on('close', (code: number, reason: Buffer) => {
      relaySocket.send(
        encodeFrame({ t: 'close', streamId: frame.streamId, code, reason: reason.toString() }),
      );
      streams.delete(frame.streamId);
    });
    local.on('error', () => {
      relaySocket.send(encodeFrame({ t: 'close', streamId: frame.streamId }));
      streams.delete(frame.streamId);
    });
  };

  const resetStreams = (): void => {
    for (const conn of streams.values()) {
      conn.req?.destroy();
      conn.ws?.close();
    }
    streams.clear();
  };

  connect();

  return {
    stop(): void {
      stopped = true;
      resetStreams();
      socket?.close();
    },
  };
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** Normalize a ws message payload (Buffer | Buffer[] | ArrayBuffer) to a Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
