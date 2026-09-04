import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

/**
 * CORS for the `/mobile/v1` surface, so browser-based clients (the web
 * interface) can call it cross-origin. The allowlist is exact-match only —
 * no wildcards, no suffix/subdomain matching — and credentials are never
 * enabled, since auth here is a bearer header, not cookies. An empty
 * allowlist (the default) mounts a no-op middleware: CORS stays fully
 * disabled rather than falling back to Hono's `cors()` default of `*`.
 */
export function mobileCors(allowedOrigins: readonly string[]): MiddlewareHandler {
  if (allowedOrigins.length === 0) {
    return async (_c, next) => next();
  }

  const allowed = new Set(allowedOrigins);

  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : undefined),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // `x-dash-relay-credential` is the per-pairing credential a browser sends on
    // every relayed `/mobile/v1` request. It is consumed and stripped at the
    // relay edge (it never reaches this server), but the browser still needs it
    // preflight-approved or it will not issue the real request at all.
    allowHeaders: ['Authorization', 'Content-Type', 'x-dash-relay-credential'],
  });
}
