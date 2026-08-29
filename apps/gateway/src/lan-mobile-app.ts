import { Hono } from 'hono';

/**
 * Create the public-LAN HTTP surface. The native capability API is forwarded
 * in-process so it shares the canonical handlers and auth middleware, while
 * every administrative route remains loopback-only. `/ws/chat` is mounted by
 * the caller on the returned app after creating its WS adapter — with the
 * shared `WsTicketStore` from `mountWsTicketRoute`.
 *
 * Note what this factory deliberately does NOT do:
 *
 * - It does not create a ticket store or register `POST /mobile/v1/ws-ticket`.
 *   Both live in `ws-ticket-store.ts` and are wired once per process, because
 *   the relay forwards browser `/ws/chat` traffic to the CHANNEL listener, not
 *   here — a store owned by this factory would leave that listener ticketless
 *   (and, since this surface only exists when LAN TLS is configured, sometimes
 *   leave the mint route unregistered entirely).
 * - It does not apply CORS. `mobileCors` is mounted on `managementApp` itself
 *   (see `management-api.ts`), which every `/mobile/v1` request reaches on both
 *   the LAN-forward and relay-replay paths; doing it here too would only double
 *   the `Vary` header.
 */
export function createLanMobileApp(managementApp: Hono): Hono {
  const app = new Hono();
  const forward = (request: Request) => managementApp.fetch(request);
  app.all('/mobile/v1', (c) => forward(c.req.raw));
  app.all('/mobile/v1/*', (c) => forward(c.req.raw));
  return app;
}
