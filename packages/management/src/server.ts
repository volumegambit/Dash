import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import { basename } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { type BlobSigner, imageContentType } from './blob.js';
import type {
  ChannelHealthEntry,
  ErrorResponse,
  HealthResponse,
  InfoResponse,
  LogsResponse,
  ShutdownResponse,
  SkillContent,
  SkillInfo,
  SkillsConfig,
} from './types.js';

export interface SkillsHandlers {
  list(agentName: string): Promise<SkillInfo[]>;
  get(agentName: string, skillName: string): Promise<SkillContent | null>;
  updateContent(agentName: string, skillName: string, content: string): Promise<void>;
  create(
    agentName: string,
    skillName: string,
    description: string,
    content: string,
  ): Promise<SkillContent>;
  getConfig(agentName: string): SkillsConfig;
  updateConfig(agentName: string, config: SkillsConfig): Promise<void>;
}

export interface ManagementServerOptions {
  port: number;
  token: string;
  getInfo: () => InfoResponse;
  onShutdown: () => Promise<void>;
  logFilePath?: string;
  skills?: SkillsHandlers;
  onUpdateCredentials?: (providerApiKeys: Record<string, Record<string, string>>) => Promise<void>;
  onUpdateAgentConfig?: (
    agentName: string,
    patch: { model?: string; fallbackModels?: string[]; tools?: string[]; systemPrompt?: string },
  ) => Promise<void>;
  /**
   * Blob signer for outbound image delivery (DASH-11). When present, the
   * server exposes `GET /blob/:id` streaming a workspace-scoped file that a
   * signed id resolves to. Omit to disable the endpoint entirely.
   */
  blobSigner?: BlobSigner;
}

