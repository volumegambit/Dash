import { describe, expect, it, vi } from 'vitest';
import { makeClerkSeams, readControlPlaneConfig } from './control-plane.js';

const config = {
  baseUrl: 'https://cp.test',
  clerkFrontendApi: 'resolved-seahorse-39.clerk.accounts.dev',
  clerkClientId: '5KwDiIAztapVfeoE',
};

describe('readControlPlaneConfig', () => {
  it('reads values from the environment', () => {
    expect(
      readControlPlaneConfig({
        DASH_CONTROL_PLANE_URL: 'https://cp.example',
        DASH_CLERK_FRONTEND_API: 'foo.clerk.accounts.dev',
        DASH_CLERK_CLIENT_ID: 'client_abc',
      }),
    ).toEqual({
      baseUrl: 'https://cp.example',
      clerkFrontendApi: 'foo.clerk.accounts.dev',
      clerkClientId: 'client_abc',
    });
  });

  it('falls back to a default base URL and empty Clerk config when unset', () => {
    const cfg = readControlPlaneConfig({});
    expect(cfg.baseUrl).toMatch(/^https:\/\//);
    expect(cfg.clerkFrontendApi).toBe('');
    expect(cfg.clerkClientId).toBe('');
  });
});

describe('makeClerkSeams', () => {
  it('builds a Clerk authorize URL with the client id, decoded redirect, scopes, and PKCE challenge', () => {
    const seams = makeClerkSeams(config);
    // The session passes the redirect already URL-encoded; the seam decodes it
    // before handing it to Clerk so it is not double-encoded.
    const url = new URL(
      seams.buildAuthUrl(encodeURIComponent('http://127.0.0.1:53682/callback'), 'st-1', 'chal-1'),
    );
    expect(url.origin + url.pathname).toBe(
      'https://resolved-seahorse-39.clerk.accounts.dev/oauth/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('5KwDiIAztapVfeoE');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53682/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('code_challenge')).toBe('chal-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('exchanges a code via the Clerk token endpoint (PKCE) and returns the id_token as the access token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id_token: 'id-jwt',
          access_token: 'opaque-at',
          refresh_token: 'rt',
          expires_in: 600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const seams = makeClerkSeams(config, fetchImpl, () => 1_000_000);

    const result = await seams.exchangeCode('code-abc', 'verifier-xyz');

    // MC sends the OIDC id_token (carries org_id / aud=client_id) as the CP Bearer.
    expect(result).toEqual({ accessToken: 'id-jwt', expiresAt: 1_000_000 + 600 * 1000 });

    // POST to the token endpoint with the PKCE-shaped body.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe('https://resolved-seahorse-39.clerk.accounts.dev/oauth/token');
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('5KwDiIAztapVfeoE');
    expect(body.get('code')).toBe('code-abc');
    expect(body.get('code_verifier')).toBe('verifier-xyz');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:53682/callback');
  });

  it('defaults to a 1h lifetime when the token response omits expires_in', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id_token: 'id-jwt-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const seams = makeClerkSeams(config, fetchImpl, () => 0);

    const result = await seams.exchangeCode('code-xyz', 'verifier-2');
    expect(result).toEqual({ accessToken: 'id-jwt-2', expiresAt: 3600 * 1000 });
  });

  it('throws when the token endpoint returns a non-2xx response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('invalid_grant', { status: 400 }));
    const seams = makeClerkSeams(config, fetchImpl);

    await expect(seams.exchangeCode('bad-code', 'v')).rejects.toThrow(/token exchange/i);
  });

  it('throws when the token response carries no id_token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'only-opaque' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const seams = makeClerkSeams(config, fetchImpl);

    await expect(seams.exchangeCode('code', 'v')).rejects.toThrow(/id_token/i);
  });
});
