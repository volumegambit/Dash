import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AssertionClaims, signAssertion } from '@dash/relay';

/** `aud` for the relay holder-of-key proof (sent as X-Gateway-Proof on dial-in). */
export const RELAY_DIAL_AUD = 'relay-dial';
/** `aud` for the control-plane refresh assertion (Bearer on POST /gw/dial-token). */
export const CP_DIAL_TOKEN_AUD = 'cp-dial-token';
/** Short assertion lifetime (seconds) — tolerates normal clock skew, bounds replay. */
export const ASSERTION_TTL_SEC = 60;

/** Filename of the persisted Ed25519 private key (mirrors `relay-gateway-id`). */
const KEY_FILENAME = 'relay-gateway-key';

/**
 * The gateway's always-on cryptographic identity. The Ed25519 private key is the
 * device identity (like an SSH host key) and never leaves the gateway; the
 * control plane and relay hold only the public key. `signProof`/`signCpAssertion`
 * mint the short-lived holder-of-key assertions used on every server call.
 */
export interface GatewayIdentity {
  /** Raw 32-byte Ed25519 public key, base64url — the `cnf` the CP stores. */
  publicKeyB64: string;
  /** A fresh `relay-dial` assertion bound to `gatewayId` (X-Gateway-Proof header). */
  signProof(gatewayId: string): string;
  /** A fresh `cp-dial-token` assertion bound to `gatewayId` (CP refresh Bearer). */
  signCpAssertion(gatewayId: string): string;
}

/** Raw base64url of an Ed25519 public key's 32-byte payload (the SPKI suffix). */
function rawPublicKeyB64(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI is a fixed 12-byte header followed by the 32-byte key.
  return Buffer.from(der.subarray(der.length - 32)).toString('base64url');
}

/**
 * Load the persisted private key, or generate + persist one on first boot. The
 * key file is written 0600 under the gateway data dir (precedent:
 * `resolveGatewayId`, index.ts). Always runs — identity is transport-independent.
 */
export async function loadOrCreateGatewayIdentity(
  dataDir: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<GatewayIdentity> {
  const keyPath = join(dataDir, KEY_FILENAME);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(await readFile(keyPath, 'utf8'));
  } catch {
    // Not created yet (or unreadable) — generate and persist a fresh key.
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    await mkdir(dataDir, { recursive: true });
    await writeFile(keyPath, pem, { mode: 0o600 });
  }
  const publicKey = createPublicKey(privateKey);
  const publicKeyB64 = rawPublicKeyB64(publicKey);

  const sign = (gatewayId: string, aud: string): string => {
    const iat = now();
    const claims: AssertionClaims = { gatewayId, aud, iat, exp: iat + ASSERTION_TTL_SEC };
    return signAssertion(claims, privateKey);
  };

  return {
    publicKeyB64,
    signProof: (gatewayId) => sign(gatewayId, RELAY_DIAL_AUD),
    signCpAssertion: (gatewayId) => sign(gatewayId, CP_DIAL_TOKEN_AUD),
  };
}
