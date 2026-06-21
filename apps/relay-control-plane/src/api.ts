import { Hono } from 'hono';
import type { Authenticator } from './auth.js';
import type { ProvisioningService } from './provisioning.js';

/** Collaborators the HTTP API binds its routes to. */
export interface ApiDeps {
  provisioning: ProvisioningService;
  authenticator: Authenticator;
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
  const { provisioning, authenticator } = deps;
  const app = new Hono<ApiEnv>();

  // --- Health (open) ---
  app.get('/health', (c) => c.json({ status: 'healthy' }));

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

  app.post('/v1/gateways', (c) => {
    const accountId = c.get('accountId');
    const { gatewayId, subdomain, dialToken } = provisioning.createGateway(accountId);
    return c.json({ gatewayId, subdomain, dialToken });
  });

  app.get('/v1/gateways', (c) => {
    const accountId = c.get('accountId');
    return c.json({ gateways: provisioning.listGateways(accountId) });
  });

  app.delete('/v1/gateways/:id', async (c) => {
    const accountId = c.get('accountId');
    const ok = await provisioning.deleteGateway(accountId, c.req.param('id'));
    if (!ok) return c.json({ error: 'gateway not found' }, 404);
    return c.json({ ok: true });
  });

  // Refresh: re-sign a dial token for a gateway the caller owns. Ownership is
  // re-checked against the caller's own gateway list so a forged id for another
  // account's gateway cannot mint a token.
  app.post('/v1/gateways/:id/dial-token', (c) => {
    const accountId = c.get('accountId');
    const gatewayId = c.req.param('id');
    const dialToken = provisioning.refreshDialToken(accountId, gatewayId);
    if (!dialToken) return c.json({ error: 'gateway not found' }, 404);
    return c.json({ dialToken });
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
