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
 * A paired device's credential — stored as a hash only. The raw credential is
 * returned once at provisioning time and never persisted at rest.
 */
export interface PairingRecord {
  id: string;
  gatewayId: string;
  credentialHash: string;
  deviceLabel: string | null;
  status: 'active' | 'revoked';
  createdAt: number;
}

/**
 * Source of truth for accounts → gateways → pairings. Holds only hashes of
 * pairing credentials, never the raw secret.
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
  /** Ownership-checked: only the owning account may revoke. Keeps the row. */
  revokeGateway(accountId: string, gatewayId: string): boolean;
  addPairing(r: Omit<PairingRecord, 'status' | 'createdAt'>): PairingRecord;
  listPairings(gatewayId: string): PairingRecord[];
  revokePairing(gatewayId: string, id: string): boolean;
}

interface GatewayRow {
  gateway_id: string;
  account_id: string;
  subdomain: string;
  public_key: string;
  status: string;
  created_at: number;
}

interface PairingRow {
  id: string;
  gateway_id: string;
  credential_hash: string;
  device_label: string | null;
  status: string;
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
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairings (
        id              TEXT PRIMARY KEY,
        gateway_id      TEXT NOT NULL REFERENCES gateways(gateway_id),
        credential_hash TEXT NOT NULL,
        device_label    TEXT,
        status          TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateways_account ON gateways(account_id);
      CREATE INDEX IF NOT EXISTS idx_pairings_gateway ON pairings(gateway_id);
    `);
    // Guarded migration: a dev DB created before the pubkey model lacks
    // `public_key`. Add it if absent (CREATE TABLE IF NOT EXISTS won't alter an
    // existing table). No production fleet exists, so a backfill is unnecessary.
    const cols = this.db.prepare('PRAGMA table_info(gateways)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'public_key')) {
      this.db.exec("ALTER TABLE gateways ADD COLUMN public_key TEXT NOT NULL DEFAULT ''");
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

  revokeGateway(accountId: string, gatewayId: string): boolean {
    const result = this.db
      .prepare("UPDATE gateways SET status = 'revoked' WHERE gateway_id = ? AND account_id = ?")
      .run(gatewayId, accountId);
    return result.changes > 0;
  }

  addPairing(r: Omit<PairingRecord, 'status' | 'createdAt'>): PairingRecord {
    const record: PairingRecord = {
      ...r,
      status: 'active',
      createdAt: this.now(),
    };
    this.db
      .prepare(
        'INSERT INTO pairings (id, gateway_id, credential_hash, device_label, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.id,
        record.gatewayId,
        record.credentialHash,
        record.deviceLabel,
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

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }

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
      status: row.status as PairingRecord['status'],
      createdAt: row.created_at,
    };
  }
}
