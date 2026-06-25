import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { safeEqual } from './auth.js';

// `node:sqlite` is loaded through createRequire rather than a static
// `import ... from 'node:sqlite'`. The bundler (esbuild, via tsup) does not
// recognize this newer builtin and rewrites a static import to a bare `sqlite`
// specifier that Node cannot resolve at runtime — breaking every consumer of
// the built @dash/relay (e.g. the gateway's relay e2e). Routing the load
// through createRequire keeps the specifier opaque to the bundler, so the real
// `node:sqlite` builtin is resolved at runtime. The `import type` above is
// erased at build time and exists only for the static `DatabaseSync` type.
const nodeRequire = createRequire(import.meta.url);

/**
 * Shared shape for the relay's per-pairing credential stores.
 *
 * `isValid` takes only `(gatewayId, credential)` to keep the hot-path call site
 * in `relay-server.ts` unchanged — credentials are globally unique random
 * 256-bit values, so gatewayId scoping plus credential uniqueness is sufficient.
 * `tenantId` is required only on the mutating admin paths.
 */
export interface CredentialStore {
  provision(tenantId: string, gatewayId: string): string;
  revoke(tenantId: string, gatewayId: string, credential: string): boolean;
  /**
   * Revoke one credential by its hash rather than its raw value. The hash is the
   * relay's canonical base64url SHA-256 digest (see {@link hashCred}). This is
   * the path the hosted control plane uses: it stores only the hash at rest, so
   * it can never present the raw credential {@link revoke} requires. Returns true
   * if a credential was removed.
   */
  revokeByHash(tenantId: string, gatewayId: string, credentialHash: string): boolean;
  revokeAll(tenantId: string, gatewayId: string): void;
  isValid(gatewayId: string, credential: string): boolean;
}

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
 * standing-access risk of persisting credentials to disk. The hosted relay uses
 * {@link DurableCredentialStore} instead.
 */
export class PairingCredentialStore implements CredentialStore {
  private readonly byGateway = new Map<string, Set<string>>();

  /**
   * Cap on stored credentials per gateway. Mission Control mints a credential
   * each time the Pair Device screen opens — even if the user never scans it —
   * so without a bound those orphans would accumulate forever. We keep N per
   * gateway and evict by least-recently-VALIDATED (see {@link isValid}), so an
   * unscanned orphan is shed before an actively-connecting device. N is generous
   * for a personal multi-device setup.
   */
  constructor(private readonly maxPerGateway = 16) {}

  /** Mint and store a new credential for a gateway; returns it once. */
  provision(_tenantId: string, gatewayId: string): string {
    const credential = randomBytes(32).toString('base64url');
    let set = this.byGateway.get(gatewayId);
    if (!set) {
      set = new Set();
      this.byGateway.set(gatewayId, set);
    }
    set.add(credential);
    // Over the cap → evict the front, which (because isValid re-inserts on a
    // match) is the credential not validated in the longest time: orphaned
    // never-scanned codes go before devices that are actually connecting.
    while (set.size > this.maxPerGateway) {
      const lruCredential = set.values().next().value;
      if (lruCredential === undefined) break;
      set.delete(lruCredential);
    }
    return credential;
  }

  /** Remove one credential. Returns true if it existed (was revoked). */
  revoke(_tenantId: string, gatewayId: string, credential: string): boolean {
    const set = this.byGateway.get(gatewayId);
    if (!set) return false;
    const removed = set.delete(credential);
    if (set.size === 0) this.byGateway.delete(gatewayId);
    return removed;
  }

  /**
   * Remove one credential identified by its base64url SHA-256 hash. This store
   * keeps raw credentials, so it re-hashes each one (via the same {@link hashCred}
   * the durable store persists) to find the match. Returns true if one was removed.
   */
  revokeByHash(_tenantId: string, gatewayId: string, credentialHash: string): boolean {
    const set = this.byGateway.get(gatewayId);
    if (!set || credentialHash.length === 0) return false;
    for (const known of set) {
      if (hashCred(known) === credentialHash) {
        set.delete(known);
        if (set.size === 0) this.byGateway.delete(gatewayId);
        return true;
      }
    }
    return false;
  }

