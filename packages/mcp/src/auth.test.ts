import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DashOAuthClientProvider } from './auth.js';
import { startOAuthCallbackServer } from './oauth-callback.js';
import { InMemoryTokenStore, type TokenStore } from './types.js';

// Helper: a store wrapper that counts operations so tests can assert
// that invalidateCredentials touches exactly the keys we expect.
class InstrumentedStore implements TokenStore {
  private inner = new InMemoryTokenStore();
  deletedKeys: string[] = [];
  setKeys: string[] = [];

  async get(key: string) {
    return this.inner.get(key);
  }
  async set(key: string, value: string) {
    this.setKeys.push(key);
    return this.inner.set(key, value);
  }
  async delete(key: string) {
    this.deletedKeys.push(key);
    return this.inner.delete(key);
  }
}

// ── Namespacing ───────────────────────────────────────────────────────────

describe('DashOAuthClientProvider — store key namespacing', () => {
  it('writes tokens under an mcp:<serverName>:tokens key and reads them back', async () => {
    const store = new InstrumentedStore();
    const provider = new DashOAuthClientProvider('my-server', store);

    const tokens: OAuthTokens = {
      access_token: 'at-123',
      token_type: 'Bearer',
      refresh_token: 'rt-456',
      expires_in: 3600,
    };
    await provider.saveTokens(tokens);

    expect(store.setKeys).toContain('mcp:my-server:tokens');
    const roundTrip = await provider.tokens();
    expect(roundTrip).toEqual(tokens);
  });

  it('two providers with different server names do not collide in a shared store', async () => {
    const sharedStore = new InMemoryTokenStore();
    const alpha = new DashOAuthClientProvider('alpha', sharedStore);
    const beta = new DashOAuthClientProvider('beta', sharedStore);

    await alpha.saveTokens({ access_token: 'alpha-token', token_type: 'Bearer' });
    await beta.saveTokens({ access_token: 'beta-token', token_type: 'Bearer' });

    expect((await alpha.tokens())?.access_token).toBe('alpha-token');
    expect((await beta.tokens())?.access_token).toBe('beta-token');

    // Clearing alpha's tokens must not affect beta's
    await alpha.invalidateCredentials('tokens');
    expect(await alpha.tokens()).toBeUndefined();
    expect((await beta.tokens())?.access_token).toBe('beta-token');
  });
});

// ── Token round-trip ──────────────────────────────────────────────────────

describe('DashOAuthClientProvider — tokens()', () => {
  let store: InMemoryTokenStore;

  beforeEach(() => {
    store = new InMemoryTokenStore();
  });

  it('returns undefined when no tokens have been saved', async () => {
    const provider = new DashOAuthClientProvider('svc', store);
    expect(await provider.tokens()).toBeUndefined();
  });

  it('returns the exact token object that was saved', async () => {
    const provider = new DashOAuthClientProvider('svc', store);
    const tokens: OAuthTokens = {
      access_token: 'at',
      token_type: 'Bearer',
      refresh_token: 'rt',
      expires_in: 900,
      scope: 'read write',
    };
    await provider.saveTokens(tokens);
    expect(await provider.tokens()).toEqual(tokens);
  });

  it('returns undefined rather than throwing when stored value is malformed JSON', async () => {
    const provider = new DashOAuthClientProvider('svc', store);
    // Inject corruption directly — a production issue might be a half-written
    // file from a crash, or manual tampering. We want the provider to recover,
    // not crash the MCP client.
    await store.set('mcp:svc:tokens', '{not-valid-json');
    await expect(provider.tokens()).resolves.toBeUndefined();
  });

  it('overwrites existing tokens on a subsequent saveTokens call', async () => {
    const provider = new DashOAuthClientProvider('svc', store);
    await provider.saveTokens({ access_token: 'first', token_type: 'Bearer' });
    await provider.saveTokens({ access_token: 'second', token_type: 'Bearer' });
    expect((await provider.tokens())?.access_token).toBe('second');
  });
});

// ── Client information ────────────────────────────────────────────────────

