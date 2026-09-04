import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// node:sqlite must be loaded via createRequire — a static `import 'node:sqlite'`
// breaks the tsup/esbuild build (the `node:` prefix is stripped, leaving an
// unresolvable bare `sqlite`). See apps/relay/src/credential-store.ts.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: Database } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/** A provisioned gateway: a tenant's relay endpoint with its own subdomain. */
export interface GatewayRecord {
  gatewayId: string;
  accountId: string;
  subdomain: string;
  /** The gateway's Ed25519 public key (raw, base64url) — its cryptographic identity. */
  publicKey: string;
  status: 'active' | 'revoked';
  createdAt: number;
}

/**
 * The device class a pairing was minted for. Distinguishes browser sessions
 * (revocable as their own class) from the original mobile/desktop clients.
 * Every pre-existing row predates this column and is treated as `'mobile'`.
 */
export type ClientKind = 'mobile' | 'web';

/**
 * A paired device's credential — stored as a hash only. The raw credential is
 * returned once at provisioning time and never persisted at rest.
 *
 * `'pending'` (Task 3) is a THIRD status, distinct from `'active'`/`'revoked'`:
 * a signer-gated web mint persists the row before any credential exists, and
 * `credentialHash` is a meaningless placeholder (`''`) until
 * {@link Store.activatePairing} fills it in on approval. A pending row is
 * never revoked — it is either activated or hard-deleted via
 * {@link Store.discardPendingPairing} (deny/expiry), so no dead placeholder
 * ever lingers the way a revoked row deliberately does.
 */
export interface PairingRecord {
  id: string;
  gatewayId: string;
  credentialHash: string;
  deviceLabel: string | null;
  clientKind: ClientKind;
  status: 'active' | 'revoked' | 'pending';
  createdAt: number;
}

/**
 * A registered signer device: an account-scoped Ed25519 public key an iOS/
 * signer client enrolled to co-sign gateway operations (Tasks 3/5/7). Keyed
 * by `(accountId, publicKey)` — re-registering the same key for the same
 * account returns the SAME `signerId`, never a duplicate row.
 */
export interface SignerRecord {
  signerId: string;
  accountId: string;
  /** Raw Ed25519 public key, base64url — validated by the caller (see
   *  `ProvisioningService.registerSigner`), stored verbatim here. */
  publicKey: string;
  label: string;
  createdAt: number;
}

/**
 * A short-lived, single-decision challenge minted when a signer-gated web
 * pairing is requested (Task 3). The web app renders `approvalId` as a QR
 * (`dash-approve:v1:<approvalId>`, Task 4); a signed-in iOS signer scans it,
 * fetches this record via `GET /v1/approvals/:id`, and posts an
 * Ed25519-signed decision (`POST /v1/approvals/:id/decision`, see
 * `ProvisioningService.decideApproval`) that either activates or discards the
 * associated PENDING `pairingId`.
 *
 * `status` starts `'pending'` and transitions AT MOST ONCE, to `'approved'`
 * or `'denied'` — enforced atomically by {@link Store.decideApproval}'s
 * `WHERE status = 'pending'` guard, which is what makes "single decision" a
 * store-level invariant rather than something callers have to get right.
 *
 * `expiresAt`/`createdAt` are unix MILLISECONDS, matching every other
 * timestamp in this store (contrast `apps/relay-control-plane/src/dial-token-signer.ts`,
 * whose `now()` is unix seconds — a distinct, unrelated clock).
 */
export interface ApprovalRecord {
  approvalId: string;
  accountId: string;
  gatewayId: string;
  pairingId: string;
  deviceLabel: string | null;
  status: 'pending' | 'approved' | 'denied';
  expiresAt: number;
  createdAt: number;
}

/**
 * Source of truth for accounts → gateways → pairings. Pairing credentials are
 * held as hashes only, never as the raw secret.
 *
 * ONE deliberate exception: `webChatToken` (see {@link Store.setWebChatToken}).
 * Documented in `docs/plans/2026-08-29-web-interface-design.md` (Auth &
 * Security) — a browser has no QR channel to receive the gateway's chat
 * capability, so Mission Control registers it here and the control plane hands
 * it back once per web pairing. That REQUIRES a recoverable value, so it is
 * stored as one. Scope of the trust change: this is the gateway's chat-scoped
 * mobile bearer (the same value the QR already ships to phones), never the
 * administrative management bearer, and it is readable only through an
 * account-scoped route. Reversible once the gateway can mint per-web-session
 * tokens itself.
 */
