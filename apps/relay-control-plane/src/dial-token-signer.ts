import type { KeyObject } from 'node:crypto';
import { signDialToken } from '@dash/relay';

/**
 * Signs gateway dial-in tokens with the control plane's Ed25519 private key.
 *
 * The relay verifies these tokens with the matching public key via
 * `@dash/relay`'s `verifyDialToken` — this signer is the control-plane half of
 * that shared contract. `tenantId == accountId` for v1; `cnf` is the gateway's
 * public key (holder-of-key binding).
 */
export class DialTokenSigner {
  readonly #privateKey: KeyObject;
  readonly #ttlSec: number;
  readonly #now: () => number;

  /**
   * @param privateKey Ed25519 private key the control plane holds.
   * @param ttlSec Token lifetime in seconds; `exp = now() + ttlSec`.
   * @param now Clock returning unix seconds; defaults to `Date.now()/1000`.
   */
  constructor(privateKey: KeyObject, ttlSec: number, now: () => number = defaultNow) {
    this.#privateKey = privateKey;
    this.#ttlSec = ttlSec;
    this.#now = now;
  }

  /** Mint a signed dial token for `gatewayId` under `tenantId`, bound to `cnf`. */
  signFor(tenantId: string, gatewayId: string, cnf: string): string {
    const exp = this.#now() + this.#ttlSec;
    return signDialToken({ tenantId, gatewayId, exp, cnf }, this.#privateKey);
  }
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}
