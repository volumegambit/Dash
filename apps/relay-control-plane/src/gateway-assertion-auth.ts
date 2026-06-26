import type { KeyObject } from 'node:crypto';
import { verifyAssertion } from '@dash/relay';
import type { DialTokenSigner } from './dial-token-signer.js';
import type { Store } from './store.js';

/** Audience namespacing the CP-refresh assertion (vs. the relay-dial proof). */
const CP_DIAL_TOKEN_AUD = 'cp-dial-token';

/** Collaborators the authenticator needs. */
export interface GatewayAssertionAuthDeps {
  store: Store;
  signer: DialTokenSigner;
  /** Parse a stored base64url public key into a KeyObject for verification. */
  verifyPublicKey: (publicKeyB64: string) => KeyObject;
  /** Clock returning unix seconds; defaults to `Date.now()/1000`. */
  now?: () => number;
}

/**
 * Authenticates the gateway-driven `POST /gw/dial-token` refresh: it reads a
 * gateway-signed assertion (`aud: 'cp-dial-token'`) from the Authorization
 * header, resolves the gateway, verifies the assertion against the STORED public
 * key, requires the gateway to be active, and mints a fresh dial token.
 *
 * Security invariants (design §5.2 / §9.7):
 *  - `tenantId` is re-derived from the stored record, NEVER from the request, so
 *    a gateway cannot migrate itself to another account.
 *  - `cnf` is the stored public key, so the refreshed token stays holder-of-key.
 *  - Every failure returns `null` (the route answers 401 disclosing nothing);
 *    revocation is implicit via the active check.
 */
export class GatewayAssertionAuthenticator {
  readonly #store: Store;
  readonly #signer: DialTokenSigner;
  readonly #verifyPublicKey: (publicKeyB64: string) => KeyObject;
  readonly #now: () => number;

  constructor(deps: GatewayAssertionAuthDeps) {
    this.#store = deps.store;
    this.#signer = deps.signer;
    this.#verifyPublicKey = deps.verifyPublicKey;
    this.#now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Mint a dial token for a valid assertion, or `null` on any failure. */
  mintDialToken(authorizationHeader: string | undefined): string | null {
    const assertion = bearer(authorizationHeader);
    if (!assertion) return null;

    // Read the gatewayId from the (unverified) claims to find the stored pubkey,
    // then verify the signature against THAT key. The verify step is what makes
    // the unverified read safe — a forged gatewayId fails verification below.
    const gatewayId = peekGatewayId(assertion);
    if (!gatewayId) return null;

    const storedPubKeyB64 = this.#store.getGatewayPublicKey(gatewayId);
    if (!storedPubKeyB64) return null;

    let pubKey: KeyObject;
    try {
      pubKey = this.#verifyPublicKey(storedPubKeyB64);
    } catch {
      return null;
    }

    const claims = verifyAssertion(assertion, pubKey, this.#now(), CP_DIAL_TOKEN_AUD);
    if (!claims || claims.gatewayId !== gatewayId) return null;

    const gateway = this.#store.getGateway(gatewayId);
    if (!gateway || gateway.status !== 'active') return null;

    // tenantId from the STORED account — never the request. cnf = stored pubkey.
    return this.#signer.signFor(gateway.accountId, gatewayId, storedPubKeyB64);
  }
}

/** Extract the token from an `Authorization: Bearer <assertion>` header value. */
function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : null;
}

/**
 * No-signature read of an assertion's `gatewayId` from its base64url claims
 * segment (the part before the dot). Returns `null` on any malformed input —
 * the value is only used to locate the stored pubkey; verification still gates
 * everything downstream.
 */
function peekGatewayId(assertion: string): string | null {
  const dot = assertion.indexOf('.');
  if (dot <= 0) return null;
  try {
    const json = JSON.parse(Buffer.from(assertion.slice(0, dot), 'base64url').toString('utf8')) as {
      gatewayId?: unknown;
    };
    return typeof json.gatewayId === 'string' ? json.gatewayId : null;
  } catch {
    return null;
  }
}