export interface Store {
  /** Idempotent: creating an existing account is a no-op. */
  createAccount(accountId: string): void;
  createGateway(r: Omit<GatewayRecord, 'status' | 'createdAt'>): GatewayRecord;
  getGateway(gatewayId: string): GatewayRecord | null;
  listGateways(accountId: string): GatewayRecord[];
  /**
   * True only when NO row exists for `label` in ANY status. A claimed label is
   * never recycled — `revokeGateway` keeps the row, so a burned label stays
   * unavailable forever (prevents subdomain takeover of a cached hostname).
   */
  isSubdomainAvailable(label: string): boolean;
  /** The stored public key for `gatewayId`, or null when unknown. */
  getGatewayPublicKey(gatewayId: string): string | null;
  /**
   * Register (or replace) the chat-scoped bearer handed to browser pairings for
   * `gatewayId`. Returns false when no such gateway exists. Ownership is NOT
   * checked here — callers go through `ProvisioningService.setWebChatToken`,
   * which enforces it, mirroring `revokePairing`'s split.
   */
  setWebChatToken(gatewayId: string, chatToken: string): boolean;
  /** The registered web chat token for `gatewayId`, or null when unregistered. */
  getWebChatToken(gatewayId: string): string | null;
  /** Ownership-checked: only the owning account may revoke. Keeps the row. */
  revokeGateway(accountId: string, gatewayId: string): boolean;
  /**
   * `status` defaults to `'active'` (every caller before Task 3 relied on
   * this) — pass `status: 'pending'` to persist a signer-gated web mint
   * before its credential exists.
   */
  addPairing(
    r: Omit<PairingRecord, 'status' | 'createdAt'> & { status?: PairingRecord['status'] },
  ): PairingRecord;
  listPairings(gatewayId: string): PairingRecord[];
  revokePairing(gatewayId: string, id: string): boolean;
  /**
   * Hard-delete a PENDING pairing row outright (never just marks it revoked,
   * unlike {@link revokePairing}). Only ever removes a row whose status is
   * still `'pending'` — a race that activates the pairing first wins, and
   * this becomes a no-op (`false`). Used when an approval is denied or
   * expires before activation, so a device that was never actually paired
   * leaves no dead row and no placeholder credential hash behind.
   */
  discardPendingPairing(gatewayId: string, id: string): boolean;
  /**
   * Approve a PENDING pairing: atomically (guarded by `status = 'pending'`)
   * sets `credentialHash` (the durable record) and persists the raw
   * `credential` (+ optional `chatToken`) as a recoverable value awaiting
   * exactly one claim via {@link claimCredential} — the same documented
   * exception as `webChatToken` (see the class doc comment) and for the same
   * reason: nothing else can hand a browser this secret out of band. Returns
   * `false` (no write) if the pairing is unknown or was not still pending —
   * callers MUST check this and roll back the just-minted relay credential
   * before treating the decision as done (see
   * `ProvisioningService.decideApproval`'s post-CVE-review handling).
   * `credentialExpiresAt` (unix ms) is the deadline {@link claimCredential}
   * enforces — an approved-but-never-claimed credential does not live at rest
   * forever.
   */
  activatePairing(
    gatewayId: string,
    id: string,
    v: {
      credentialHash: string;
      credential: string;
      chatToken: string | null;
      credentialExpiresAt: number;
    },
  ): boolean;
  /**
   * Atomically read-then-scrub the pending-claim value {@link activatePairing}
   * stored, in a single SQLite transaction (correct even across multiple
   * processes sharing one DB file, not just within one Node process). Returns
   * `null` when the pairing is unknown, the value was already claimed
   * (single-use), OR `nowMs` is at/past the stored `credentialExpiresAt` — an
   * expired-but-unclaimed value is scrubbed by this call regardless of which
   * branch triggered it (a lazy sweep, same pattern as approval expiry).
   * Callers distinguish "still pending" themselves via `listPairings`'
   * `status` before calling this.
   */
  claimCredential(
    gatewayId: string,
    id: string,
    nowMs: number,
  ): { credential: string; chatToken: string | null } | null;
  /** All signers registered for `accountId`, newest-agnostic (no ordering guarantee). */
  listSigners(accountId: string): SignerRecord[];
  /**
   * Register a signer's public key for `accountId`. Idempotent on
   * `(accountId, publicKey)`: a matching existing row keeps its `signerId` and
   * `createdAt`, only its `label` is overwritten. Otherwise a fresh row is
   * inserted with a newly minted `signerId`.
   */
  addSigner(r: { accountId: string; publicKey: string; label: string }): SignerRecord;
  /** Count of signers registered for `accountId` (0 when none). */
  signerCount(accountId: string): number;
  /** The signer, scoped to `accountId` — `null` if unknown OR owned by another account. */
  signerByAccountAndId(accountId: string, signerId: string): SignerRecord | null;
  /** Create a pending approval challenge tied to an already-persisted PENDING pairing. */
  createApproval(r: {
    approvalId: string;
    accountId: string;
    gatewayId: string;
    pairingId: string;
    deviceLabel: string | null;
    expiresAt: number;
  }): ApprovalRecord;
  /** The approval, or `null` if unknown. Never filters on status/expiry — callers decide what an old record means. */
  getApproval(approvalId: string): ApprovalRecord | null;
  /**
   * Atomically transition a PENDING approval to `'approved'` or `'denied'`.
   * Returns `false` (no write) when the approval is unknown or was already
   * decided — the `WHERE status = 'pending'` guard is what makes "exactly one
   * decision" a race-free store invariant rather than a caller convention.
   *
   * `notExpiredAsOf`, when supplied, adds `AND expires_at > ?` to the SAME
   * atomic UPDATE — the TTL check happens INSIDE the transition, not as a
   * separate read beforehand, so a real (cross-process) race between "read:
   * not yet expired" and "write: mark decided" cannot sneak a decision past
   * the deadline. Omit it for the lazy-sweep path, which deliberately marks
   * an ALREADY-known-expired approval `'denied'` regardless of the current
   * time (that IS the sweep).
   */
  decideApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    notExpiredAsOf?: number,
  ): boolean;
}