describe('DashOAuthClientProvider — clientInformation()', () => {
  let store: InMemoryTokenStore;

  beforeEach(() => {
    store = new InMemoryTokenStore();
  });

  it('returns static clientId + clientSecret from options without touching the store', async () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      clientId: 'static-client-id',
      clientSecret: 'static-secret',
    });

    const info = await provider.clientInformation();
    expect(info).toEqual({ client_id: 'static-client-id', client_secret: 'static-secret' });
  });

  it('returns only client_id when no static secret is configured', async () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      clientId: 'static-id',
    });
    const info = await provider.clientInformation();
    expect(info).toEqual({ client_id: 'static-id', client_secret: undefined });
  });

  it('falls back to the store when no static clientId is configured', async () => {
    const provider = new DashOAuthClientProvider('svc', store);
    const dynamic = { client_id: 'registered-id', client_secret: 'registered-secret' };
    await provider.saveClientInformation(dynamic);

    expect(await provider.clientInformation()).toEqual(dynamic);
  });

  it('returns undefined when store has no clientInfo and no static config is present', async () => {
    const provider = new DashOAuthClientProvider('svc', store);
    expect(await provider.clientInformation()).toBeUndefined();
  });

  it('returns undefined (not throws) when stored clientInfo is malformed JSON', async () => {
    const provider = new DashOAuthClientProvider('svc', store);
    await store.set('mcp:svc:clientInfo', 'not-json');
    await expect(provider.clientInformation()).resolves.toBeUndefined();
  });
});

// ── Client metadata ───────────────────────────────────────────────────────

describe('DashOAuthClientProvider — clientMetadata', () => {
  const store = new InMemoryTokenStore();

  it('sets grant_types to the configured grantType when specified', () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      grantType: 'client_credentials',
    });
    expect(provider.clientMetadata.grant_types).toEqual(['client_credentials']);
  });

  it('advertises both flows when no grantType is configured', () => {
    const provider = new DashOAuthClientProvider('svc', store);
    expect(provider.clientMetadata.grant_types).toEqual([
      'authorization_code',
      'client_credentials',
    ]);
  });

  it('uses clientId as client_name when provided, else dash-mcp-<serverName>', () => {
    const withId = new DashOAuthClientProvider('svc', store, { clientId: 'my-app' });
    expect(withId.clientMetadata.client_name).toBe('my-app');

    const withoutId = new DashOAuthClientProvider('svc', store);
    expect(withoutId.clientMetadata.client_name).toBe('dash-mcp-svc');
  });

  it('joins scopes with a space (RFC 6749 format)', () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      scopes: ['read', 'write', 'admin'],
    });
    expect(provider.clientMetadata.scope).toBe('read write admin');
  });

  it('omits scope when no scopes are configured', () => {
    const provider = new DashOAuthClientProvider('svc', store);
    expect(provider.clientMetadata.scope).toBeUndefined();
  });

  it('uses client_secret_basic for token_endpoint_auth_method', () => {
    const provider = new DashOAuthClientProvider('svc', store);
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_basic');
  });

  it('redirect_uris is empty when the callback server is not running', () => {
    const provider = new DashOAuthClientProvider('svc', store);
    expect(provider.clientMetadata.redirect_uris).toEqual([]);
  });

  it('redirect_uris is empty when grantType is client_credentials, even if a server were running', () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      grantType: 'client_credentials',
    });
    expect(provider.clientMetadata.redirect_uris).toEqual([]);
  });
});

// ── redirectUrl getter ────────────────────────────────────────────────────

describe('DashOAuthClientProvider — redirectUrl', () => {
  const store = new InMemoryTokenStore();

  it('is undefined for client_credentials grant type (no redirect needed)', () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      grantType: 'client_credentials',
    });
    expect(provider.redirectUrl).toBeUndefined();
  });

  it('is undefined when no callback server has been started yet', () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      grantType: 'authorization_code',
    });
    expect(provider.redirectUrl).toBeUndefined();
  });
});

// ── Code verifier ─────────────────────────────────────────────────────────

describe('DashOAuthClientProvider — code verifier round-trip', () => {
  let store: InMemoryTokenStore;

  beforeEach(() => {
    store = new InMemoryTokenStore();
  });

  it('persists and retrieves the PKCE code verifier exactly', async () => {
    const provider = new DashOAuthClientProvider('svc', store);
    // The code verifier per RFC 7636 is a high-entropy string 43-128 chars
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    await provider.saveCodeVerifier(verifier);

    expect(await provider.codeVerifier()).toBe(verifier);
  });

  it('throws a descriptive error when codeVerifier() is called before saving', async () => {
    const provider = new DashOAuthClientProvider('my-server', store);
    await expect(provider.codeVerifier()).rejects.toThrow(
      /No code verifier stored for MCP server "my-server"/,
    );
  });

  it('overwrites the verifier on subsequent save (new auth attempt replaces old one)', async () => {
    const provider = new DashOAuthClientProvider('svc', store);
    await provider.saveCodeVerifier('first-verifier');
    await provider.saveCodeVerifier('second-verifier');
    expect(await provider.codeVerifier()).toBe('second-verifier');
  });
});

