import { Hono } from 'hono';
import { classifyMobileRouteTarget, mobileRequestTarget } from './mobile-route-target.js';

interface NodeBindings {
  incoming?: { url?: string };
}

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
  const app = new Hono<{ Bindings: NodeBindings }>();
  const forward = (request: Request) => managementApp.fetch(request);
  app.all('*', async (c, next) => {
    const target = classifyMobileRouteTarget(mobileRequestTarget(c.req.url, c.env?.incoming?.url));
    if (target.kind === 'rejected') {
      return c.json(
        { code: 'validation_failed', error: 'Invalid request target', retryable: false },
        400,
      );
    }
    if (target.kind === 'mobile') return forward(c.req.raw);
    if (target.pathname === '/ws/chat') {
      await next();
      return;
    }
    return c.notFound();
  });
  return app;
}
