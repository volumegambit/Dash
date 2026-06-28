/**
 * Pluggable request authentication for the control plane.
 *
 * The production implementation validates a Clerk OIDC ID token (JWT) and maps
 * it to an `accountId`. That adapter ({@link ClerkAuthenticator}) is the *only*
 * place Clerk-specific logic lives, and it is wired into `main.ts`. Tests and
 * dev use {@link StubAuthenticator}, which trusts an injected header.
 */
export interface Authenticator {
  /**
   * Resolve a set of request headers to an account, or `null` when the request
   * is unauthenticated. Header keys are expected lowercase (Hono lower-cases
   * them); values may be `undefined` when the header is absent.
   */
  authenticate(headers: Record<string, string | undefined>): Promise<{ accountId: string } | null>;
}

/**
 * Verifies a bearer token and resolves the tenant account it belongs to. Kept
 * as a tiny seam so {@link ClerkAuthenticator} is unit-testable with a fake
 * verifier — no network, no real JWKS in tests — while the production verifier
 * (`createClerkVerifier`) holds the Clerk-specific JWKS/issuer/audience logic.
 */
export interface AccessTokenVerifier {
  verify(token: string): Promise<{ accountId: string } | null>;
}

/**
 * Dev/test authenticator: reads the account id straight from a trusted header
 * (default `x-test-account`). Never use in production — it performs no
 * verification.
 */
export class StubAuthenticator implements Authenticator {
  constructor(private readonly headerName: string = 'x-test-account') {}

  async authenticate(
    headers: Record<string, string | undefined>,
  ): Promise<{ accountId: string } | null> {
    const accountId = headers[this.headerName];
    if (!accountId) {
      return null;
    }
    return { accountId };
  }
}
