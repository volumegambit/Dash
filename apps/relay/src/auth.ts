import { timingSafeEqual } from 'node:crypto';

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
 * v1 static auth: one shared relay token gates gateway registration. The
 * per-pairing credential check accepts any non-empty value until R10 wires real
 * per-gateway credentials with revocation.
 */
export function staticRelayAuth(relayToken: string): RelayDeps {
  return {
    relayTokenValid: (token) => safeEqual(token, relayToken),
    pairingCredentialValid: (_gatewayId, credential) => credential.length > 0,
  };
}
