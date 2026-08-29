import { Hono } from 'hono';
import { WsTicketStore } from './ws-ticket-store.js';

export interface LanMobileApp {
  app: Hono;
  wsTickets: WsTicketStore;
}

/**
 * Create the public-LAN HTTP surface. The native capability API is forwarded
 * in-process so it shares the canonical handlers and auth middleware, while
 * every administrative route remains loopback-only. `/ws/chat` is mounted by
 * the gateway entrypoint on the returned app after creating its WS adapter.
 *
 * `POST /mobile/v1/ws-ticket` mints single-use WebSocket upgrade tickets
 * (`WsTicketStore`). The store instance must be the one the gateway later
 * wires into `mountChatWs` for this same app (see
 * `createLanMobileAppWithTickets`), so the route can't just be forwarded
 * through unmodified — but it still needs the real mobile-bearer protection
 * every other `/mobile/v1` route gets. We get that for free by registering
 * the handler directly on `managementApp` (mutating it after the fact, same
 * as `mobile-test-harness.ts` does for its `/mobile/v1/__mobile-test/...`
 * routes and `mountProjectsWs` does for `/projects/ws`): Hono's `app.use('*',
 * ...)` bearer middleware, already registered on `managementApp`, matches by
 * request path at dispatch time regardless of when a route was added, so it
 * guards this handler exactly like it guards `/mobile/v1/identity`. The
 * request never needs to pass back through `app`'s own forwarding wildcard —
 * `managementApp.fetch` routes it directly.
 */
function buildLanMobileApp(managementApp: Hono): LanMobileApp {
  const app = new Hono();
  const forward = (request: Request) => managementApp.fetch(request);
  const wsTickets = new WsTicketStore();

  managementApp.post('/mobile/v1/ws-ticket', (c) => c.json(wsTickets.issue()));

  app.all('/mobile/v1', (c) => forward(c.req.raw));
  app.all('/mobile/v1/*', (c) => forward(c.req.raw));
  return { app, wsTickets };
}

export function createLanMobileApp(managementApp: Hono): Hono {
  return buildLanMobileApp(managementApp).app;
}

/** Same as `createLanMobileApp`, but also returns the ws-ticket store so the
 * caller can share it with the chat-ws upgrade handler mounted on the same app. */
export function createLanMobileAppWithTickets(managementApp: Hono): LanMobileApp {
  return buildLanMobileApp(managementApp);
}
