import type { WorkOS } from '@workos-inc/node';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Authenticator } from './auth.js';

/**
 * Verifies an opaque/JWT bearer token and resolves the tenant account it
 * belongs to. Kept as a tiny seam so {@link WorkosAuthenticator} is unit-testable
 * with a fake verifier — no network, no real `@workos-inc/node`/`jose` in tests —
 * while the production verifier ({@link createWorkosVerifier}) holds the
 * WorkOS-specific JWKS logic.
 */
export interface AccessTokenVerifier {
  verify(token: string): Promise<{ accountId: string } | null>;
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * Production authenticator: maps a WorkOS-issued bearer token to an `accountId`.
 *
 * The token is verified by an injected {@link AccessTokenVerifier} (the WorkOS
 * JWKS check lives in {@link createWorkosVerifier}); this class only concerns
 * itself with extracting the bearer token and surfacing the account. Header keys
 * are lowercase (Hono lower-cases them).
 */
export class WorkosAuthenticator implements Authenticator {
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
 * Build the production verifier: verify a WorkOS access-token JWT against the
 * environment's JWKS and map it to a tenant account.
 *
 * WorkOS access tokens are RS256 JWTs; we verify the signature against the
 * remote JWKS (cached by `jose`) and treat the organization (`org_id`) as the
 * tenant account, falling back to the user subject (`sub`) for personal
 * accounts. This is the ONLY place the WorkOS SDK + `jose` are used; the MC
 * sign-in flow (Phase C) sends the matching access token as a Bearer header.
 */
export function createWorkosVerifier(workos: WorkOS, clientId: string): AccessTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(clientId)));
  return {
    async verify(token: string): Promise<{ accountId: string } | null> {
      try {
        const { payload } = await jwtVerify(token, jwks);
        const accountId =
          (typeof payload.org_id === 'string' && payload.org_id) ||
          (typeof payload.sub === 'string' && payload.sub) ||
          null;
        return accountId ? { accountId } : null;
      } catch {
        return null;
      }
    },
  };
}
