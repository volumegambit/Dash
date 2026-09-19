import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { serve } from '@hono/node-server';
import type { GatewaySurface } from './application.js';

export interface OwnedGatewayListener {
  server: Server;
  close(): Promise<void>;
}

export async function listenGatewaySurface(
  { app, injectWebSocket }: GatewaySurface,
  options: { port: number; hostname: string; tls?: { privateKey: string; certificate: string } },
): Promise<OwnedGatewayListener> {
  const { port, hostname, tls } = options;
  const server = serve(
    tls
      ? {
          fetch: app.fetch,
          hostname,
          port,
          createServer: createHttpsServer,
          serverOptions: { key: tls.privateKey, cert: tls.certificate },
        }
      : { fetch: app.fetch, hostname, port },
  ) as Server;
  const sockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const trackConnection = (socket: Socket): void => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', trackConnection);

  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      closing = true;
      const finish = (error?: Error): void => {
        server.off('connection', trackConnection);
        sockets.clear();
        if (error) reject(error);
        else resolve();
      };
      if (!server.listening) {
        for (const socket of sockets) socket.destroy();
        finish();
        return;
      }
      server.close((error) => finish(error));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    });
    return closePromise;
  };

  try {
    injectWebSocket(server);
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      server.once('listening', onListening);
      server.once('error', onError);
    });
    return { server, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
