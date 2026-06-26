import { type KeyObject, createPublicKey, sign, verify } from 'node:crypto';

/**
 * Claims carried by a short-lived gateway-signed assertion. Proves possession of
 * the gateway's private key on every gateway→server call. `aud` namespaces the
 * two uses — `'relay-dial'` (holder-of-key proof to the relay) and
 * `'cp-dial-token'` (refresh to the control plane) — so a proof minted for one
 * cannot be replayed at the other. `exp` is short (~30–60 s).
 */
export interface AssertionClaims {
  gatewayId: string;
  aud: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
}

/**
 * Decode a raw 32-byte base64url Ed25519 public key (the dial-token `cnf` form)
 * into a verifiable `KeyObject` via JWK. Returns `null` if the string is not a
 * valid key (never throws).
 */
function rawEd25519ToKeyObject(raw: string): KeyObject | null {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
  } catch {
    return null;
  }
}

/**
 * Sign an assertion with the gateway's Ed25519 private key. Same wire format as
 * the dial token: base64url(JSON claims).base64url(sig), Ed25519 over the
 * (utf-8) claims segment. No `alg` field — the algorithm is fixed, which
 * structurally avoids JWT algorithm-confusion attacks.
 */
export function signAssertion(claims: AssertionClaims, privateKey: KeyObject): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64url');
  return `${payload}.${signature}`;
}

/**
 * Verify signature + `aud` + expiry. `publicKey` may be a `KeyObject` (the CP
 * holds the gateway pubkey as a real key) or a raw base64url Ed25519 string (the
 * relay reads it from the dial-token `cnf`); a string is decoded internally.
 * Returns claims on success, `null` on any failure (undecodable key, bad
 * signature, wrong `aud`, `exp <= nowSec`, or malformed). Never throws.
 */
export function verifyAssertion(
  token: string,
  publicKey: string | KeyObject,
  nowSec: number,
  expectedAud: string,
): AssertionClaims | null {
  const key = typeof publicKey === 'string' ? rawEd25519ToKeyObject(publicKey) : publicKey;
  if (key === null) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payload || !sig) return null;
  try {
    const ok = verify(null, Buffer.from(payload), key, Buffer.from(sig, 'base64url'));
    if (!ok) return null;
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as AssertionClaims;
    if (
      typeof claims.gatewayId !== 'string' ||
      typeof claims.aud !== 'string' ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number' ||
      claims.aud !== expectedAud ||
      claims.exp <= nowSec
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
