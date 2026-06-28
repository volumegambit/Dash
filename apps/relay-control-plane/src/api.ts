import { Hono } from 'hono';
import type { Authenticator } from './auth.js';
import type { GatewayAssertionAuthenticator } from './gateway-assertion-auth.js';
import {
  InvalidPublicKeyError,
  InvalidSubdomainError,
  type ProvisioningService,
  SubdomainTakenError,
} from './provisioning.js';

/** Collaborators the HTTP API binds its routes to. */
export interface ApiDeps {
  provisioning: ProvisioningService;
  authenticator: Authenticator;
  /** Authenticates the gateway-driven `/gw/dial-token` refresh (non-Clerk). */
  gatewayAssertionAuth: GatewayAssertionAuthenticator;
}

/**
 * Hono variables set by the auth middleware. Every route below `/v1` reads the
 * resolved `accountId` from the context — it is the ownership boundary for all
 * provisioning calls.
 */
type ApiEnv = { Variables: { accountId: string } };

/**
 * Build the control-plane HTTP API.
 *
 * `/health` is open; every `/v1/*` route sits behind the auth middleware, which
 * resolves the request to an `accountId` via the injected {@link Authenticator}
 * (or answers 401). Ownership is enforced one layer down by the
 * {@link ProvisioningService}: a cross-account mutation never reaches the relay
 * and surfaces here as a 404 — we don't disclose whether the gateway exists
 * under another account.
 */
export function createApi(deps: ApiDeps): Hono<ApiEnv> {
  const { provisioning, authenticator, gatewayAssertionAuth } = deps;
  const app = new Hono<ApiEnv>();

  // --- Health (open) ---
  app.get('/health', (c) => c.json({ status: 'healthy' }));

  // --- Gateway-driven dial-token refresh (open path, gateway-assertion auth) ---
  // Sibling to /health — NOT under the Clerk-gated /v1/* middleware. The gateway
  // proves possession of its private key with a signed assertion; the account is
  // re-derived from the stored record, never the request. Every failure → 401.
  app.post('/gw/dial-token', (c) => {
    const dialToken = gatewayAssertionAuth.mintDialToken(c.req.header('authorization'));
    if (!dialToken) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ dialToken });
  });

  // --- Auth middleware: gates everything under /v1 ---
  app.use('/v1/*', async (c, next) => {
    const headers = headerRecord(c.req.raw.headers);
    const principal = await authenticator.authenticate(headers);
    if (!principal) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('accountId', principal.accountId);
    await next();
  });

  // --- Gateways ---

  app.post('/v1/gateways', async (c) => {
    const accountId = c.get('accountId');
    const body = (await c.req.json().catch(() => ({}))) as {
      subdomain?: unknown;
      publicKey?: unknown;
    };
    const subdomain = typeof body.subdomain === 'string' ? body.subdomain : '';
    const publicKey = typeof body.publicKey === 'string' ? body.publicKey : '';
    try {
      const created = provisioning.createGateway(accountId, { subdomain, publicKey });
      return c.json(created);
    } catch (err) {
      if (err instanceof SubdomainTakenError) {
        return c.json({ error: 'subdomain taken' }, 409);
      }
      if (err instanceof InvalidSubdomainError || err instanceof InvalidPublicKeyError) {
        return c.json({ error: 'invalid request' }, 400);
      }
      throw err;
    }
  });

  app.get('/v1/gateways', (c) => {
    const accountId = c.get('accountId');
    return c.json({ gateways: provisioning.listGateways(accountId) });
  });

  app.get('/v1/subdomains/:label', (c) => {
    const label = c.req.param('label');
    return c.json({ available: provisioning.isSubdomainAvailable(label) });
  });

  app.delete('/v1/gateways/:id', async (c) => {
    const accountId = c.get('accountId');
    const ok = await provisioning.deleteGateway(accountId, c.req.param('id'));
    if (!ok) return c.json({ error: 'gateway not found' }, 404);
    return c.json({ ok: true });
  });

  // --- Pairings ---

  app.post('/v1/gateways/:id/pairings', async (c) => {
    const accountId = c.get('accountId');
    const gatewayId = c.req.param('id');
    const deviceLabel = await readDeviceLabel(c);
    try {
      const { credential } = await provisioning.createPairing(accountId, gatewayId, deviceLabel);
      return c.json({ credential });
    } catch {
      // Cross-account or unknown gateway — don't disclose existence.
      return c.json({ error: 'gateway not found' }, 404);
    }
  });

  app.get('/v1/gateways/:id/pairings', (c) => {
    const accountId = c.get('accountId');
    const gatewayId = c.req.param('id');
    const pairings = provisioning.listPairings(accountId, gatewayId);
    if (pairings === null) return c.json({ error: 'gateway not found' }, 404);
    return c.json({ pairings });
  });

  app.delete('/v1/gateways/:id/pairings/:pid', async (c) => {
    const accountId = c.get('accountId');
    const ok = await provisioning.deletePairing(accountId, c.req.param('id'), c.req.param('pid'));
    if (!ok) return c.json({ error: 'pairing not found' }, 404);
    return c.json({ ok: true });
  });

  return app;
}

/** Flatten Hono's `Headers` into the lowercase record the Authenticator expects. */
function headerRecord(headers: Headers): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Pull an optional `deviceLabel` from a (possibly absent or non-JSON) body.
 * Pairing creation must work with no body at all, so a parse failure is treated
 * as "no label" rather than a 400.
 */
async function readDeviceLabel(c: {
  req: { json: () => Promise<unknown> };
}): Promise<string | undefined> {
  try {
    const body = (await c.req.json()) as { deviceLabel?: unknown };
    return typeof body?.deviceLabel === 'string' ? body.deviceLabel : undefined;
  } catch {
    return undefined;
  }
}
