import { type KeyObject, sign, verify } from 'node:crypto';

/** Claims carried by a control-plane-signed gateway dial-in token. */
export interface DialTokenClaims {
  tenantId: string;
  gatewayId: string;
  /** Expiry, unix seconds. */
  exp: number;
}

/**
 * Test/helper signer. The PRODUCTION signer is the control plane (Phase B);
 * the relay only ever verifies. Format: base64url(JSON claims).base64url(sig),
 * Ed25519 over the (utf-8) claims segment. No `alg` field — the algorithm is
 * fixed, which structurally avoids JWT algorithm-confusion attacks.
 */
export function signDialToken(claims: DialTokenClaims, privateKey: KeyObject): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64url');
  return `${payload}.${signature}`;
}

/** Verify signature + expiry. Returns claims on success, `null` on any failure (never throws). */
export function verifyDialToken(
  token: string,
  publicKey: KeyObject,
  nowSec: number,
): DialTokenClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return null;
  try {
    const ok = verify(null, Buffer.from(payload), publicKey, Buffer.from(sig, 'base64url'));
    if (!ok) return null;
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as DialTokenClaims;
    if (
      typeof claims.tenantId !== 'string' ||
      typeof claims.gatewayId !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= nowSec
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
