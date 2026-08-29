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
 * (`WsTicketStore`) and is handled locally instead of forwarded, because the
 * store instance must be the one the gateway later wires into `mountChatWs`
 * for this same app (see `createLanMobileAppWithTickets`). It still gets the
 * mobile-bearer protection that every other `/mobile/v1` route gets: this
 * path is never registered on `managementApp`, so forwarding the request
 * there runs `managementApp`'s auth middleware first and — for an
 * unauthenticated/bad-token request — short-circuits with the same 401 the
 * other mobile routes return; an authenticated request instead falls through
 * to a 404 (no such route on `managementApp`), which we treat as "authorized"
 * and mint the ticket ourselves.
 */
function buildLanMobileApp(managementApp: Hono): LanMobileApp {
  const app = new Hono();
  const forward = (request: Request) => managementApp.fetch(request);
  const wsTickets = new WsTicketStore();

  app.post('/mobile/v1/ws-ticket', async (c) => {
    const authProbe = await forward(c.req.raw);
    if (authProbe.status === 401) return authProbe;
    return c.json(wsTickets.issue());
  });

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
