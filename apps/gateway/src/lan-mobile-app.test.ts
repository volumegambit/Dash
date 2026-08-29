import { Hono } from 'hono';
import { createLanMobileApp, createLanMobileAppWithTickets } from './lan-mobile-app.js';
import { createGatewayManagementApp } from './management-api.js';

const MOBILE_TOKEN = 'mobile-test-token';
const ADMIN_TOKEN = 'admin-test-token';

// Minimal stub deps for createGatewayManagementApp — same pattern as
// management-api.projects.test.ts's makeStubDeps. Only the auth middleware
// and the ws-ticket route mounted onto it are exercised here.
function makeRealManagementApp(): Hono {
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

describe('createLanMobileApp', () => {
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

describe('createLanMobileAppWithTickets', () => {
  it('rejects an unauthenticated POST /mobile/v1/ws-ticket with the same status as other mobile routes', async () => {
    const { app } = createLanMobileAppWithTickets(makeAuthedManagementApp());

    const unauth = await app.request('/mobile/v1/ws-ticket', { method: 'POST' });
    const otherRoute = await app.request('/mobile/v1/agents');

    expect(otherRoute.status).toBe(401);
    expect(unauth.status).toBe(otherRoute.status);
  });

  it('mints a redeemable ticket for an authenticated POST', async () => {
    const { app, wsTickets } = createLanMobileAppWithTickets(makeAuthedManagementApp());

    const res = await app.request('/mobile/v1/ws-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MOBILE_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
    // Confirms this is the same store instance the caller gets back —
    // Task 4 relies on that to redeem tickets minted through this route.
    expect(wsTickets.redeem(body.ticket)).toBe(true);
  });

  it('still forwards other /mobile/v1 routes unchanged', async () => {
    const { app } = createLanMobileAppWithTickets(makeAuthedManagementApp());

    const res = await app.request('/mobile/v1/agents', {
      headers: { Authorization: `Bearer ${MOBILE_TOKEN}` },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ path: '/mobile/v1/agents' });
  });
});

describe('createLanMobileAppWithTickets against the real management app', () => {
  // Proves the route is guarded by createGatewayManagementApp's actual bearer
  // middleware (not a stand-in), including that it's scoped to the mobile
  // bearer specifically — an administrative token must not work either.
  it('enforces the real mobile-bearer middleware end to end', async () => {
    const { app } = createLanMobileAppWithTickets(makeRealManagementApp());

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
});
