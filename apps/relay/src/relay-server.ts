import http from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { type RelayDeps, safeEqual } from './auth.js';
import type { PairingCredentialStore } from './credential-store.js';
import {
  type Frame,
  type Target,
  decodeChunk,
  decodeFrame,
  encodeChunk,
  encodeFrame,
} from './mux.js';
import { RateLimiter } from './rate-limit.js';

export type { RelayDeps };

export interface RelayServer {
  httpServer: http.Server;
  hasGateway(gatewayId: string): boolean;
  close(): Promise<void>;
}

/** Abuse limits for the public phone-facing edge. Sensible defaults below. */
export interface RelayLimits {
  /** Max concurrent phone streams per gateway. Default 256. */
  maxStreamsPerGateway?: number;
  /** Sustained phone requests/sec per gateway (token refill). Default 50. */
  ratePerSec?: number;
  /** Burst capacity per gateway (token bucket size). Default 100. */
  rateBurst?: number;
}

/** Admin API config for the pairing-credential lifecycle (Bearer-gated). */
export interface RelayAdminConfig {
  /** Master secret a caller (Mission Control) presents to the /admin routes. */
  secret: string;
  /** Backing store the admin routes provision/revoke against. */
  store: PairingCredentialStore;
}

export interface RelayServerOptions extends RelayLimits {
  /**
   * When set, the relay exposes a Bearer-gated admin API on the same listener:
   *   POST /admin/pairings          { tenantId, gatewayId }            → { credential }
   *   POST /admin/pairings/revoke   { tenantId, gatewayId, credential? } → { ok: true }
   *   POST /admin/gateways/revoke   { tenantId, gatewayId }            → { ok: true }
   * Mission Control calls these to provision/revoke per-device pairings and to
   * force-close a revoked gateway's live tunnel.
   */
  admin?: RelayAdminConfig;
}

/** WebSocket close code for a gateway that presents a bad relay token. */
const RELAY_AUTH_CLOSE = 4401;
/** WebSocket close code for a phone throttled by the rate limiter / stream cap. */
const RELAY_RATE_LIMIT_CLOSE = 4429;
/** Header carrying the phone's per-pairing relay credential (set by the app). */
const PAIRING_CREDENTIAL_HEADER = 'x-dash-relay-credential';

/** A phone-originated stream's callbacks, driven by frames from the gateway. */
interface PhoneStream {
  onHead(status: number, headers: Record<string, string>): void;
  onData(chunk: Buffer, binary: boolean): void;
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
export function createRelayServer(deps: RelayDeps, options: RelayServerOptions = {}): RelayServer {
  const gateways = new Map<string, GatewayConn>();
  const wss = new WebSocketServer({ noServer: true });

  const maxStreams = options.maxStreamsPerGateway ?? 256;
  const limiter = new RateLimiter(options.rateBurst ?? 100, options.ratePerSec ?? 50);
  const admin = options.admin;

  const httpServer = http.createServer((req, res) => {
    // The admin API shares the listener but is matched by path before any
    // Host-based gateway routing, and is gated by the admin Bearer secret.
    if ((req.url ?? '/').split('?')[0].startsWith('/admin/')) {
      handleAdmin(admin, gateways, req, res);
      return;
    }
    handlePhoneHttp(gateways, deps, limiter, maxStreams, req, res);
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0];
    const gwMatch = path.match(/^\/gw\/([^/]+)$/);
    if (!gwMatch) {
      handlePhoneWsUpgrade(gateways, deps, wss, limiter, maxStreams, req, socket, head);
      return;
    }
    const gatewayId = decodeURIComponent(gwMatch[1]);
    const token = bearer(req.headers.authorization);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!token || !deps.relayTokenValid(gatewayId, token)) {
        ws.close(RELAY_AUTH_CLOSE, 'Unauthorized');
        return;
      }
      registerGateway(gateways, limiter, gatewayId, ws);
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
  limiter: RateLimiter,
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
    if (gateways.get(gatewayId) === conn) {
      gateways.delete(gatewayId);
      limiter.forget(gatewayId); // release the rate-limit bucket for this gateway
    }
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
  // A misbehaving (buggy or hostile) gateway must never crash the relay. The
  // stream callbacks touch Node res/ws which throw on misuse (a duplicate
  // `head`, a write after end); the callbacks guard themselves, but this catch
  // is the backstop — on any throw, tear down just this one stream.
  try {
    switch (frame.t) {
      case 'head':
        stream.onHead(frame.status, frame.headers);
        break;
      case 'data':
        stream.onData(decodeChunk(frame.chunk), frame.binary ?? false);
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
  } catch {
    conn.streams.delete(frame.streamId);
    try {
      stream.onClose();
    } catch {
      // already torn down
    }
  }
}

function handlePhoneHttp(
  gateways: Map<string, GatewayConn>,
  deps: RelayDeps,
  limiter: RateLimiter,
  maxStreams: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const gatewayId = gatewayIdFromHost(req.headers.host);
  const conn = gatewayId ? gateways.get(gatewayId) : undefined;
  if (!gatewayId || !conn) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('No gateway connected');
    return;
  }

  // Per-pairing relay credential. The relay never inspects gateway tokens; this
  // is a separate gate authorizing the phone to reach THIS gateway at all.
  // Checked BEFORE the rate limiter so an unauthenticated caller can't spend a
  // gateway's shared token budget and throttle its legitimately paired phones.
  if (
    !deps.pairingCredentialValid(gatewayId, headerValue(req.headers[PAIRING_CREDENTIAL_HEADER]))
  ) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }

