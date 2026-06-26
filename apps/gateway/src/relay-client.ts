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
  /**
   * Bearer presented on dial-in so the relay admits this gateway. Used only when
   * `getRelayToken` is absent (the legacy single-token path). When both are set,
   * `getRelayToken` wins — the token is read fresh at each dial.
   */
  relayToken: string;
  /**
   * Live getter for the dial token, read at dial time so an autonomous refresh
   * (DialTokenManager) is picked up on the next connect without restarting the
   * client. Overrides `relayToken` when present.
   */
  getRelayToken?: () => string;
  /**
   * Mints a fresh `X-Gateway-Proof` holder-of-key assertion. Called on EVERY
   * `connect()` so each dial carries a short-lived, non-replayable proof.
   */
  signProof?: () => string;
  /**
   * Invoked when the relay closes the dial socket with code `4401` (bad/expired
   * token). The DialTokenManager uses this to trigger a cooldown-guarded refresh.
   */
  onAuthFailure?: () => void;
  /** Stable per-gateway id; the relay addresses streams to `/gw/<gatewayId>`. */
  gatewayId: string;
  managementPort: number;
  channelPort: number;
  logger?: RelayClientLogger;
  /** Reconnect backoff base in ms (doubles per attempt, capped). Default 1000. */
  reconnectBaseMs?: number;
  /** Reconnect backoff cap in ms. Default 30000. */
  reconnectMaxMs?: number;
  /** Heartbeat ping interval in ms; a missed pong forces a reconnect. Default 20000. */
  heartbeatMs?: number;
  /** A connection must stay up this long before the backoff resets. Default 5000. */
  reconnectResetMs?: number;
}

export interface RelayClient {
  stop(): void;
  /** Reset backoff, cancel any pending reconnect, and dial immediately. */
  redialNow(): void;
}

/** Per-stream flow-control window (bytes); the loopback source pauses past it. */
const FLOW_WINDOW = 256 * 1024;

/** A phone stream replayed against the gateway's loopback servers. */
interface LocalConn {
  kind: 'http' | 'ws';
  req?: http.ClientRequest;
  res?: http.IncomingMessage;
  ws?: WebSocket;
  /**
   * Frames that arrived while the loopback ws was still CONNECTING. The phone is
   * upgraded at the relay edge immediately, so its first messages can reach us
   * before our local ws to the gateway opens; we queue them here and flush in
   * order on `open` (raw `ws.send` throws on a non-OPEN socket).
   */
  wsPending?: Array<Buffer | string>;
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
  const reconnectBaseMs = opts.reconnectBaseMs ?? 1000;
  const reconnectMaxMs = opts.reconnectMaxMs ?? 30000;
  const heartbeatMs = opts.heartbeatMs ?? 20000;
  // Only reset the backoff once a connection has stayed up this long. A relay
  // that accepts the WS handshake then immediately closes (e.g. 4401 bad token)
  // would otherwise reset the backoff on every 'open' and get hammered ~1×/s.
  const reconnectResetMs = opts.reconnectResetMs ?? 5000;

  const streams = new Map<number, LocalConn>();
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const startHeartbeat = (ws: WebSocket): void => {
    let pongReceived = true;
    ws.on('pong', () => {
      pongReceived = true;
    });
    heartbeatTimer = setInterval(() => {
      if (!pongReceived) {
        ws.terminate(); // dead peer (no pong) → 'close' → reconnect
        return;
      }
      pongReceived = false;
      try {
        ws.ping();
      } catch {
        // socket already closing
      }
    }, heartbeatMs);
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  };

  function connect(): void {
    if (stopped) return;
    const url = `${opts.relayUrl.replace(/\/+$/, '')}/gw/${encodeURIComponent(opts.gatewayId)}`;
    const token = opts.getRelayToken ? opts.getRelayToken() : opts.relayToken;
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    // Holder-of-key proof: a fresh, short-lived assertion per dial. The relay
    // verifies it against the token's `cnf` pubkey (P3) before registering.
    if (opts.signProof) headers['x-gateway-proof'] = opts.signProof();
    const ws = new WebSocket(url, { headers });
    socket = ws;

    ws.on('open', () => {
      opts.logger?.info(`[relay] connected to ${opts.relayUrl}`);
      startHeartbeat(ws);
      // Reset backoff only after the connection has proven stable (see above).
      stableTimer = setTimeout(() => {
        reconnectAttempt = 0;
      }, reconnectResetMs);
    });
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
    ws.on('close', (code: number) => {
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = undefined;
      }
      stopHeartbeat();
      resetStreams();
      // A `4401` is the relay rejecting the dial token — let the manager refresh
      // it (reactive path) in addition to the normal backoff reconnect.
      if (code === 4401) opts.onAuthFailure?.();
      scheduleReconnect();
    });
  }

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
          const payload = frame.binary ? bytes : bytes.toString('utf8');
          // Send straight through once open; otherwise queue until `open`
          // flushes the backlog — preserves order and avoids a throw on a
          // CONNECTING socket.
          if (conn.ws?.readyState === WebSocket.OPEN) {
            conn.ws.send(payload);
          } else {
            conn.wsPending?.push(payload);
          }
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

    // Tear a stream down once, reporting it to the relay. Idempotent: the map
    // delete guards against a normal `end` having already removed it (which
    // would otherwise double-send a close).
    const failStream = (streamId: number, reason: string): void => {
      if (streams.delete(streamId)) {
        try {
          ws.send(encodeFrame({ t: 'close', streamId, reason }));
        } catch {
          // relay socket already gone
        }
      }
    };

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
        // If the loopback server resets/aborts the connection AFTER the head is
        // sent, Node emits 'error' (and/or 'aborted') on the response stream —
        // without a listener 'error' throws (unhandled 'error' on a Readable).
        // Tell the relay the stream closed and drop it so the phone never hangs.
        res.on('error', (err: Error) => failStream(frame.streamId, err.message));
        res.on('aborted', () => failStream(frame.streamId, 'aborted'));
      },
    );
    req.on('error', (err) => failStream(frame.streamId, err.message));
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
    const conn: LocalConn = { kind: 'ws', ws: local, unacked: 0, wsPending: [] };
    streams.set(frame.streamId, conn);

    local.on('open', () => {
      relaySocket.send(
        encodeFrame({ t: 'head', streamId: frame.streamId, status: 101, headers: {} }),
      );
      // Flush anything the phone sent before the loopback ws finished opening,
      // in arrival order, then send directly from here on.
      for (const m of conn.wsPending ?? []) local.send(m);
      conn.wsPending = undefined;
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
    redialNow(): void {
      if (stopped) return;
      // Cancel a pending backoff reconnect and reset the counter so the new
      // token is tried immediately rather than after the current delay.
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      // Clear the stable-timer too (consistent with stop()); the previous
      // connection's timer would otherwise survive the terminate+reconnect.
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = undefined;
      }
      reconnectAttempt = 0;
      // Drop the live socket (if any) so its 'close' doesn't double-dial; the
      // explicit connect below opens the fresh tunnel.
      if (socket) {
        socket.removeAllListeners('close');
        socket.terminate();
        socket = null;
      }
      stopHeartbeat();
      resetStreams();
      connect();
    },
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (stableTimer) clearTimeout(stableTimer);
      stopHeartbeat();
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