  /** Revoke every credential for a gateway (e.g. un-pair-all). */
  revokeAll(_tenantId: string, gatewayId: string): void {
    this.byGateway.delete(gatewayId);
  }

  /** Constant-time membership check; empty/absent credentials never match. */
  isValid(gatewayId: string, credential: string): boolean {
    const set = this.byGateway.get(gatewayId);
    if (!set || credential.length === 0) return false;
    for (const known of set) {
      if (safeEqual(known, credential)) {
        // Mark recently used: re-insert moves it to the back of the iteration
        // order, so the cap evicts least-recently-validated (orphan) codes first.
        set.delete(known);
        set.add(known);
        return true;
      }
    }
    return false;
  }
}

function hashCred(credential: string): string {
  return createHash('sha256').update(credential).digest('base64url');
}

/**
 * Durable, hashed, pure-read credential store backed by SQLite.
 *
 * The hosted relay must survive restarts (no re-provision channel) and must not
 * keep raw credentials at rest — it stores SHA-256 hashes only. `isValid` is a
 * pure read (no LRU mutation) so the hot path never writes; the per-gateway cap
 * is enforced on `provision` instead, evicting the oldest by `created_at`.
 */
export class DurableCredentialStore implements CredentialStore {
  private readonly db: DatabaseSync;
  private readonly maxPerGateway: number;

  constructor(path: string, opts: { maxPerGateway?: number } = {}) {
    this.maxPerGateway = opts.maxPerGateway ?? 16;
    const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS pairings (
      tenant_id TEXT NOT NULL, gateway_id TEXT NOT NULL,
      cred_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (gateway_id, cred_hash));`);
  }

  provision(tenantId: string, gatewayId: string): string {
    const credential = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO pairings (tenant_id, gateway_id, cred_hash, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(tenantId, gatewayId, hashCred(credential), Date.now());
    // Enforce cap: delete oldest beyond maxPerGateway for this gateway.
    // `created_at` is millisecond-resolution and rapid synchronous inserts can
    // collide in the same millisecond, so `rowid` (SQLite's monotonic insertion
    // counter) is the deterministic tiebreak — newest rowid kept, oldest evicted.
    this.db
      .prepare(
        `DELETE FROM pairings WHERE gateway_id = ? AND cred_hash NOT IN (
           SELECT cred_hash FROM pairings WHERE gateway_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      )
      .run(gatewayId, gatewayId, this.maxPerGateway);
    return credential;
  }

  revoke(_tenantId: string, gatewayId: string, credential: string): boolean {
    const r = this.db
      .prepare('DELETE FROM pairings WHERE gateway_id = ? AND cred_hash = ?')
      .run(gatewayId, hashCred(credential));
    return r.changes > 0;
  }

  /**
   * Revoke by hash. The stored `cred_hash` is already the base64url digest, so
   * the supplied hash matches it directly — no raw credential needed.
   */
  revokeByHash(_tenantId: string, gatewayId: string, credentialHash: string): boolean {
    const r = this.db
      .prepare('DELETE FROM pairings WHERE gateway_id = ? AND cred_hash = ?')
      .run(gatewayId, credentialHash);
    return r.changes > 0;
  }

  revokeAll(_tenantId: string, gatewayId: string): void {
    this.db.prepare('DELETE FROM pairings WHERE gateway_id = ?').run(gatewayId);
  }

  /** Pure read — no mutation on the hot path. Constant-time compare via hash equality. */
  isValid(gatewayId: string, credential: string): boolean {
    if (!credential) return false;
    const want = hashCred(credential);
    const rows = this.db
      .prepare('SELECT cred_hash FROM pairings WHERE gateway_id = ?')
      .all(gatewayId) as Array<{ cred_hash: string }>;
    const wantBuf = Buffer.from(want);
    let ok = false;
    for (const row of rows) {
      const got = Buffer.from(row.cred_hash);
      if (got.length === wantBuf.length && timingSafeEqual(got, wantBuf)) ok = true;
    }
    return ok;
  }
}
