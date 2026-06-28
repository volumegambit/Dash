import { type JWK, createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import type { AccessTokenVerifier, Authenticator } from './auth.js';

/** Extract the token from an `Authorization: Bearer <token>` header value. */
function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Production authenticator: maps a Clerk-issued bearer token (the OIDC ID token)
 * to an `accountId`.
 *
 * The token is verified by an injected {@link AccessTokenVerifier} (the Clerk
 * JWKS/issuer/audience checks live in {@link createClerkVerifier}); this class
 * only concerns itself with extracting the bearer token and surfacing the
 * account. Header keys are lowercase (Hono lower-cases them).
 */
export class ClerkAuthenticator implements Authenticator {
  constructor(
    private readonly verifier: AccessTokenVerifier,
    private readonly headerName: string = 'authorization',
  ) {}

  async authenticate(
    headers: Record<string, string | undefined>,
  ): Promise<{ accountId: string } | null> {
    const token = bearer(headers[this.headerName]);
    if (!token) return null;
    return this.verifier.verify(token);
  }
}

/**
 * Build the production verifier: verify a Clerk **ID token** (RS256 JWT) against
 * the Frontend API JWKS and map it to a tenant account.
 *
 * Clerk acts as the OIDC identity provider. Mission Control signs in via the
 * loopback OAuth flow and sends the resulting `id_token` as the control-plane
 * Bearer. We verify the signature against the remote JWKS (cached by `jose`),
 * enforce `iss === https://<frontendApi>` and `aud === clientId`, and read the
 * **organization** (`org_id`) as the tenant account.
 *
 * Orgs-only: a token without an `org_id` is rejected (returns `null`). There is
 * deliberately **no `sub` fallback** — ownership is always an organization, and
 * Clerk is configured to auto-create and force-select an org so every signed-in
 * session carries one.
 *
 * @param frontendApi  The Clerk Frontend API host, e.g. `foo.clerk.accounts.dev`.
 * @param clientId     The OAuth application client id (the expected `aud`).
 * @param jwks         Optional pre-built JWK Set (for tests); defaults to the
 *                     remote `https://<frontendApi>/.well-known/jwks.json`.
 */
export function createClerkVerifier(
  frontendApi: string,
  clientId: string,
  jwks?: { keys: JWK[] },
): AccessTokenVerifier {
  const issuer = `https://${frontendApi}`;
  const keySet = jwks
    ? createLocalJWKSet(jwks)
    : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return {
    async verify(token: string): Promise<{ accountId: string } | null> {
      try {
        const { payload } = await jwtVerify(token, keySet, {
          issuer,
          audience: clientId,
        });
        // Orgs-only: require an org_id. No sub fallback.
        const orgId = typeof payload.org_id === 'string' ? payload.org_id : null;
        return orgId ? { accountId: orgId } : null;
      } catch {
        return null;
      }
    },
  };
}
