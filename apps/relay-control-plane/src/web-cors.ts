import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

/**
 * CORS for the control plane's browser-reachable surfaces (`/v1/*` and
 * `/gw/dial-token`), so the web interface can call them cross-origin. Mirrors
 * `apps/gateway/src/mobile-cors.ts` — this package can't import that (a
 * separate app), so the same small, exact-match ruleset is duplicated here
 * rather than shared: no wildcards, no suffix/subdomain matching, and
 * credentials are never enabled, since auth here is a bearer header, not
 * cookies. An empty allowlist (the default) mounts a no-op middleware: CORS
 * stays fully disabled rather than falling back to Hono's `cors()` default of
 * `*`.
 */
export function webCors(allowedOrigins: readonly string[]): MiddlewareHandler {
  if (allowedOrigins.length === 0) {
    return async (_c, next) => next();
  }

  const allowed = new Set(allowedOrigins);

  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : undefined),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
  });
}
