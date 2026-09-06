import { Hono } from 'hono';
import { mobileCors } from './mobile-cors.js';

function appWith(origins: string[]) {
  const app = new Hono();
  app.use('*', mobileCors(origins));
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('mobileCors', () => {
  it('echoes an allowlisted origin and allows Authorization', async () => {
    const res = await appWith(['https://app.example.com']).request('/x', {
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  });
  it('sets no CORS headers for a non-allowlisted origin', async () => {
    const res = await appWith(['https://app.example.com']).request('/x', {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('answers PATCH/DELETE preflight with Authorization and If-Match, no credentials', async () => {
    for (const method of ['PATCH', 'DELETE']) {
      const res = await appWith(['https://app.example.com']).request('/x', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization,if-match',
        },
      });
      expect(res.status, method).toBe(204);
      expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
      expect(res.headers.get('access-control-allow-headers')).toContain('If-Match');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });
  it('allows the relay credential header on preflight (browser relay path)', async () => {
    // A browser sends x-dash-relay-credential on every /mobile/v1 request, so
    // the preflight must list it or the real request is never issued.
    const res = await appWith(['https://app.example.com']).request('/x', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-dash-relay-credential',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('x-dash-relay-credential');
  });

  it('is inert with an empty allowlist', async () => {
    const res = await appWith([]).request('/x', { headers: { origin: 'https://app.example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
