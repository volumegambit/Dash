import { Hono } from 'hono';
import { createLanMobileApp } from './lan-mobile-app.js';

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
