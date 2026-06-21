import { randomBytes } from 'node:crypto';
import { safeEqual } from './auth.js';

/**
 * Per-pairing credential store for the relay.
 *
 * Each gatewayId maps to a set of valid credentials — one per paired device.
 * `provision` mints a fresh 256-bit credential; `revoke` removes one,
 * invalidating that pairing immediately. Validation is constant-time.
 *
 * In-memory by design: a self-hosted relay serves a single user's gateways, and
 * Mission Control (which holds the admin secret) re-provisions on reconnect, so
 * a restart dropping all pairings is a recoverable inconvenience — not worth the
 * standing-access risk of persisting credentials to disk.
 */
export class PairingCredentialStore {
  private readonly byGateway = new Map<string, Set<string>>();

  /**
   * Cap on stored credentials per gateway. Mission Control mints a credential
   * each time the Pair Device screen opens — even if the user never scans it —
   * so without a bound those orphans would accumulate forever. We keep the most
   * recent N (oldest evicted); N is generous for a personal multi-device setup.
   */
  constructor(private readonly maxPerGateway = 16) {}

  /** Mint and store a new credential for a gateway; returns it once. */
  provision(gatewayId: string): string {
    const credential = randomBytes(32).toString('base64url');
    let set = this.byGateway.get(gatewayId);
    if (!set) {
      set = new Set();
      this.byGateway.set(gatewayId, set);
    }
    set.add(credential);
    // Evict oldest (Sets preserve insertion order) so orphaned credentials from
    // re-opening the pairing screen can't grow without bound.
    while (set.size > this.maxPerGateway) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
    return credential;
  }

  /** Remove one credential. Returns true if it existed (was revoked). */
  revoke(gatewayId: string, credential: string): boolean {
    const set = this.byGateway.get(gatewayId);
    if (!set) return false;
    const removed = set.delete(credential);
    if (set.size === 0) this.byGateway.delete(gatewayId);
    return removed;
  }

  /** Revoke every credential for a gateway (e.g. un-pair-all). */
  revokeAll(gatewayId: string): void {
    this.byGateway.delete(gatewayId);
  }

  /** Constant-time membership check; empty/absent credentials never match. */
  isValid(gatewayId: string, credential: string): boolean {
    const set = this.byGateway.get(gatewayId);
    if (!set || credential.length === 0) return false;
    for (const known of set) {
      if (safeEqual(known, credential)) return true;
    }
    return false;
  }
}
