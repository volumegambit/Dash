import { Hono } from 'hono';
import { createLanMobileApp } from './lan-mobile-app.js';
import { createGatewayManagementApp } from './management-api.js';
import { mountWsTicketRoute } from './ws-ticket-store.js';

const MOBILE_TOKEN = 'mobile-test-token';
const ADMIN_TOKEN = 'admin-test-token';

// Minimal stub deps for createGatewayManagementApp — same pattern as
// management-api.projects.test.ts's makeStubDeps. Only the auth middleware
// and the ws-ticket route mounted onto it are exercised here.
function makeRealManagementApp(webOrigins: string[] = []): Hono {
  return createGatewayManagementApp({
    // biome-ignore lint/suspicious/noExplicitAny: stubs for unrelated subsystems
    gateway: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    agents: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    agentRegistry: { list: () => [] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    channelRegistry: { list: () => [] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    credentialStore: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    modelsStore: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    identity: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    conversationService: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    resumableChatHub: {} as any,
    token: ADMIN_TOKEN,
    mobileToken: MOBILE_TOKEN,
    webOrigins,
    // biome-ignore lint/suspicious/noExplicitAny: stub deps cast, mirrors management-api.projects.test.ts
  } as any);
}

/** Minimal stand-in for `createGatewayManagementApp`'s bearer middleware,
 * scoped to the `/mobile/v1` namespace like the real one. Routes other than
 * ws-ticket fall through to `notFound` rather than a registered `all('*')`
 * route — like the real management app, so a route mutated in afterward
 * (`buildLanMobileApp` calling `managementApp.post(...)`) isn't shadowed by
 * an earlier-registered wildcard handler that never calls `next()`. */
function makeAuthedManagementApp(): Hono {
  const managementApp = new Hono();
  managementApp.use('*', async (c, next) => {
    const mobileRoute = c.req.path === '/mobile/v1' || c.req.path.startsWith('/mobile/v1/');
    if (mobileRoute && c.req.header('Authorization') !== `Bearer ${MOBILE_TOKEN}`) {
      return c.json({ code: 'unauthorized', error: 'Unauthorized', retryable: false }, 401);
    }
    await next();
  });
  managementApp.get('/mobile/v1/agents', async (c) => c.json({ path: c.req.path }));
  return managementApp;
}

const ALLOWED_ORIGIN = 'https://app.example.com';

describe('createLanMobileApp', () => {
  it('adds no CORS of its own — the management app owns the single policy', async () => {
    // CORS lives on `managementApp` so the LAN-forward and relay-replay paths
    // share one policy; a second mount here would only double `Vary: Origin`.
    const managementApp = new Hono();
    managementApp.all('*', async (c) => c.json({ path: c.req.path }));
    const app = createLanMobileApp(managementApp);

    const res = await app.request('/mobile/v1/agents', { headers: { origin: ALLOWED_ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('forwards only the exact mobile namespace and preserves the request', async () => {
    const managementApp = new Hono();
    managementApp.all('*', async (c) =>
      c.json({ method: c.req.method, path: c.req.path, body: await c.req.text() }),
    );
    const app = createLanMobileApp(managementApp);

    const root = await app.request('/mobile/v1');
    expect(root.status).toBe(200);
    await expect(root.json()).resolves.toMatchObject({ path: '/mobile/v1' });

    const nested = await app.request('/mobile/v1/agents?limit=1', {
      method: 'POST',
      body: '{"name":"phone"}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(nested.status).toBe(200);
    await expect(nested.json()).resolves.toEqual({
      method: 'POST',
      path: '/mobile/v1/agents',
      body: '{"name":"phone"}',
    });

    for (const path of ['/health', '/agents', '/mobile/v10', '/mobile/v1-admin', '/projects/ws']) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });
});

describe('mountWsTicketRoute', () => {
  it('rejects an unauthenticated POST /mobile/v1/ws-ticket like any other mobile route', async () => {
    const managementApp = makeAuthedManagementApp();
    mountWsTicketRoute(managementApp);
    const app = createLanMobileApp(managementApp);

    const unauth = await app.request('/mobile/v1/ws-ticket', { method: 'POST' });
    const otherRoute = await app.request('/mobile/v1/agents');

    expect(otherRoute.status).toBe(401);
    expect(unauth.status).toBe(otherRoute.status);
  });

  it('mints a ticket redeemable through the returned store', async () => {
    const managementApp = makeAuthedManagementApp();
    const wsTickets = mountWsTicketRoute(managementApp);
    const app = createLanMobileApp(managementApp);

    const res = await app.request('/mobile/v1/ws-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MOBILE_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
    // The caller gets back the very store the route mints into — that identity
    // is what every `/ws/chat` mount depends on to redeem.
    expect(wsTickets.redeem(body.ticket)).toBe(true);
  });

  it('mints over the management app directly, not only through the LAN forward', async () => {
    // The relay never touches the LAN app: it replays `/mobile/v1` against the
    // management server, so the mint route has to answer there too.
    const managementApp = makeAuthedManagementApp();
    const wsTickets = mountWsTicketRoute(managementApp);

    const res = await managementApp.request('/mobile/v1/ws-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MOBILE_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(wsTickets.redeem((await res.json()).ticket)).toBe(true);
  });

  it('still forwards other /mobile/v1 routes unchanged', async () => {
    const managementApp = makeAuthedManagementApp();
    mountWsTicketRoute(managementApp);
    const app = createLanMobileApp(managementApp);

    const res = await app.request('/mobile/v1/agents', {
      headers: { Authorization: `Bearer ${MOBILE_TOKEN}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ path: '/mobile/v1/agents' });
  });
});

describe('mountWsTicketRoute against the real management app', () => {
  // Proves the route is guarded by createGatewayManagementApp's actual bearer
  // middleware (not a stand-in), including that it's scoped to the mobile
  // bearer specifically — an administrative token must not work either.
  it('enforces the real mobile-bearer middleware end to end', async () => {
    const managementApp = makeRealManagementApp();
    mountWsTicketRoute(managementApp);
    const app = createLanMobileApp(managementApp);

    const unauth = await app.request('/mobile/v1/ws-ticket', { method: 'POST' });
    expect(unauth.status).toBe(401);

    const adminAuthed = await app.request('/mobile/v1/ws-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(adminAuthed.status).toBe(401);

    const mobileAuthed = await app.request('/mobile/v1/ws-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MOBILE_TOKEN}` },
    });
    expect(mobileAuthed.status).toBe(200);
    const body = await mobileAuthed.json();
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.expiresAt).toBe('string');
  });

  it('answers a preflight OPTIONS to /mobile/v1/ws-ticket from an allowlisted origin', async () => {
    // CORS is on the management app now, so the preflight is answered there —
    // reached identically through the LAN forward or the relay replay.
    const managementApp = makeRealManagementApp([ALLOWED_ORIGIN]);
    mountWsTicketRoute(managementApp);
    const app = createLanMobileApp(managementApp);

    const res = await app.request('/mobile/v1/ws-ticket', {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

// The relay replays phone traffic straight against the management server
// (`managementPort`), bypassing the LAN app entirely — so the CORS answer a
// browser needs has to come from the management app itself, not just from
// `createLanMobileApp`. These tests pin that.
describe('management app CORS on /mobile/v1 (the relay replay path)', () => {
  it('answers a preflight from an allowlisted origin without a bearer', async () => {
    const app = makeRealManagementApp([ALLOWED_ORIGIN]);
    const res = await app.request('/mobile/v1/agents', {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-dash-relay-credential',
      },
    });
    // The bearer middleware must never see it — a preflight carries no auth.
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('x-dash-relay-credential');
  });

  it('sets no CORS headers for a non-allowlisted origin, but answers identically', async () => {
    const app = makeRealManagementApp([ALLOWED_ORIGIN]);
    const res = await app.request('/mobile/v1/agents', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    // The status is deliberately the same 204 an allowlisted origin gets: the
    // allowlist is enforced by the ABSENT header, not by a distinguishable
    // status, so a preflight can't be used to probe allowlist membership.
    expect(res.status).toBe(204);
  });

  it('still requires the mobile bearer on the real request', async () => {
    const app = makeRealManagementApp([ALLOWED_ORIGIN]);
    const res = await app.request('/mobile/v1/agents', {
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(401);
  });

  it('leaves administrative routes free of CORS entirely', async () => {
    const app = makeRealManagementApp([ALLOWED_ORIGIN]);
    const res = await app.request('/agents', { headers: { origin: ALLOWED_ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('is inert when no web origins are configured (default)', async () => {
    const app = makeRealManagementApp();
    const res = await app.request('/mobile/v1/agents', {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.status).toBe(401);
  });
});
