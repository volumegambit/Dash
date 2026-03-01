import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { ErrorResponse, HealthResponse, InfoResponse, ShutdownResponse } from './types.js';

export interface ManagementServerOptions {
  port: number;
  token: string;
  getInfo: () => InfoResponse;
  onShutdown: () => Promise<void>;
}

export function createManagementApp(options: ManagementServerOptions): Hono {
  const app = new Hono();
  const startTime = Date.now();

  // Bearer token auth middleware
  app.use('*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${options.token}`) {
      return c.json({ error: 'Unauthorized' } satisfies ErrorResponse, 401);
    }
    await next();
  });

  app.get('/health', (c) => {
    const uptime = (Date.now() - startTime) / 1000;
    const version = process.env.DASH_VERSION ?? '0.1.0';
    return c.json({
      status: 'healthy',
      uptime,
      version,
    } satisfies HealthResponse);
  });

  app.get('/info', (c) => {
    return c.json(options.getInfo());
  });

  app.post('/lifecycle/shutdown', async (c) => {
    await options.onShutdown();
    return c.json({ success: true } satisfies ShutdownResponse);
  });

  return app;
}

export function startManagementServer(options: ManagementServerOptions): {
  server: Server;
  close: () => Promise<void>;
} {
  const app = createManagementApp(options);

  const server = serve({
    fetch: app.fetch,
    port: options.port,
    hostname: '127.0.0.1',
  }) as Server;

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