  // Abuse limits on the public edge: a per-gateway token bucket caps sustained
  // request rate, and a concurrent-stream cap bounds in-flight work. Both reject
  // with 429 so a flood can't exhaust the gateway's loopback or the relay.
  if (!limiter.allow(gatewayId) || conn.streams.size >= maxStreams) {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '1' });
    res.end('Too Many Requests');
    return;
  }

  const streamId = conn.nextStreamId++;
  let responded = false;
  // Bytes written to the phone but not yet credited back to the gateway.
  let pendingCredit = 0;

  const grantCredit = (): void => {
    if (pendingCredit > 0) {
      conn.socket.send(encodeFrame({ t: 'credit', streamId, bytes: pendingCredit }));
      pendingCredit = 0;
    }
  };

  conn.streams.set(streamId, {
    onHead(status, headers) {
      // Guard against a duplicate/late `head` frame: writeHead after headers are
      // already sent throws ERR_HTTP_HEADERS_SENT (which would otherwise crash
      // the relay — see routeFromGateway's catch).
      if (res.headersSent) return;
      responded = true;
      res.writeHead(status, headers);
    },
    onData(chunk) {
      if (res.writableEnded) return;
      const flushed = res.write(chunk);
      pendingCredit += chunk.length;
      // Credit immediately if the phone socket accepted it; otherwise wait for
      // `drain` so a slow phone throttles the upstream via withheld credit.
      if (flushed) grantCredit();
    },
    onEnd() {
      if (!res.writableEnded) res.end();
      conn.streams.delete(streamId);
    },
    onClose(_code, reason) {
      if (!res.writableEnded) {
        if (!responded) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(responded ? undefined : (reason ?? 'Upstream closed'));
      }
      conn.streams.delete(streamId);
    },
  });

  res.on('drain', grantCredit);

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

/** Bridge a phone WebSocket (/ws/chat → chat:9200, /projects/ws → mgmt:9300). */
function handlePhoneWsUpgrade(
  gateways: Map<string, GatewayConn>,
  deps: RelayDeps,
  wss: WebSocketServer,
  limiter: RateLimiter,
  maxStreams: number,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const gatewayId = gatewayIdFromHost(req.headers.host);
  const conn = gatewayId ? gateways.get(gatewayId) : undefined;
  if (!gatewayId || !conn) {
    socket.destroy();
    return;
  }

  // Per-pairing relay credential (see handlePhoneHttp). Checked before the rate
  // limiter so an unauthenticated caller can't spend the gateway's token budget.
  // Reject with 4401.
  if (
    !deps.pairingCredentialValid(gatewayId, headerValue(req.headers[PAIRING_CREDENTIAL_HEADER]))
  ) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(RELAY_AUTH_CLOSE, 'Unauthorized');
    });
    return;
  }

  // Same abuse limits as the HTTP edge; a throttled phone is upgraded then
  // immediately closed with 4429 so the client gets a distinguishable signal.
  if (!limiter.allow(gatewayId) || conn.streams.size >= maxStreams) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(RELAY_RATE_LIMIT_CLOSE, 'Too Many Requests');
    });
    return;
  }

  const fullPath = req.url ?? '/';
  const target: Target = fullPath.split('?')[0].startsWith('/ws/chat') ? 'chat' : 'mgmt';

  wss.handleUpgrade(req, socket, head, (phoneWs) => {
    const streamId = conn.nextStreamId++;
    conn.streams.set(streamId, {
      onHead() {
        // 101 — the phone connection is already upgraded at the relay edge.
      },
      onData(chunk, binary) {
        if (phoneWs.readyState === phoneWs.OPEN) {
          phoneWs.send(binary ? chunk : chunk.toString('utf8'));
        }
      },
      onEnd() {
        conn.streams.delete(streamId);
        phoneWs.close();
      },
      onClose(code, reason) {
        conn.streams.delete(streamId);
        phoneWs.close(safeCloseCode(code), truncateCloseReason(reason));
      },
    });

    conn.socket.send(
      encodeFrame({
        t: 'open',
        streamId,
        target,
        kind: 'ws',
        path: fullPath,
        headers: forwardableHeaders(req.headers),
      }),
    );

    phoneWs.on('message', (data: RawData, isBinary: boolean) => {
      conn.socket.send(
        encodeFrame({ t: 'data', streamId, chunk: encodeChunk(toBuffer(data)), binary: isBinary }),
      );
    });
    phoneWs.on('close', () => {
      if (conn.streams.delete(streamId)) {
        conn.socket.send(encodeFrame({ t: 'close', streamId }));
      }
    });
  });
}

