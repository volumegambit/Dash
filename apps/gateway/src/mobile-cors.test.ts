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
  it('answers preflight with methods and Authorization header, no credentials', async () => {
    const res = await appWith(['https://app.example.com']).request('/x', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
  it('is inert with an empty allowlist', async () => {
    const res = await appWith([]).request('/x', { headers: { origin: 'https://app.example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
