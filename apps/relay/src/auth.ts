import { timingSafeEqual } from 'node:crypto';
import type { PairingCredentialStore } from './credential-store.js';

/**
 * Auth decisions the relay needs. The real per-gateway implementation lands in
 * R10; tests inject their own. Kept as an interface so the routing layer
 * (relay-server) has no opinion on how credentials are stored.
 */
export interface RelayDeps {
  /** True if a gateway may register (the Bearer it presents on dial-in). */
  relayTokenValid(token: string): boolean;
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
    relayTokenValid: (token) => safeEqual(token, relayToken),
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
    relayTokenValid: (token) => safeEqual(token, relayToken),
    pairingCredentialValid: (gatewayId, credential) => store.isValid(gatewayId, credential),
  };
}