export function createManagementApp(options: ManagementServerOptions): Hono {
  const app = new Hono();
  const startTime = Date.now();
  let channelHealthStore: ChannelHealthEntry[] = [];

  // Bearer token auth middleware — /health is exempt (public liveness check).
  // /blob/:id is also exempt: its authorization is the HMAC-signed, expiring id
  // itself (verified in the route), so remote clients fetching over the relay
  // tunnel do not need the management bearer token. An unsigned/expired/tampered
  // id fails verification and returns 403/404.
  app.use('*', async (c, next) => {
    if (c.req.path === '/health' || c.req.path.startsWith('/blob/')) {
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

  // --- Outbound image delivery (DASH-11): GET /blob/:id -------------------
  if (options.blobSigner) {
    const signer = options.blobSigner;
    app.get('/blob/:id', async (c) => {
      const id = c.req.param('id');
      const claims = signer.verify(id);
      if (!claims) {
        // Bad signature, tampered, or expired — do not distinguish, and do not
        // leak whether a path exists.
        return c.json({ error: 'Invalid or expired blob id' } satisfies ErrorResponse, 403);
      }

      const contentType = imageContentType(claims.path);
      if (!contentType) {
        return c.json({ error: 'Unsupported media type' } satisfies ErrorResponse, 415);
      }

      let fileStat: import('node:fs').Stats;
      try {
        fileStat = await stat(claims.path);
      } catch {
        return c.json({ error: 'Not found' } satisfies ErrorResponse, 404);
      }
      if (!fileStat.isFile()) {
        return c.json({ error: 'Not found' } satisfies ErrorResponse, 404);
      }

      const total = fileStat.size;
      const baseHeaders: Record<string, string> = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        // Signed ids are immutable + expiring, so the bytes behind one are safe
        // to cache hard for the id's lifetime.
        'Cache-Control': 'private, max-age=300, immutable',
      };

      // Range support (single range only) so large images and viewers seek.
      const range = c.req.header('Range');
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (m && (m[1] !== '' || m[2] !== '')) {
          const start = m[1] === '' ? total - Number(m[2]) : Number(m[1]);
          let end = m[2] === '' || m[1] === '' ? total - 1 : Number(m[2]);
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) {
            return new Response(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${total}` },
            });
          }
          if (end >= total) end = total - 1;
          if (start >= total) {
            return new Response(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${total}` },
            });
          }
          const nodeStream = createReadStream(claims.path, { start, end });
          return new Response(nodeStream as unknown as ReadableStream, {
            status: 206,
            headers: {
              ...baseHeaders,
              'Content-Range': `bytes ${start}-${end}/${total}`,
              'Content-Length': String(end - start + 1),
            },
          });
        }
      }

      const nodeStream = createReadStream(claims.path);
      return new Response(nodeStream as unknown as ReadableStream, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(total) },
      });
    });
  }

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

    const level = c.req.query('level');
    if (level === 'error' || level === 'warn' || level === 'info') {
      lines = lines.filter((line) => line.includes(`[${level}]`));
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
    const levelFilter = c.req.query('level');
    const matchesLevel = (line: string): boolean => {
      if (levelFilter !== 'error' && levelFilter !== 'warn' && levelFilter !== 'info') return true;
      return line.includes(`[${levelFilter}]`);
    };

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
            if (matchesLevel(line)) enqueue(line);
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
                  if (matchesLevel(line)) {
                    try {
                      enqueue(line);
                    } catch {
                      // Stream may have been closed
                    }
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

  app.post('/channels/health', async (c) => {
    let entries: ChannelHealthEntry[];
    try {
      entries = await c.req.json<ChannelHealthEntry[]>();
    } catch {
      return c.json({ error: 'Invalid request body' } satisfies ErrorResponse, 400);
    }
    channelHealthStore = entries;
    return c.json({ ok: true });
  });

  app.get('/channels/health', (c) => {
    return c.json(channelHealthStore);
  });

  app.post('/credentials', async (c) => {
    if (!options.onUpdateCredentials) {
      return c.json({ error: 'Credential updates not supported' } satisfies ErrorResponse, 501);
    }
    let body: Record<string, Record<string, string>>;
    try {
      body = await c.req.json<Record<string, Record<string, string>>>();
    } catch {
      return c.json({ error: 'Invalid request body' } satisfies ErrorResponse, 400);
    }
    try {
      await options.onUpdateCredentials(body);
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return c.json({ error: message } satisfies ErrorResponse, 500);
    }
  });

  app.patch('/agents/:agentName/config', async (c) => {
    if (!options.onUpdateAgentConfig) {
      return c.json({ error: 'Agent config updates not supported' } satisfies ErrorResponse, 501);
    }
    const { agentName } = c.req.param();
    let body: {
      model?: string;
      fallbackModels?: string[];
      tools?: string[];
      systemPrompt?: string;
    };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      return c.json({ error: 'Invalid request body' } satisfies ErrorResponse, 400);
    }
    try {
      await options.onUpdateAgentConfig(agentName, body);
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return c.json({ error: message } satisfies ErrorResponse, 500);
    }
  });

  if (options.skills) {
    const h = options.skills;

    app.get('/agents/:agentName/skills/config', (c) => {
      const { agentName } = c.req.param();
      return c.json(h.getConfig(agentName));
    });

    app.patch('/agents/:agentName/skills/config', async (c) => {
      const { agentName } = c.req.param();
      let body: Partial<SkillsConfig>;
      try {
        body = await c.req.json<Partial<SkillsConfig>>();
      } catch {
        return c.json({ error: 'Invalid request body' } satisfies ErrorResponse, 400);
      }
      try {
        const current = h.getConfig(agentName);
        await h.updateConfig(agentName, {
          paths: body.paths ?? current.paths,
          urls: body.urls ?? current.urls,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (message.toLowerCase().includes('not found')) {
          return c.json({ error: message } satisfies ErrorResponse, 404);
        }
        return c.json({ error: message || 'Internal server error' } satisfies ErrorResponse, 500);
      }
      return c.json({ requiresRestart: true });
    });

    app.get('/agents/:agentName/skills', async (c) => {
      const { agentName } = c.req.param();
      try {
        return c.json(await h.list(agentName));
      } catch {
        return c.json({ error: 'Failed to list skills' } satisfies ErrorResponse, 500);
      }
    });

    app.post('/agents/:agentName/skills', async (c) => {
      const { agentName } = c.req.param();
      let body: { name: string; description: string; content: string };
      try {
        body = await c.req.json<{ name: string; description: string; content: string }>();
      } catch {
        return c.json({ error: 'Invalid request body' } satisfies ErrorResponse, 400);
      }
      if (!body.name || !body.description || typeof body.content !== 'string') {
        return c.json(
          { error: 'Missing required fields: name, description, content' } satisfies ErrorResponse,
          400,
        );
      }
      const safeSkillName = basename(body.name);
      if (!safeSkillName || safeSkillName === '.' || safeSkillName === '..') {
        return c.json({ error: 'Invalid skill name' } satisfies ErrorResponse, 400);
      }
      try {
        const skill = await h.create(agentName, body.name, body.description, body.content);
        return c.json(skill, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (message.toLowerCase().includes('no writable')) {
          return c.json({ error: message } satisfies ErrorResponse, 400);
        }
        return c.json({ error: message || 'Internal server error' } satisfies ErrorResponse, 500);
      }
    });

    app.get('/agents/:agentName/skills/:skillName', async (c) => {
      const { agentName, skillName } = c.req.param();
      try {
        const skill = await h.get(agentName, skillName);
        if (!skill) return c.json({ error: 'Skill not found' } satisfies ErrorResponse, 404);
        return c.json(skill);
      } catch {
        return c.json({ error: 'Failed to get skill' } satisfies ErrorResponse, 500);
      }
    });

    app.put('/agents/:agentName/skills/:skillName', async (c) => {
      const { agentName, skillName } = c.req.param();
      let body: { content: string };
      try {
        body = await c.req.json<{ content: string }>();
      } catch {
        return c.json({ error: 'Invalid request body' } satisfies ErrorResponse, 400);
      }
      if (typeof body.content !== 'string') {
        return c.json({ error: 'Missing required field: content' } satisfies ErrorResponse, 400);
      }
      try {
        await h.updateContent(agentName, skillName, body.content);
        return c.json({ success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (message.toLowerCase().includes('not found')) {
          return c.json({ error: message } satisfies ErrorResponse, 404);
        }
        if (message.toLowerCase().includes('not editable')) {
          return c.json({ error: message } satisfies ErrorResponse, 403);
        }
        if (message.toLowerCase().includes('outside configured')) {
          return c.json({ error: message } satisfies ErrorResponse, 403);
        }
        return c.json({ error: message || 'Internal server error' } satisfies ErrorResponse, 500);
      }
    });
  } else {
    app.all('/agents/:agentName/skills/*', (c) =>
      c.json({ error: 'Skills management not configured' } satisfies ErrorResponse, 501),
    );
    app.all('/agents/:agentName/skills', (c) =>
      c.json({ error: 'Skills management not configured' } satisfies ErrorResponse, 501),
    );
  }

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
