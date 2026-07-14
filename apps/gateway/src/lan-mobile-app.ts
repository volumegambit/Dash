import { Hono } from 'hono';

/**
 * Create the public-LAN HTTP surface. The native capability API is forwarded
 * in-process so it shares the canonical handlers and auth middleware, while
 * every administrative route remains loopback-only. `/ws/chat` is mounted by
 * the gateway entrypoint on the returned app after creating its WS adapter.
 */
export function createLanMobileApp(managementApp: Hono): Hono {
  const app = new Hono();
  const forward = (request: Request) => managementApp.fetch(request);
  app.all('/mobile/v1', (c) => forward(c.req.raw));
  app.all('/mobile/v1/*', (c) => forward(c.req.raw));
  return app;
}
