import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { type Server, type Socket, createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { LoadConfigOptions } from '../config.js';
import { type RunningGateway, startGateway } from './bootstrap.js';
import * as listeners from './listener.js';

const resourceDir = fileURLToPath(new URL('../', import.meta.url));

async function httpRequest(port: number, path: string, token?: string, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function tlsRequest(port: number, path: string, certificate: string, token?: string) {
  return new Promise<{ status: number; body: unknown; certificateSha256: string }>(
    (resolve, reject) => {
      const request = httpsRequest(
        `https://127.0.0.1:${port}${path}`,
        {
          ca: certificate,
          agent: false,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        },
        (response) => {
          const peer = (response.socket as TLSSocket).getPeerCertificate();
          const certificateSha256 = createHash('sha256').update(peer.raw).digest('hex');
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () => {
            const text = Buffer.concat(chunks).toString();
            resolve({
              status: response.statusCode ?? 0,
              body: response.headers['content-type']?.includes('application/json')
                ? JSON.parse(text)
                : text,
              certificateSha256,
            });
          });
        },
      );
      request.once('error', reject);
      request.end();
    },
  );
}

describe('production gateway bootstrap', () => {
  let tempDir: string;
  let dataDir: string;
  let token: string;
  let chatToken: string;
  let running: RunningGateway | undefined;
  let ownedListeners: listeners.OwnedGatewayListener[];
  let webSockets: WebSocket[];
  let sockets: Socket[];
  let testServers: Server[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dash-bootstrap-'));
    dataDir = join(tempDir, 'gateway');
    token = `admin-${randomUUID()}`;
    chatToken = `chat-${randomUUID()}`;
    running = undefined;
    ownedListeners = [];
    webSockets = [];
    sockets = [];
    testServers = [];
    vi.stubEnv('DASH_HOME', tempDir);
    // Observe the real listeners so a failed assertion cannot leave one behind.
    // Binding, TLS, WebSocket injection and shutdown all remain production code.
    const listen = listeners.listenGatewaySurface;
    vi.spyOn(listeners, 'listenGatewaySurface').mockImplementation(async (...args) => {
      const listener = await listen(...args);
      ownedListeners.push(listener);
      return listener;
    });
  });

  afterEach(async () => {
    for (const socket of webSockets) socket.terminate();
    for (const socket of sockets) socket.destroy();
    await running?.stop();
    await Promise.all(ownedListeners.map((listener) => listener.close()));
    await Promise.all(
      testServers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            if (!server.listening) return resolve();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function start(overrides: Partial<LoadConfigOptions> = {}) {
    running = await startGateway(
      { dataDir, managementPort: 0, channelPort: 0, lanPort: 0, token, chatToken, ...overrides },
      { resourceDir },
    );
    return running;
  }

  function createWebSocket(url: string, options?: WebSocket.ClientOptions) {
    const socket = new WebSocket(url, options);
    webSockets.push(socket);
    return socket;
  }

  async function openWebSocket(url: string, options?: WebSocket.ClientOptions) {
    const socket = createWebSocket(url, options);
    await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
    return socket;
  }

  async function expectChatAccepted(socket: WebSocket) {
    // A protocol error proves the authenticated handler is active without
    // starting an agent or calling a model. Upgrade alone also happens on 4001.
    const response = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
    socket.send('{');
    const [frame] = await response;
    expect(JSON.parse(String(frame))).toEqual({ type: 'error', id: '', error: 'Invalid JSON' });
  }

  async function listenOnPort(port = 0, host = '127.0.0.1') {
    const server = createServer();
    testServers.push(server);
    server.listen(port, host);
    await once(server, 'listening', { signal: AbortSignal.timeout(3000) });
    return server;
  }

  it('starts the real source bundle with separate administrative and TLS mobile access', async () => {
    const gateway = await start();
    expect(gateway.managementPort).toBeGreaterThan(0);
    expect(gateway.channelPort).toBeGreaterThan(0);
    expect(gateway.lanPort).toBeGreaterThan(0);
    expect(new Set([gateway.managementPort, gateway.channelPort, gateway.lanPort]).size).toBe(3);

    expect(await httpRequest(gateway.managementPort, '/health')).toMatchObject({
      status: 200,
      body: { status: 'healthy', pid: process.pid, agents: 0, channels: 0, apiVersion: 1 },
    });
    expect(await httpRequest(gateway.managementPort, '/agents', token)).toEqual({
      status: 200,
      body: [],
    });
    expect(await httpRequest(gateway.managementPort, '/runtime/status', token)).toMatchObject({
      status: 200,
      body: {
        execution: {
          accepting: true,
          activeCanonicalTurns: 0,
          activeLegacyTurns: 0,
          quiescingAgents: 0,
        },
        pool: { size: 0, pinned: 0, agents: {} },
        channels: [],
        relay: { connection: 'disabled', activeStreams: 0 },
      },
    });
    for (const bearer of [undefined, chatToken]) {
      expect(await httpRequest(gateway.managementPort, '/agents', bearer)).toMatchObject({
        status: 401,
        body: { code: 'unauthorized' },
      });
    }
    expect(await httpRequest(gateway.managementPort, '/mobile/v1/agents', token)).toMatchObject({
      status: 401,
    });
    expect(await httpRequest(gateway.managementPort, '/mobile/v1/agents', chatToken)).toEqual({
      status: 200,
      body: [],
    });

    const { certificate } = JSON.parse(
      await readFile(join(dataDir, 'lan-tls-identity.json'), 'utf8'),
    ) as { certificate: string };
    const lanPort = gateway.lanPort as number;
    const mobileIdentity = await tlsRequest(lanPort, '/mobile/v1/identity', certificate, chatToken);
    expect(mobileIdentity.status).toBe(200);
    expect(mobileIdentity.body).toEqual(
      (await httpRequest(gateway.managementPort, '/identity', token)).body,
    );
    expect(await httpRequest(gateway.managementPort, '/lan-tls', token)).toEqual({
      status: 200,
      body: { certificateSha256: mobileIdentity.certificateSha256 },
    });
    for (const bearer of [undefined, token]) {
      expect(await tlsRequest(lanPort, '/mobile/v1/agents', certificate, bearer)).toMatchObject({
        status: 401,
      });
    }
    expect(await tlsRequest(lanPort, '/agents', certificate, token)).toMatchObject({ status: 404 });
    expect(await tlsRequest(lanPort, '/runtime/status', certificate, token)).toMatchObject({
      status: 404,
    });
  });

  it('authenticates production chat sockets and redeems HTTP tickets across both listeners', async () => {
    const gateway = await start();
    const chatUrl = `ws://127.0.0.1:${gateway.channelPort}/ws/chat`;
    const lanUrl = `wss://127.0.0.1:${gateway.lanPort}/ws/chat`;
    const { certificate } = JSON.parse(
      await readFile(join(dataDir, 'lan-tls-identity.json'), 'utf8'),
    ) as { certificate: string };

    const native = await openWebSocket(chatUrl, {
      headers: { Authorization: `Bearer ${chatToken}` },
    });
    await expectChatAccepted(native);
    for (const url of [chatUrl, lanUrl]) {
      const rejected = createWebSocket(url, {
        ca: certificate,
        headers: { Authorization: `Bearer ${token}` },
      });
      const [code] = await once(rejected, 'close', { signal: AbortSignal.timeout(3000) });
      expect(code).toBe(4001);

      const minted = await httpRequest(
        gateway.managementPort,
        '/mobile/v1/ws-ticket',
        chatToken,
        'POST',
      );
      expect(minted.status).toBe(200);
      const ticket = (minted.body as { ticket: string }).ticket;
      const browser = await openWebSocket(`${url}?ticket=${ticket}`, { ca: certificate });
      await expectChatAccepted(browser);

      const otherUrl = url === chatUrl ? lanUrl : chatUrl;
      const reused = createWebSocket(`${otherUrl}?ticket=${ticket}`, { ca: certificate });
      const [reuseCode] = await once(reused, 'close', { signal: AbortSignal.timeout(3000) });
      expect(reuseCode).toBe(4001);
    }
  });

  it.each(['none', 'administrative', 'mobile'] as const)(
    'keeps startup loopback-only with %s credentials',
    async (credentials) => {
      const gateway = await start({
        token: credentials === 'administrative' ? token : undefined,
        chatToken: credentials === 'mobile' ? chatToken : undefined,
      });
      expect(gateway.lanPort).toBeUndefined();
      expect(gateway.application.lan).toBeUndefined();
      expect(ownedListeners).toHaveLength(2);
      for (const { server } of ownedListeners) {
        expect(server.address()).toMatchObject({ address: '127.0.0.1' });
      }
      expect(await httpRequest(gateway.managementPort, '/health')).toMatchObject({ status: 200 });
      expect(await readdir(dataDir)).not.toContain('lan-tls-identity.json');
    },
  );

  it('idempotently stops open WebSockets and TCP connections and releases every port', async () => {
    const gateway = await start();
    const addresses = ownedListeners.map(({ server }) => server.address() as { port: number });
    const { certificate } = JSON.parse(
      await readFile(join(dataDir, 'lan-tls-identity.json'), 'utf8'),
    ) as { certificate: string };
    const projects = await openWebSocket(
      `ws://127.0.0.1:${gateway.managementPort}/projects/ws?token=${token}`,
    );
    const chat = await openWebSocket(
      `ws://127.0.0.1:${gateway.channelPort}/ws/chat?token=${chatToken}`,
    );
    const lan = await openWebSocket(
      `wss://127.0.0.1:${gateway.lanPort}/ws/chat?token=${chatToken}`,
      { ca: certificate },
    );
    await expectChatAccepted(chat);
    await expectChatAccepted(lan);
    for (const { port } of addresses) {
      const socket = createConnection({ host: '127.0.0.1', port });
      sockets.push(socket);
      await once(socket, 'connect', { signal: AbortSignal.timeout(3000) });
    }
    const tcpClosed = sockets.map(
      (socket) =>
        new Promise<void>((resolve, reject) => {
          // An idle TCP peer on the TLS port has not sent a ClientHello yet;
          // destroying that server connection may reset it instead of a FIN.
          socket.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'ECONNRESET') reject(error);
          });
          socket.once('close', () => resolve());
        }),
    );
    const wsClosed = [projects, chat, lan].map((socket) =>
      once(socket, 'close', { signal: AbortSignal.timeout(3000) }),
    );

    await Promise.all([gateway.stop(), gateway.stop()]);
    await Promise.all([...tcpClosed, ...wsClosed]);
    await gateway.stop();
    for (const { server } of ownedListeners) expect(server.listening).toBe(false);
    for (const { port } of addresses) await listenOnPort(port);
    expect([projects, chat, lan].map((socket) => socket.readyState)).toEqual([
      WebSocket.CLOSED,
      WebSocket.CLOSED,
      WebSocket.CLOSED,
    ]);
  });

  it('closes the management listener when the subsequent chat bind fails', async () => {
    const occupied = await listenOnPort();
    const channelPort = (occupied.address() as { port: number }).port;
    await expect(start({ channelPort })).rejects.toMatchObject({ code: 'EADDRINUSE' });

    expect(listeners.listenGatewaySurface).toHaveBeenCalledTimes(2);
    expect(ownedListeners).toHaveLength(1);
    expect(ownedListeners[0].server.listening).toBe(false);
    expect(ownedListeners[0].server.address()).toBeNull();
    expect(occupied.listening).toBe(true);
  });
});