// ── Discovery state ───────────────────────────────────────────────────────

describe('DashOAuthClientProvider — discovery state round-trip', () => {
  it('persists and retrieves the OAuth discovery state', async () => {
    const store = new InMemoryTokenStore();
    const provider = new DashOAuthClientProvider('svc', store);

    // OAuthDiscoveryState has optional fields that vary by server implementation.
    // We use a minimal shape here — the provider should store and return it verbatim.
    // biome-ignore lint/suspicious/noExplicitAny: test payload for opaque SDK type
    const state = { authorizationEndpoint: 'https://idp.example/authorize' } as any;
    await provider.saveDiscoveryState(state);

    expect(await provider.discoveryState()).toEqual(state);
  });

  it('returns undefined (not throws) when stored discovery state is malformed', async () => {
    const store = new InMemoryTokenStore();
    const provider = new DashOAuthClientProvider('svc', store);

    await store.set('mcp:svc:discovery', 'not-json-at-all');
    await expect(provider.discoveryState()).resolves.toBeUndefined();
  });

  it('returns undefined when nothing has been saved', async () => {
    const provider = new DashOAuthClientProvider('svc', new InMemoryTokenStore());
    expect(await provider.discoveryState()).toBeUndefined();
  });
});

// ── prepareTokenRequest ───────────────────────────────────────────────────

describe('DashOAuthClientProvider — prepareTokenRequest', () => {
  const store = new InMemoryTokenStore();

  it('returns client_credentials grant with scopes for the CC flow', () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      grantType: 'client_credentials',
      scopes: ['read', 'write'],
    });
    const params = provider.prepareTokenRequest();
    expect(params).toBeInstanceOf(URLSearchParams);
    expect(params?.get('grant_type')).toBe('client_credentials');
    expect(params?.get('scope')).toBe('read write');
  });

  it('uses a scope argument over the configured scopes for CC flow', () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      grantType: 'client_credentials',
      scopes: ['read'],
    });
    const params = provider.prepareTokenRequest('override-scope');
    expect(params?.get('scope')).toBe('override-scope');
  });

  it('omits scope entirely for CC flow when no scopes are configured or passed', () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      grantType: 'client_credentials',
    });
    const params = provider.prepareTokenRequest();
    expect(params?.get('grant_type')).toBe('client_credentials');
    expect(params?.get('scope')).toBeNull();
  });

  it('returns undefined for authorization_code flow (let the SDK handle defaults)', () => {
    const provider = new DashOAuthClientProvider('svc', store, {
      grantType: 'authorization_code',
    });
    expect(provider.prepareTokenRequest()).toBeUndefined();
  });

  it('returns undefined when no grantType is configured (SDK default path)', () => {
    const provider = new DashOAuthClientProvider('svc', store);
    expect(provider.prepareTokenRequest()).toBeUndefined();
  });
});

// ── invalidateCredentials ─────────────────────────────────────────────────

describe('DashOAuthClientProvider — invalidateCredentials', () => {
  let store: InstrumentedStore;
  let provider: DashOAuthClientProvider;

  beforeEach(async () => {
    store = new InstrumentedStore();
    provider = new DashOAuthClientProvider('svc', store);

    // Populate all four store slots before each test
    await provider.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    await provider.saveClientInformation({ client_id: 'ci', client_secret: 'cs' });
    await provider.saveCodeVerifier('verifier-123');
    // biome-ignore lint/suspicious/noExplicitAny: test payload for opaque SDK type
    await provider.saveDiscoveryState({ authorizationEndpoint: 'https://idp' } as any);
    store.deletedKeys = [];
  });

  it('scope="tokens" deletes only the tokens slot', async () => {
    await provider.invalidateCredentials('tokens');

    expect(store.deletedKeys).toEqual(['mcp:svc:tokens']);
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation()).toBeDefined();
    expect(await provider.codeVerifier()).toBe('verifier-123');
    expect(await provider.discoveryState()).toBeDefined();
  });

  it('scope="client" deletes only the clientInfo slot', async () => {
    await provider.invalidateCredentials('client');

    expect(store.deletedKeys).toEqual(['mcp:svc:clientInfo']);
    expect(await provider.clientInformation()).toBeUndefined();
    expect(await provider.tokens()).toBeDefined();
  });

  it('scope="verifier" deletes only the code verifier slot', async () => {
    await provider.invalidateCredentials('verifier');

    expect(store.deletedKeys).toEqual(['mcp:svc:codeVerifier']);
    await expect(provider.codeVerifier()).rejects.toThrow(/No code verifier stored/);
    expect(await provider.tokens()).toBeDefined();
  });

  it('scope="discovery" deletes only the discovery state slot', async () => {
    await provider.invalidateCredentials('discovery');

    expect(store.deletedKeys).toEqual(['mcp:svc:discovery']);
    expect(await provider.discoveryState()).toBeUndefined();
    expect(await provider.tokens()).toBeDefined();
  });

  it('scope="all" deletes every slot in a single call', async () => {
    await provider.invalidateCredentials('all');

    expect(store.deletedKeys.sort()).toEqual(
      ['mcp:svc:clientInfo', 'mcp:svc:codeVerifier', 'mcp:svc:discovery', 'mcp:svc:tokens'].sort(),
    );
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation()).toBeUndefined();
    await expect(provider.codeVerifier()).rejects.toThrow();
    expect(await provider.discoveryState()).toBeUndefined();
  });
});

