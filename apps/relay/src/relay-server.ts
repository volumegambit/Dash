import http from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import type { RelayDeps } from './auth.js';
import { type Frame, decodeChunk, decodeFrame, encodeChunk, encodeFrame } from './mux.js';

export type { RelayDeps };

export interface RelayServer {
  httpServer: http.Server;
  hasGateway(gatewayId: string): boolean;
  close(): Promise<void>;
}

/** WebSocket close code for a gateway that presents a bad relay token. */
const RELAY_AUTH_CLOSE = 4401;

/** A phone-originated stream's callbacks, driven by frames from the gateway. */
interface PhoneStream {
  onHead(status: number, headers: Record<string, string>): void;
  onData(chunk: Buffer): void;
  onEnd(): void;
  onClose(code?: number, reason?: string): void;
}

interface GatewayConn {
  socket: WebSocket;
  streams: Map<number, PhoneStream>;
  nextStreamId: number;
}

/**
 * The relay rendezvous: gateways dial in at `ws://…/gw/:gatewayId` (Bearer relay
 * token); phones hit `http(s)://<gatewayId>.<host>/…`. Each phone request becomes
 * one `streamId` framed onto the owning gateway's single socket and replayed
 * against its loopback servers. The relay pipes opaque bytes — it never inspects
 * or persists app payloads.
 */
export function createRelayServer(deps: RelayDeps): RelayServer {
  const gateways = new Map<string, GatewayConn>();
  const wss = new WebSocketServer({ noServer: true });

  const httpServer = http.createServer((req, res) => {
    handlePhoneHttp(gateways, req, res);
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0];
    const gwMatch = path.match(/^\/gw\/([^/]+)$/);
    if (!gwMatch) {
      // Phone-facing WebSocket (/ws/chat, /projects/ws) lands in R5.
      socket.destroy();
      return;
    }
    const gatewayId = decodeURIComponent(gwMatch[1]);
    const token = bearer(req.headers.authorization);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!token || !deps.relayTokenValid(token)) {
        ws.close(RELAY_AUTH_CLOSE, 'Unauthorized');
        return;
      }
      registerGateway(gateways, gatewayId, ws);
    });
  });

  return {
    httpServer,
    hasGateway: (id) => gateways.has(id),
    close: () =>
      new Promise<void>((resolve) => {
        for (const gw of gateways.values()) gw.socket.close();
        gateways.clear();
        wss.close();
        httpServer.close(() => resolve());
      }),
  };
}

function registerGateway(
  gateways: Map<string, GatewayConn>,
  gatewayId: string,
  socket: WebSocket,
): void {
  // One gateway per id — a re-dial replaces the previous connection.
  gateways.get(gatewayId)?.socket.close();

  const conn: GatewayConn = { socket, streams: new Map(), nextStreamId: 1 };
  gateways.set(gatewayId, conn);

  socket.on('message', (raw: Buffer) => {
    let frame: Frame;
    try {
      frame = decodeFrame(raw.toString());
    } catch {
      return; // ignore unparseable frames
    }
    routeFromGateway(conn, frame);
  });

  socket.on('close', () => {
    if (gateways.get(gatewayId) === conn) gateways.delete(gatewayId);
    for (const stream of conn.streams.values()) stream.onClose();
    conn.streams.clear();
  });
}

/** Route a gateway→relay frame to its phone stream (or answer heartbeats). */
function routeFromGateway(conn: GatewayConn, frame: Frame): void {
  if (frame.t === 'ping') {
    conn.socket.send(encodeFrame({ t: 'pong' }));
    return;
  }
  if (frame.t === 'pong' || !('streamId' in frame)) return;
  const stream = conn.streams.get(frame.streamId);
  if (!stream) return;
  switch (frame.t) {
    case 'head':
      stream.onHead(frame.status, frame.headers);
      break;
    case 'data':
      stream.onData(decodeChunk(frame.chunk));
      break;
    case 'end':
      stream.onEnd();
      break;
    case 'close':
      stream.onClose(frame.code, frame.reason);
      conn.streams.delete(frame.streamId);
      break;
    default:
      break; // 'open'/'credit' from gateway are not expected on the response path
  }
}

function handlePhoneHttp(
  gateways: Map<string, GatewayConn>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const gatewayId = gatewayIdFromHost(req.headers.host);
  const conn = gatewayId ? gateways.get(gatewayId) : undefined;
  if (!conn) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('No gateway connected');
    return;
  }

  const streamId = conn.nextStreamId++;
  let responded = false;

  conn.streams.set(streamId, {
    onHead(status, headers) {
      responded = true;
      res.writeHead(status, headers);
    },
    onData(chunk) {
      res.write(chunk);
    },
    onEnd() {
      res.end();
      conn.streams.delete(streamId);
    },
    onClose(_code, reason) {
      if (!responded) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(reason ?? 'Upstream closed');
      } else {
        res.end();
      }
      conn.streams.delete(streamId);
    },
  });

  // If the phone disconnects mid-stream (e.g. drops a long-lived SSE/chat
  // connection), tear down the upstream loopback request via the gateway.
  // `delete` returns false once the stream completed normally, so a normal
  // res `close` does not double-send.
  res.on('close', () => {
    if (conn.streams.delete(streamId)) {
      conn.socket.send(encodeFrame({ t: 'close', streamId }));
    }
  });

  // All plain HTTP (REST + SSE /events) targets the management server (9300).
  conn.socket.send(
    encodeFrame({
      t: 'open',
      streamId,
      target: 'mgmt',
      kind: 'http',
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: forwardableHeaders(req.headers),
    }),
  );

  req.on('data', (chunk: Buffer) => {
    conn.socket.send(encodeFrame({ t: 'data', streamId, chunk: encodeChunk(chunk) }));
  });
  req.on('end', () => {
    conn.socket.send(encodeFrame({ t: 'end', streamId }));
  });
  req.on('error', () => {
    conn.socket.send(encodeFrame({ t: 'close', streamId }));
    conn.streams.delete(streamId);
  });
}

function bearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : undefined;
}

/** `<gatewayId>.relay.zone[:port]` → `gatewayId`. */
function gatewayIdFromHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const label = host.split(':')[0].split('.')[0];
  return label || undefined;
}

/** Forward phone request headers verbatim, minus hop-by-hop / routing headers. */
function forwardableHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (k === 'host' || k === 'connection' || k === 'keep-alive') continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