/**
 * The WebSocket close `reason` must be ≤123 UTF-8 bytes or `ws` throws a
 * synchronous RangeError. Truncate on a byte boundary (dropping any partial
 * trailing multibyte char) so a long upstream reason can't crash the relay.
 */
function truncateCloseReason(reason?: string): string | undefined {
  if (reason === undefined) return undefined;
  const buf = Buffer.from(reason, 'utf8');
  if (buf.length <= 123) return reason;
  return buf.subarray(0, 123).toString('utf8').replace(/�+$/, '');
}

/** Forward normal + app-range (4001 etc.) close codes; coerce reserved/abnormal to 1000. */
function safeCloseCode(code?: number): number {
  if (code === 1000) return 1000;
  if (code !== undefined && code >= 3000 && code <= 4999) return code;
  return 1000;
}

/** Normalize a ws message payload (Buffer | Buffer[] | ArrayBuffer) to a Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/**
 * Bearer-gated admin API for the pairing-credential lifecycle. Matched by the
 * `/admin/` path prefix (ahead of gateway routing), so Host is irrelevant — a
 * caller reaches it at any subdomain that resolves to the relay.
 */
function handleAdmin(
  admin: RelayAdminConfig | undefined,
  gateways: Map<string, GatewayConn>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  if (!admin) {
    respondJson(res, 404, { error: 'Admin API not enabled' });
    return;
  }
  const token = bearer(req.headers.authorization);
  if (!token || !safeEqual(token, admin.secret)) {
    respondJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  if (req.method !== 'POST') {
    respondJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }
  const path = (req.url ?? '/').split('?')[0];
  readJsonBody(req)
    .then((body) => {
      // Every admin mutation is tenant-scoped: the caller must name the tenant
      // the gateway belongs to, so the store can key pairings by (tenant, gateway).
      const tenantId = stringField(body, 'tenantId');
      const gatewayId = stringField(body, 'gatewayId');
      if (path === '/admin/pairings') {
        if (!tenantId || !gatewayId) {
          return respondJson(res, 400, { error: 'tenantId and gatewayId required' });
        }
        const credential = admin.store.provision(tenantId, gatewayId);
        return respondJson(res, 200, { gatewayId, credential });
      }
      if (path === '/admin/pairings/revoke') {
        if (!tenantId || !gatewayId) {
          return respondJson(res, 400, { error: 'tenantId and gatewayId required' });
        }
        const credential = stringField(body, 'credential');
        if (credential) admin.store.revoke(tenantId, gatewayId, credential);
        else admin.store.revokeAll(tenantId, gatewayId);
        return respondJson(res, 200, { ok: true });
      }
      if (path === '/admin/gateways/revoke') {
        if (!tenantId || !gatewayId) {
          return respondJson(res, 400, { error: 'tenantId and gatewayId required' });
        }
        // Force-close the live tunnel so a revoked gateway drops immediately. The
        // close fires registerGateway's `socket.on('close')`, which deletes the
        // gateway and tears down its streams — force-close is atomic with deregister.
        gateways.get(gatewayId)?.socket.close(RELAY_AUTH_CLOSE, 'Revoked');
        return respondJson(res, 200, { ok: true });
      }
      respondJson(res, 404, { error: 'Unknown admin route' });
    })
    .catch(() => respondJson(res, 400, { error: 'Invalid JSON body' }));
}

/** Read a request body as JSON ({} when empty); caps size to 64 KiB. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        // Reject explicitly before destroying — otherwise the promise would
        // never settle (no 'end'), leaking the handler. The caller maps the
        // rejection to a 400.
        reject(new Error('admin request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Extract a non-empty string field from a parsed JSON object. */
function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : undefined;
}

/** Normalize a possibly-array request header to a single string ('' if absent). */
function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
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