// ── waitForAuthorizationCode + dispose ───────────────────────────────────

describe('DashOAuthClientProvider — callback lifecycle', () => {
  it('waitForAuthorizationCode throws when no callback server is running', async () => {
    const provider = new DashOAuthClientProvider('my-srv', new InMemoryTokenStore());
    await expect(provider.waitForAuthorizationCode()).rejects.toThrow(
      /No OAuth callback server running for "my-srv"/,
    );
  });

  it('dispose is a no-op when no callback server was started', () => {
    const provider = new DashOAuthClientProvider('svc', new InMemoryTokenStore());
    // Just assert it doesn't throw
    expect(() => provider.dispose()).not.toThrow();
    // Second dispose is also safe
    expect(() => provider.dispose()).not.toThrow();
  });

  it('onAuthUrl callback fires with the authorization URL', async () => {
    const seen: URL[] = [];
    const provider = new DashOAuthClientProvider('svc', new InMemoryTokenStore(), {
      onAuthUrl: (url) => seen.push(url),
    });

    const authUrl = new URL('https://idp.example/authorize?client_id=abc&scope=read');
    await provider.redirectToAuthorization(authUrl);
    // dispose to close the callback server the redirect started
    provider.dispose();

    expect(seen).toHaveLength(1);
    expect(seen[0].toString()).toBe(authUrl.toString());
  });

  it('after redirectToAuthorization, redirectUrl is a URL pointing at the started callback server', async () => {
    const provider = new DashOAuthClientProvider('svc', new InMemoryTokenStore(), {
      grantType: 'authorization_code',
    });
    try {
      await provider.redirectToAuthorization(new URL('https://idp.example/authorize'));
      const redirect = provider.redirectUrl;
      expect(redirect).toBeDefined();
      // Must be a local loopback URL on a concrete port
      const asStr = redirect instanceof URL ? redirect.toString() : (redirect ?? '').toString();
      expect(asStr).toMatch(/^http:\/\/localhost:\d+\/callback/);
    } finally {
      provider.dispose();
    }
  });
});

// ── Integration: real callback server + waitForAuthorizationCode ─────────

describe('DashOAuthClientProvider — real callback round-trip', () => {
  let controller: AbortController;

  beforeEach(() => {
    controller = new AbortController();
  });

  afterEach(() => {
    controller.abort();
  });

  it('waitForAuthorizationCode resolves with the code delivered to the callback server', async () => {
    // Spin up a real callback server (same code path production uses)
    // and hit it with a real HTTP request carrying ?code=...
    const server = await startOAuthCallbackServer({ timeout: 5000 });
    const url = new URL(server.url);
    url.searchParams.set('code', 'test-auth-code-xyz');

    // Fire the GET in the background — server response resolves waitForCallback
    const fetchPromise = fetch(url.toString()).then((r) => r.text());
    const result = await server.waitForCallback();

    expect(result.code).toBe('test-auth-code-xyz');
    const body = await fetchPromise;
    expect(body).toContain('Authorization complete');
  });

  it('callback server rejects a request missing the code query param with 400', async () => {
    const server = await startOAuthCallbackServer({ timeout: 5000 });
    try {
      // Hit the callback URL with no code
      const resp = await fetch(server.url);
      expect(resp.status).toBe(400);
      const body = await resp.text();
      expect(body).toContain('Missing');
    } finally {
      server.close();
    }
  });
});
