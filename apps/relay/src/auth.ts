import { type KeyObject, timingSafeEqual } from 'node:crypto';
import type { CredentialStore, PairingCredentialStore } from './credential-store.js';
import { verifyDialToken } from './dial-token.js';

/**
 * Auth decisions the relay needs. The real per-gateway implementation lands in
 * R10; tests inject their own. Kept as an interface so the routing layer
 * (relay-server) has no opinion on how credentials are stored.
 */
export interface RelayDeps {
  /**
   * True if a gateway may register the given `gatewayId` with the Bearer it
   * presents on dial-in. The `gatewayId` is bound into the decision so a token
   * minted for one gateway cannot be replayed to dial in as another (hosted
   * mode); the shared-token modes ignore it.
   */
  relayTokenValid(gatewayId: string, token: string): boolean;
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

/**
 * v1 static auth: one shared relay token gates gateway registration
 * (constant-time compared). The per-pairing credential is accepted permissively
 * — in v1 the gateway's own management/chat tokens (forwarded end-to-end) are
 * the real authentication; the relay credential becomes a meaningful gate only
 * once a real per-pairing store with revocation is injected (R12 control API).
 * The relay still *calls* this on every phone request, so swapping in a strict
 * implementation enforces it with no routing-layer change.
 */
export function staticRelayAuth(relayToken: string): RelayDeps {
  return {
    relayTokenValid: (_gatewayId, token) => safeEqual(token, relayToken),
    pairingCredentialValid: () => true,
  };
}

/**
 * Production auth: the shared relay token still gates gateway registration
 * (constant-time), and the per-pairing credential is validated against a real
 * store provisioned via the relay's admin API. Revoking a credential there
 * invalidates the pairing on the next request.
 */
export function credentialStoreAuth(relayToken: string, store: PairingCredentialStore): RelayDeps {
  return {
    relayTokenValid: (_gatewayId, token) => safeEqual(token, relayToken),
    pairingCredentialValid: (gatewayId, credential) => store.isValid(gatewayId, credential),
  };
}

/**
 * Hosted (multi-tenant SaaS) auth: dial-in is a control-plane-signed token whose
 * claims bind it to ONE gatewayId; the pairing credential is validated against the
 * (control-plane-pushed) store. No shared secret, no per-request network call.
 */
export function hostedRelayAuth(opts: {
  publicKey: KeyObject;
  store: CredentialStore;
  now?: () => number;
}): RelayDeps {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    relayTokenValid: (gatewayId, token) => {
      const claims = verifyDialToken(token, opts.publicKey, now());
      return claims !== null && claims.gatewayId === gatewayId;
    },
    pairingCredentialValid: (gatewayId, credential) => opts.store.isValid(gatewayId, credential),
  };
}
