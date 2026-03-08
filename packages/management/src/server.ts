import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type {
  ErrorResponse,
  HealthResponse,
  InfoResponse,
  LogsResponse,
  ShutdownResponse,
} from './types.js';

export interface ManagementServerOptions {
  port: number;
  token: string;
  getInfo: () => InfoResponse;
  onShutdown: () => Promise<void>;
  logFilePath?: string;
}

export function createManagementApp(options: ManagementServerOptions): Hono {
  const app = new Hono();
  const startTime = Date.now();

  // Bearer token auth middleware — /health is exempt (public liveness check)
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') {
      await next();
      return;
    }
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

  app.get('/logs', async (c) => {
    if (!options.logFilePath) {
      return c.json({ error: 'Logs not configured' } satisfies ErrorResponse, 404);
    }
    if (!existsSync(options.logFilePath)) {
      return c.json({ lines: [] } satisfies LogsResponse);
    }

    const content = await readFile(options.logFilePath, 'utf-8');
    let lines = content.split('\n').filter(Boolean);

    const since = c.req.query('since');
    if (since) {
      lines = lines.filter((line) => {
        const ts = line.slice(0, 24);
        return ts >= since;
      });
    }

    const tail = c.req.query('tail');
    const parsed = tail !== undefined && tail !== '' ? Number.parseInt(tail, 10) : 100;
    const tailNum = Number.isNaN(parsed) ? 100 : parsed;
    if (lines.length > tailNum) {
      lines = lines.slice(-tailNum);
    }

    return c.json({ lines } satisfies LogsResponse);
  });

  app.get('/logs/stream', async (c) => {
    if (!options.logFilePath) {
      return c.json({ error: 'Logs not configured' } satisfies ErrorResponse, 404);
    }

    const logFilePath = options.logFilePath;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        const enqueue = (line: string) => {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        };

        // Send existing lines first
        if (existsSync(logFilePath)) {
          const content = await readFile(logFilePath, 'utf-8');
          for (const line of content.split('\n').filter(Boolean)) {
            enqueue(line);
          }
        }

        // Watch for new lines using fs.watch (only if file exists)
        let watcher: import('node:fs').FSWatcher | undefined;
        if (existsSync(logFilePath)) {
          const { watch } = await import('node:fs');
          let offset = (await stat(logFilePath)).size;

          watcher = watch(logFilePath);
          watcher.on('change', async () => {
            try {
              const fileStat = await stat(logFilePath);
              if (fileStat.size > offset) {
                const { open } = await import('node:fs/promises');
                const fh = await open(logFilePath, 'r');
                const buf = Buffer.alloc(fileStat.size - offset);
                await fh.read(buf, 0, buf.length, offset);
                await fh.close();
                offset = fileStat.size;
                for (const line of buf.toString('utf-8').split('\n').filter(Boolean)) {
                  try {
                    enqueue(line);
                  } catch {
                    // Stream may have been closed
                  }
                }
              }
            } catch {
              // File may have been deleted or rotated
            }
          });
          watcher.on('error', () => {
            watcher?.close();
          });
        }

        c.req.raw.signal.addEventListener('abort', () => {
          watcher?.close();
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
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
