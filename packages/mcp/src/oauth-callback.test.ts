import { startOAuthCallbackServer } from './oauth-callback.js';

describe('OAuthCallbackServer', () => {
  it('starts on a random port and returns a URL', async () => {
    const server = await startOAuthCallbackServer();
    try {
      expect(server.url.hostname).toBe('localhost');
      expect(server.url.pathname).toBe('/callback');
      expect(Number(server.url.port)).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it('captures authorization code from callback', async () => {
    const server = await startOAuthCallbackServer();
    try {
      const callbackUrl = new URL(server.url);
      callbackUrl.searchParams.set('code', 'test-auth-code');
      callbackUrl.searchParams.set('state', 'test-state');

      const resultPromise = server.waitForCallback();
      await fetch(callbackUrl.toString());
      const result = await resultPromise;

      expect(result.code).toBe('test-auth-code');
      expect(result.state).toBe('test-state');
    } finally {
      server.close();
    }
  });

  it('returns HTML response to the browser', async () => {
    const server = await startOAuthCallbackServer();
    try {
      const callbackUrl = new URL(server.url);
      callbackUrl.searchParams.set('code', 'abc');

      const response = await fetch(callbackUrl.toString());
      const text = await response.text();

      expect(response.headers.get('content-type')).toContain('text/html');
      expect(text).toContain('Authorization complete');
    } finally {
      server.close();
    }
  });

  it('returns 400 if no code parameter', async () => {
    const server = await startOAuthCallbackServer();
    try {
      const response = await fetch(server.url.toString());
      expect(response.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('times out if no callback received', async () => {
    const server = await startOAuthCallbackServer({ timeout: 100 });
    try {
      await expect(server.waitForCallback()).rejects.toThrow('timed out');
    } finally {
      server.close();
    }
  });
});