interface GatewayRow {
  gateway_id: string;
  account_id: string;
  subdomain: string;
  public_key: string;
  status: string;
  created_at: number;
  web_chat_token: string | null;
}

interface PairingRow {
  id: string;
  gateway_id: string;
  credential_hash: string;
  device_label: string | null;
  client_kind: string;
  status: string;
  created_at: number;
}

interface SignerRow {
  id: string;
  account_id: string;
  public_key: string;
  label: string | null;
  created_at: number;
}

interface ApprovalRow {
  id: string;
  account_id: string;
  gateway_id: string;
  pairing_id: string;
  device_label: string | null;
  status: string;
  expires_at: number;
  created_at: number;
}

/** SQLite-backed {@link Store}. Pass `:memory:` for tests or a file path. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS gateways (
        gateway_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(account_id),
        subdomain  TEXT NOT NULL,
        public_key TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        web_chat_token TEXT
      );
      CREATE TABLE IF NOT EXISTS pairings (
        id              TEXT PRIMARY KEY,
        gateway_id      TEXT NOT NULL REFERENCES gateways(gateway_id),
        credential_hash TEXT NOT NULL,
        device_label    TEXT,
        client_kind     TEXT NOT NULL DEFAULT 'mobile',
        status          TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signers (
        id         TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(account_id),
        public_key TEXT NOT NULL,
        label      TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(account_id, public_key)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id           TEXT PRIMARY KEY,
        account_id   TEXT NOT NULL REFERENCES accounts(account_id),
        gateway_id   TEXT NOT NULL REFERENCES gateways(gateway_id),
        -- Deliberately NOT a FOREIGN KEY: a denied/expired approval outlives
        -- its pairing row (discardPendingPairing hard-deletes it), so the
        -- approval stays a readable historical record instead of also being
        -- swept away by referential integrity.
        pairing_id   TEXT NOT NULL,
        device_label TEXT,
        status       TEXT NOT NULL,
        expires_at   INTEGER NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateways_account ON gateways(account_id);
      CREATE INDEX IF NOT EXISTS idx_pairings_gateway ON pairings(gateway_id);
      CREATE INDEX IF NOT EXISTS idx_signers_account ON signers(account_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_account ON approvals(account_id);
    `);
    // Guarded migration: a dev DB created before the pubkey model lacks
    // `public_key`. Add it if absent (CREATE TABLE IF NOT EXISTS won't alter an
    // existing table). No production fleet exists, so a backfill is unnecessary.
    const cols = this.db.prepare('PRAGMA table_info(gateways)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'public_key')) {
      this.db.exec("ALTER TABLE gateways ADD COLUMN public_key TEXT NOT NULL DEFAULT ''");
    }
    // Guarded migration: a dev DB created before browser pairings existed lacks
    // `web_chat_token`. It is nullable, so existing rows simply read as "not
    // registered" and web pairings for them are refused until MC uploads one.
    if (!cols.some((c) => c.name === 'web_chat_token')) {
      this.db.exec('ALTER TABLE gateways ADD COLUMN web_chat_token TEXT');
    }
    // Guarded migration: a dev DB created before client-kind existed lacks
    // `client_kind`. SQLite backfills every existing row with the column
    // default on ADD COLUMN, so pre-existing pairings become `'mobile'` —
    // the only device class that existed before browser pairings did.
    const pairingCols = this.db.prepare('PRAGMA table_info(pairings)').all() as Array<{
      name: string;
    }>;
    if (!pairingCols.some((c) => c.name === 'client_kind')) {
      this.db.exec("ALTER TABLE pairings ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'mobile'");
    }
    // Guarded migration: a dev DB created before the signer-approval flow
    // (Task 3) lacks the pending-claim columns — the raw credential (and its
    // paired chat token) an approved pairing holds as a recoverable value
    // awaiting exactly one claim (see `activatePairing`/`claimCredential`).
    // Both are nullable: every pre-existing (already-active, never-pending)
    // pairing simply reads as "nothing to claim".
    if (!pairingCols.some((c) => c.name === 'pending_credential')) {
      this.db.exec('ALTER TABLE pairings ADD COLUMN pending_credential TEXT');
    }
    if (!pairingCols.some((c) => c.name === 'pending_chat_token')) {
      this.db.exec('ALTER TABLE pairings ADD COLUMN pending_chat_token TEXT');
    }
    // Guarded migration (security review fix, post-Task-3): the claim
    // deadline for `pending_credential` — an approved-but-unclaimed secret
    // must not live at rest forever just because nobody ever closed the tab.
    // Nullable: rows written before this column existed (or that never went
    // through the approval flow) have nothing pending, so there is nothing to
    // expire.
    if (!pairingCols.some((c) => c.name === 'pending_credential_expires_at')) {
      this.db.exec('ALTER TABLE pairings ADD COLUMN pending_credential_expires_at INTEGER');
    }
  }

  private readonly now: () => number;

  createAccount(accountId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO accounts (account_id) VALUES (?)').run(accountId);
  }

  createGateway(r: Omit<GatewayRecord, 'status' | 'createdAt'>): GatewayRecord {
    const record: GatewayRecord = {
      ...r,
      status: 'active',
      createdAt: this.now(),
    };
    this.db
      .prepare(
        'INSERT INTO gateways (gateway_id, account_id, subdomain, public_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.gatewayId,
        record.accountId,
        record.subdomain,
        record.publicKey,
        record.status,
        record.createdAt,
      );
    return record;
  }

  getGateway(gatewayId: string): GatewayRecord | null {
    const row = this.db.prepare('SELECT * FROM gateways WHERE gateway_id = ?').get(gatewayId) as
      | GatewayRow
      | undefined;
    return row ? this.toGateway(row) : null;
  }

  listGateways(accountId: string): GatewayRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM gateways WHERE account_id = ?')
      .all(accountId) as unknown as GatewayRow[];
    return rows.map((row) => this.toGateway(row));
  }

  isSubdomainAvailable(label: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM gateways WHERE gateway_id = ?')
      .get(label) as unknown;
    return row === undefined;
  }

  getGatewayPublicKey(gatewayId: string): string | null {
    const row = this.db
      .prepare('SELECT public_key FROM gateways WHERE gateway_id = ?')
      .get(gatewayId) as { public_key: string } | undefined;
    return row ? row.public_key : null;
  }

  setWebChatToken(gatewayId: string, chatToken: string): boolean {
    const result = this.db
      .prepare('UPDATE gateways SET web_chat_token = ? WHERE gateway_id = ?')
      .run(chatToken, gatewayId);
    return result.changes > 0;
  }

  getWebChatToken(gatewayId: string): string | null {
    const row = this.db
      .prepare('SELECT web_chat_token FROM gateways WHERE gateway_id = ?')
      .get(gatewayId) as { web_chat_token: string | null } | undefined;
    return row?.web_chat_token ?? null;
  }

  revokeGateway(accountId: string, gatewayId: string): boolean {
    const result = this.db
      .prepare("UPDATE gateways SET status = 'revoked' WHERE gateway_id = ? AND account_id = ?")
      .run(gatewayId, accountId);
    return result.changes > 0;
  }

  addPairing(
    r: Omit<PairingRecord, 'status' | 'createdAt'> & { status?: PairingRecord['status'] },
  ): PairingRecord {
    const record: PairingRecord = {
      ...r,
      status: r.status ?? 'active',
      createdAt: this.now(),
    };
    this.db
      .prepare(
        'INSERT INTO pairings (id, gateway_id, credential_hash, device_label, client_kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.id,
        record.gatewayId,
        record.credentialHash,
        record.deviceLabel,
        record.clientKind,
        record.status,
        record.createdAt,
      );
    return record;
  }

  listPairings(gatewayId: string): PairingRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM pairings WHERE gateway_id = ?')
      .all(gatewayId) as unknown as PairingRow[];
    return rows.map((row) => this.toPairing(row));
  }

  revokePairing(gatewayId: string, id: string): boolean {
    const result = this.db
      .prepare("UPDATE pairings SET status = 'revoked' WHERE id = ? AND gateway_id = ?")
      .run(id, gatewayId);
    return result.changes > 0;
  }

  discardPendingPairing(gatewayId: string, id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM pairings WHERE id = ? AND gateway_id = ? AND status = 'pending'")
      .run(id, gatewayId);
    return result.changes > 0;
  }

  activatePairing(
    gatewayId: string,
    id: string,
    v: {
      credentialHash: string;
      credential: string;
      chatToken: string | null;
      credentialExpiresAt: number;
    },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE pairings
         SET status = 'active', credential_hash = ?, pending_credential = ?, pending_chat_token = ?,
             pending_credential_expires_at = ?
         WHERE id = ? AND gateway_id = ? AND status = 'pending'`,
      )
      .run(v.credentialHash, v.credential, v.chatToken, v.credentialExpiresAt, id, gatewayId);
    return result.changes > 0;
  }

  claimCredential(
    gatewayId: string,
    id: string,
    nowMs: number,
  ): { credential: string; chatToken: string | null } | null {
    // Read-then-scrub inside an explicit transaction: `BEGIN IMMEDIATE`
    // acquires the write lock up front, so a second connection (a different
    // process sharing this DB file, not just a second call from this one)
    // cannot observe or claim the same value between our SELECT and UPDATE.
    // (Plain UPDATE ... RETURNING was considered and rejected here: SQLite's
    // RETURNING reflects the POST-update row, so `SET pending_credential =
    // NULL ... RETURNING pending_credential` returns NULL, not the value we
    // need to hand back — confirmed empirically, not just by inference.)
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          'SELECT pending_credential, pending_chat_token, pending_credential_expires_at FROM pairings WHERE id = ? AND gateway_id = ?',
        )
        .get(id, gatewayId) as
        | {
            pending_credential: string | null;
            pending_chat_token: string | null;
            pending_credential_expires_at: number | null;
          }
        | undefined;
      if (!row || row.pending_credential === null) {
        this.db.exec('COMMIT');
        return null;
      }
      // Scrub immediately (inside the same transaction) so a second call —
      // concurrent, or after this returns — sees nothing. This UPDATE, not a
      // separate "mark claimed" flag, IS the single-use enforcement. It runs
      // unconditionally here, even for an expired value: an
      // approved-but-never-claimed credential must not sit at rest forever,
      // so "claim after the deadline" IS the sweep, not a separate job.
      this.db
        .prepare(
          'UPDATE pairings SET pending_credential = NULL, pending_chat_token = NULL, pending_credential_expires_at = NULL WHERE id = ? AND gateway_id = ?',
        )
        .run(id, gatewayId);
      this.db.exec('COMMIT');
      if (
        row.pending_credential_expires_at !== null &&
        row.pending_credential_expires_at <= nowMs
      ) {
        return null;
      }
      return { credential: row.pending_credential, chatToken: row.pending_chat_token };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listSigners(accountId: string): SignerRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM signers WHERE account_id = ?')
      .all(accountId) as unknown as SignerRow[];
    return rows.map((row) => this.toSigner(row));
  }

  addSigner(r: { accountId: string; publicKey: string; label: string }): SignerRecord {
    const existing = this.db
      .prepare('SELECT * FROM signers WHERE account_id = ? AND public_key = ?')
      .get(r.accountId, r.publicKey) as SignerRow | undefined;
    if (existing) {
      this.db.prepare('UPDATE signers SET label = ? WHERE id = ?').run(r.label, existing.id);
      return this.toSigner({ ...existing, label: r.label });
    }
    const record: SignerRecord = {
      signerId: `sg-${randomBytes(6).toString('hex')}`,
      accountId: r.accountId,
      publicKey: r.publicKey,
      label: r.label,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        'INSERT INTO signers (id, account_id, public_key, label, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(record.signerId, record.accountId, record.publicKey, record.label, record.createdAt);
    return record;
  }

  signerCount(accountId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM signers WHERE account_id = ?')
      .get(accountId) as { n: number };
    return row.n;
  }

  signerByAccountAndId(accountId: string, signerId: string): SignerRecord | null {
    const row = this.db
      .prepare('SELECT * FROM signers WHERE id = ? AND account_id = ?')
      .get(signerId, accountId) as SignerRow | undefined;
    return row ? this.toSigner(row) : null;
  }

  createApproval(r: {
    approvalId: string;
    accountId: string;
    gatewayId: string;
    pairingId: string;
    deviceLabel: string | null;
    expiresAt: number;
  }): ApprovalRecord {
    const record: ApprovalRecord = {
      ...r,
      status: 'pending',
      createdAt: this.now(),
    };
    this.db
      .prepare(
        'INSERT INTO approvals (id, account_id, gateway_id, pairing_id, device_label, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.approvalId,
        record.accountId,
        record.gatewayId,
        record.pairingId,
        record.deviceLabel,
        record.status,
        record.expiresAt,
        record.createdAt,
      );
    return record;
  }

  getApproval(approvalId: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
      | ApprovalRow
      | undefined;
    return row ? this.toApproval(row) : null;
  }

  decideApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    notExpiredAsOf?: number,
  ): boolean {
    if (notExpiredAsOf === undefined) {
      const result = this.db
        .prepare("UPDATE approvals SET status = ? WHERE id = ? AND status = 'pending'")
        .run(decision, approvalId);
      return result.changes > 0;
    }
    const result = this.db
      .prepare(
        "UPDATE approvals SET status = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
      )
      .run(decision, approvalId, notExpiredAsOf);
    return result.changes > 0;
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }

  /**
   * Project a row onto the public {@link GatewayRecord}. `web_chat_token` is
   * deliberately omitted: `GET /v1/gateways` serializes these records verbatim,
   * and the token must only ever leave through a web pairing.
   */
  private toGateway(row: GatewayRow): GatewayRecord {
    return {
      gatewayId: row.gateway_id,
      accountId: row.account_id,
      subdomain: row.subdomain,
      publicKey: row.public_key,
      status: row.status as GatewayRecord['status'],
      createdAt: row.created_at,
    };
  }

  private toPairing(row: PairingRow): PairingRecord {
    return {
      id: row.id,
      gatewayId: row.gateway_id,
      credentialHash: row.credential_hash,
      deviceLabel: row.device_label,
      clientKind: row.client_kind as ClientKind,
      status: row.status as PairingRecord['status'],
      createdAt: row.created_at,
    };
  }

  private toSigner(row: SignerRow): SignerRecord {
    return {
      signerId: row.id,
      accountId: row.account_id,
      publicKey: row.public_key,
      label: row.label ?? '',
      createdAt: row.created_at,
    };
  }

  private toApproval(row: ApprovalRow): ApprovalRecord {
    return {
      approvalId: row.id,
      accountId: row.account_id,
      gatewayId: row.gateway_id,
      pairingId: row.pairing_id,
      deviceLabel: row.device_label,
      status: row.status as ApprovalRecord['status'],
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }
}
