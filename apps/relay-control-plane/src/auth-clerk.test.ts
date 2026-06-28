import { type CryptoKey, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ClerkAuthenticator, createClerkVerifier } from './auth-clerk.js';
import type { AccessTokenVerifier } from './auth.js';

const FRONTEND_API = 'resolved-seahorse-39.clerk.accounts.dev';
const ISSUER = `https://${FRONTEND_API}`;
const CLIENT_ID = '5KwDiIAztapVfeoE';

// A fake verifier exercises the bearer-extraction unit (ClerkAuthenticator)
// without touching JWKS/jose: the JWT verification is a separate seam.
const fakeVerifier: AccessTokenVerifier = {
  verify: async (token) => (token === 'good-token' ? { accountId: 'org_42' } : null),
};

describe('ClerkAuthenticator (bearer extraction)', () => {
  it('maps a valid Bearer token to its account', async () => {
    const auth = new ClerkAuthenticator(fakeVerifier);
    expect(await auth.authenticate({ authorization: 'Bearer good-token' })).toEqual({
      accountId: 'org_42',
    });
  });

  it('returns null when the Authorization header is absent', async () => {
    const auth = new ClerkAuthenticator(fakeVerifier);
    expect(await auth.authenticate({})).toBeNull();
  });

  it('returns null for a non-Bearer or malformed Authorization header', async () => {
    const auth = new ClerkAuthenticator(fakeVerifier);
    expect(await auth.authenticate({ authorization: 'Basic abc' })).toBeNull();
    expect(await auth.authenticate({ authorization: 'good-token' })).toBeNull();
  });

  it('returns null when the verifier rejects the token', async () => {
    const auth = new ClerkAuthenticator(fakeVerifier);
    expect(await auth.authenticate({ authorization: 'Bearer not-good' })).toBeNull();
  });
});

describe('createClerkVerifier (JWKS / org verification)', () => {
  // A locally minted RS256 key pair stands in for Clerk's signing key; its
  // public half is exposed as a one-key JWKS so verification needs no network.
  let privateKey: CryptoKey;
  let jwks: { keys: JWK[] };
  let wrongKey: CryptoKey;

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    privateKey = kp.privateKey;
    const pubJwk = await exportJWK(kp.publicKey);
    pubJwk.kid = 'test-key';
    pubJwk.alg = 'RS256';
    pubJwk.use = 'sig';
    jwks = { keys: [pubJwk] };
    const other = await generateKeyPair('RS256', { extractable: true });
    wrongKey = other.privateKey;
  });

  async function mint(
    claims: Record<string, unknown>,
    opts: { iss?: string; aud?: string; key?: CryptoKey } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? CLIENT_ID)
      .setSubject('user_123')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(opts.key ?? privateKey);
  }

  it('accepts an org-scoped ID token and resolves accountId = org_id', async () => {
    const verifier = createClerkVerifier(FRONTEND_API, CLIENT_ID, jwks);
    const token = await mint({ org_id: 'org_abc' });
    expect(await verifier.verify(token)).toEqual({ accountId: 'org_abc' });
  });

  it('rejects an org-less token (orgs-only, no sub fallback)', async () => {
    const verifier = createClerkVerifier(FRONTEND_API, CLIENT_ID, jwks);
    const token = await mint({}); // no org_id; sub is set but must NOT be used
    expect(await verifier.verify(token)).toBeNull();
  });

  it('rejects a token signed by the wrong key (bad signature)', async () => {
    const verifier = createClerkVerifier(FRONTEND_API, CLIENT_ID, jwks);
    const token = await mint({ org_id: 'org_abc' }, { key: wrongKey });
    expect(await verifier.verify(token)).toBeNull();
  });

  it('rejects a token with the wrong issuer', async () => {
    const verifier = createClerkVerifier(FRONTEND_API, CLIENT_ID, jwks);
    const token = await mint({ org_id: 'org_abc' }, { iss: 'https://evil.example' });
    expect(await verifier.verify(token)).toBeNull();
  });

  it('rejects a token with the wrong audience (different client id)', async () => {
    const verifier = createClerkVerifier(FRONTEND_API, CLIENT_ID, jwks);
    const token = await mint({ org_id: 'org_abc' }, { aud: 'some-other-client' });
    expect(await verifier.verify(token)).toBeNull();
  });

  it('rejects a garbage token', async () => {
    const verifier = createClerkVerifier(FRONTEND_API, CLIENT_ID, jwks);
    expect(await verifier.verify('not-a-jwt')).toBeNull();
  });
});
