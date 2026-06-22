import http from 'node:http';
import {
  type ControlPlaneSessionTokenStore,
  createControlPlaneSession,
} from './control-plane-session.js';

// These tests drive the desktop loopback-OAuth flow with NO browser and NO
// WorkOS. The `openBrowser` seam stands in for `shell.openExternal` (it GETs
// the loopback callback the session is hosting), and `exchangeCode` stands in
// for `workos.userManagement.authenticateWithCode`. The live round-trip is
// covered by manual MC QA, per the plan.

/** A Map-backed token store, mirroring InMemoryKeychainStore's shape. */
function memoryTokenStore(): ControlPlaneSessionTokenStore & { raw(): string | null } {
  let value: string | null = null;
  return {
    async get() {
      return value;
    },
    async set(v) {
      value = v;
    },
    async clear() {
      value = null;
    },
    raw() {
      return value;
    },
  };
}

/** Fire a GET at the loopback callback the way the real browser redirect would. */
function hitCallback(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createControlPlaneSession', () => {
  const now = () => 1_000_000; // fixed clock (ms) so expiry math is deterministic

  it('signs in via the loopback flow and persists the exchanged token', async () => {
    const store = memoryTokenStore();
    let exchangedCode: string | null = null;
    let openedUrl: string | null = null;

    const session = createControlPlaneSession({
      tokenStore: store,
      buildAuthUrl: (redirectUri) => `https://auth.example/authorize?redirect_uri=${redirectUri}`,
      // The browser stand-in: extract the loopback redirect_uri and GET it with a code.
      openBrowser: async (url) => {
        openedUrl = url;
        const redirectUri = decodeURIComponent(new URL(url).searchParams.get('redirect_uri') ?? '');
        await hitCallback(`${redirectUri}?code=auth-code-123`);
      },
      exchangeCode: async (code) => {
        exchangedCode = code;
        return { accessToken: 'access-token-abc', expiresAt: now() + 3_600_000 };
      },
      now,
    });

    await session.signIn();

    expect(openedUrl).toContain('https://auth.example/authorize');
    expect(openedUrl).toContain('127.0.0.1');
    expect(exchangedCode).toBe('auth-code-123');
    expect(await session.getToken()).toBe('access-token-abc');
    expect(store.raw()).toBe('access-token-abc');
  });

  it('getToken returns the cached token without re-running sign-in', async () => {
    const store = memoryTokenStore();
    await store.set('persisted-token');

    let exchangeCalls = 0;
    const session = createControlPlaneSession({
      tokenStore: store,
      buildAuthUrl: (redirectUri) => `https://auth.example/authorize?redirect_uri=${redirectUri}`,
      openBrowser: async () => {
        throw new Error('openBrowser should not be called when a token is cached');
      },
      exchangeCode: async () => {
        exchangeCalls += 1;
        return { accessToken: 'never', expiresAt: now() + 3_600_000 };
      },
      now,
    });

    expect(await session.getToken()).toBe('persisted-token');
    expect(exchangeCalls).toBe(0);
  });

  it('getToken returns null when signed out', async () => {
    const store = memoryTokenStore();
    const session = createControlPlaneSession({
      tokenStore: store,
      buildAuthUrl: (r) => `https://auth.example/authorize?redirect_uri=${r}`,
      openBrowser: async () => {},
      exchangeCode: async () => ({ accessToken: 'x', expiresAt: now() + 1000 }),
      now,
    });

    expect(await session.getToken()).toBeNull();
  });

  it('signOut clears the persisted token', async () => {
    const store = memoryTokenStore();
    await store.set('persisted-token');
    const session = createControlPlaneSession({
      tokenStore: store,
      buildAuthUrl: (r) => `https://auth.example/authorize?redirect_uri=${r}`,
      openBrowser: async () => {},
      exchangeCode: async () => ({ accessToken: 'x', expiresAt: now() + 1000 }),
      now,
    });

    await session.signOut();
    expect(await session.getToken()).toBeNull();
    expect(store.raw()).toBeNull();
  });

  it('signIn rejects when the loopback callback carries an OAuth error', async () => {
    const store = memoryTokenStore();
    const session = createControlPlaneSession({
      tokenStore: store,
      buildAuthUrl: (r) => `https://auth.example/authorize?redirect_uri=${r}`,
      openBrowser: async (url) => {
        const redirectUri = decodeURIComponent(new URL(url).searchParams.get('redirect_uri') ?? '');
        await hitCallback(`${redirectUri}?error=access_denied`);
      },
      exchangeCode: async () => {
        throw new Error('exchangeCode should not run when the callback is an error');
      },
      now,
    });

    await expect(session.signIn()).rejects.toThrow(/access_denied/);
    expect(await session.getToken()).toBeNull();
  });

  it('signIn rejects when the callback has no code', async () => {
    const store = memoryTokenStore();
    const session = createControlPlaneSession({
      tokenStore: store,
      buildAuthUrl: (r) => `https://auth.example/authorize?redirect_uri=${r}`,
      openBrowser: async (url) => {
        const redirectUri = decodeURIComponent(new URL(url).searchParams.get('redirect_uri') ?? '');
        await hitCallback(redirectUri);
      },
      exchangeCode: async () => ({ accessToken: 'x', expiresAt: now() + 1000 }),
      now,
    });

    await expect(session.signIn()).rejects.toThrow(/code/i);
  });

  it('refreshes the token when the in-memory cache is near expiry', async () => {
    const store = memoryTokenStore();
    let clock = now();
    let issued = 0;

    const session = createControlPlaneSession({
      tokenStore: store,
      buildAuthUrl: (r) => `https://auth.example/authorize?redirect_uri=${r}`,
      openBrowser: async (url) => {
        const redirectUri = decodeURIComponent(new URL(url).searchParams.get('redirect_uri') ?? '');
        await hitCallback(`${redirectUri}?code=code-${issued}`);
      },
      exchangeCode: async () => {
        issued += 1;
        // Each token is valid for 60s from the current clock.
        return { accessToken: `token-${issued}`, expiresAt: clock + 60_000 };
      },
      now: () => clock,
    });

    await session.signIn();
    expect(await session.getToken()).toBe('token-1');
    expect(issued).toBe(1);

    // Advance the clock past the token's expiry: getToken silently re-auths.
    clock += 120_000;
    expect(await session.getToken()).toBe('token-2');
    expect(issued).toBe(2);
  });
});
