import { type KeyObject, createPublicKey, timingSafeEqual } from 'node:crypto';
import { verifyAssertion } from './assertion.js';
import type { CredentialStore, PairingCredentialStore } from './credential-store.js';
import { verifyDialToken } from './dial-token.js';

/**
 * Auth decisions the relay needs. The hosted implementation is holder-of-key:
 * a control-plane-signed dial token plus a fresh, gateway-signed proof. Kept as
 * an interface so the routing layer (relay-server) has no opinion on how
 * credentials are verified.
 */
export interface RelayDeps {
  /**
   * True if a gateway may register `gatewayId`. In hosted mode this requires a
   * valid CP-signed dial token (bound to `gatewayId`) AND a fresh holder-of-key
   * `proof` signed by the gateway's private key whose public half is pinned in
   * the token's `cnf` — so a token stolen at rest or in flight is inert without
   * the key. The shared-token dev modes ignore the proof.
   */
  verifyDialIn(gatewayId: string, token: string, proof: string | undefined): boolean;
  /** True if a phone may reach this gateway (its per-pairing credential). */
  pairingCredentialValid(gatewayId: string, credential: string): boolean;
}

/** Constant-time compare for equal-length strings; length mismatch is a fast false. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** SPKI DER prefix for an Ed25519 public key — prepended to a raw 32-byte key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Reconstruct an Ed25519 `KeyObject` from a `cnf` string: a raw 32-byte public
 * key, base64url. We wrap it in the fixed SPKI DER prefix so `createPublicKey`
 * accepts it. Returns `null` on any malformed input (never throws).
 */
function publicKeyFromCnf(cnf: string): KeyObject | null {
  try {
    const raw = Buffer.from(cnf, 'base64url');
    if (raw.length !== 32) return null;
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/**
 * v1 static auth: one shared relay token gates gateway registration
 * (constant-time compared); the proof is ignored (dev shared-token mode). The
 * per-pairing credential is accepted permissively — in v1 the gateway's own
 * management/chat tokens (forwarded end-to-end) are the real authentication.
 */
export function staticRelayAuth(relayToken: string): RelayDeps {
  return {
    verifyDialIn: (_gatewayId, token) => safeEqual(token, relayToken),
    pairingCredentialValid: () => true,
  };
}

/**
 * Production self-hosted auth: the shared relay token still gates gateway
 * registration (constant-time; proof ignored), and the per-pairing credential is
 * validated against a real store provisioned via the relay's admin API.
 */
export function credentialStoreAuth(relayToken: string, store: PairingCredentialStore): RelayDeps {
  return {
    verifyDialIn: (_gatewayId, token) => safeEqual(token, relayToken),
    pairingCredentialValid: (gatewayId, credential) => store.isValid(gatewayId, credential),
  };
}

/**
 * Hosted (multi-tenant SaaS) auth: holder-of-key dial-in. The dial token is a
 * control-plane-signed token bound to ONE gatewayId, pinning the gateway's
 * public key in `cnf`. The gateway must also present a fresh assertion (proof)
 * signed by the matching private key, with `aud: 'relay-dial'` and the same
 * gatewayId. Both checks are offline against the token — no shared secret, no
 * per-request network call, relay stays stateless.
 */
export function hostedRelayAuth(opts: {
  publicKey: KeyObject;
  store: CredentialStore;
  now?: () => number;
}): RelayDeps {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    verifyDialIn: (gatewayId, token, proof) => {
      if (!proof) return false;
      const nowSec = now();
      const claims = verifyDialToken(token, opts.publicKey, nowSec);
      if (claims === null || claims.gatewayId !== gatewayId) return false;
      const cnfKey = publicKeyFromCnf(claims.cnf);
      if (cnfKey === null) return false;
      const assertion = verifyAssertion(proof, cnfKey, nowSec, 'relay-dial');
      return assertion !== null && assertion.gatewayId === gatewayId;
    },
    pairingCredentialValid: (gatewayId, credential) => opts.store.isValid(gatewayId, credential),
  };
}
