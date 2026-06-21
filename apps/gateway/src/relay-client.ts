import http from 'node:http';
import { WebSocket } from 'ws';
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

/** A phone stream replayed against the gateway's loopback servers. */
interface LocalConn {
  kind: 'http' | 'ws';
  req?: http.ClientRequest;
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
      case 'data':
        streams.get(frame.streamId)?.req?.write(decodeChunk(frame.chunk));
        break;
      case 'end':
        streams.get(frame.streamId)?.req?.end();
        break;
      case 'close': {
        const conn = streams.get(frame.streamId);
        conn?.req?.destroy();
        streams.delete(frame.streamId);
        break;
      }
      default:
        break; // 'head'/'credit' from the relay are not expected on the request path
    }
  };

  const openStream = (ws: WebSocket, frame: Extract<Frame, { t: 'open' }>): void => {
    const port = frame.target === 'chat' ? opts.channelPort : opts.managementPort;
    if (frame.kind !== 'http') return; // WS upgrades handled in R5

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: frame.method ?? 'GET',
        path: frame.path,
        headers: { ...frame.headers, host: `127.0.0.1:${port}` },
      },
      (res) => {
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
    streams.set(frame.streamId, { kind: 'http', req });
  };

  const resetStreams = (): void => {
    for (const conn of streams.values()) conn.req?.destroy();
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
