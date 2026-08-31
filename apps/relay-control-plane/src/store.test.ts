import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from './store.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: Database } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

describe('SqliteStore', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('accounts + gateways', () => {
    it('creates an account idempotently', () => {
      store.createAccount('acct-1');
      // Calling again must not throw.
      store.createAccount('acct-1');
    });

    it('creates a gateway and reads it back', () => {
      store.createAccount('acct-1');
      const created = store.createGateway({
        gatewayId: 'gw-aaa',
        accountId: 'acct-1',
        subdomain: 'gw-aaa.relay.local',
        publicKey: 'pk-aaa',
      });
      expect(created.gatewayId).toBe('gw-aaa');
      expect(created.accountId).toBe('acct-1');
      expect(created.subdomain).toBe('gw-aaa.relay.local');
      expect(created.publicKey).toBe('pk-aaa');
      expect(created.status).toBe('active');
      expect(typeof created.createdAt).toBe('number');

      const fetched = store.getGateway('gw-aaa');
      expect(fetched).toEqual(created);
    });

    it('returns null for an unknown gateway', () => {
      expect(store.getGateway('gw-missing')).toBeNull();
    });

    it('lists gateways scoped to an account', () => {
      store.createAccount('acct-1');
      store.createAccount('acct-2');
      store.createGateway({
        gatewayId: 'gw-1',
        accountId: 'acct-1',
        subdomain: 'gw-1.z',
        publicKey: 'pk-1',
      });
      store.createGateway({
        gatewayId: 'gw-2',
        accountId: 'acct-1',
        subdomain: 'gw-2.z',
        publicKey: 'pk-2',
      });
      store.createGateway({
        gatewayId: 'gw-3',
        accountId: 'acct-2',
        subdomain: 'gw-3.z',
        publicKey: 'pk-3',
      });

      const a1 = store.listGateways('acct-1');
      expect(a1.map((g) => g.gatewayId).sort()).toEqual(['gw-1', 'gw-2']);
      const a2 = store.listGateways('acct-2');
      expect(a2.map((g) => g.gatewayId)).toEqual(['gw-3']);
    });
  });

  describe('revokeGateway (ownership-scoped)', () => {
    beforeEach(() => {
      store.createAccount('acct-A');
      store.createAccount('acct-B');
      store.createGateway({
        gatewayId: 'gw-A',
        accountId: 'acct-A',
        subdomain: 'gw-A.z',
        publicKey: 'pk-A',
      });
    });

    it('revokes a gateway owned by the account', () => {
      expect(store.revokeGateway('acct-A', 'gw-A')).toBe(true);
      expect(store.getGateway('gw-A')?.status).toBe('revoked');
    });

    it('refuses to revoke another account gateway and leaves it untouched', () => {
      expect(store.revokeGateway('acct-B', 'gw-A')).toBe(false);
      expect(store.getGateway('gw-A')?.status).toBe('active');
    });

    it('returns false for an unknown gateway', () => {
      expect(store.revokeGateway('acct-A', 'gw-nope')).toBe(false);
    });
  });

  describe('pairings', () => {
    beforeEach(() => {
      store.createAccount('acct-1');
      store.createGateway({
        gatewayId: 'gw-1',
        accountId: 'acct-1',
        subdomain: 'gw-1.z',
        publicKey: 'pk-1',
      });
    });

    it('adds a pairing storing the hash and a device label', () => {
      const added = store.addPairing({
        id: 'pair-1',
        gatewayId: 'gw-1',
        credentialHash: 'deadbeefhash',
        deviceLabel: 'iPhone',
        clientKind: 'mobile',
      });
      expect(added.id).toBe('pair-1');
      expect(added.gatewayId).toBe('gw-1');
      expect(added.credentialHash).toBe('deadbeefhash');
      expect(added.deviceLabel).toBe('iPhone');
      expect(added.clientKind).toBe('mobile');
      expect(added.status).toBe('active');
      expect(typeof added.createdAt).toBe('number');
    });

    it('stores only the hash — no raw credential leaks into the record', () => {
      const added = store.addPairing({
        id: 'pair-1',
        gatewayId: 'gw-1',
        credentialHash: 'hash-only',
        deviceLabel: null,
        clientKind: 'mobile',
      });
      // The store takes a hash; the record carries exactly that and nothing
      // resembling a raw secret field.
      expect(added.credentialHash).toBe('hash-only');
      expect(JSON.stringify(added)).not.toContain('credential"');
    });

    it('stores a web client kind', () => {
      const added = store.addPairing({
        id: 'pair-web',
        gatewayId: 'gw-1',
        credentialHash: 'h-web',
        deviceLabel: 'Safari on iPhone',
        clientKind: 'web',
      });
      expect(added.clientKind).toBe('web');
      expect(store.listPairings('gw-1').find((p) => p.id === 'pair-web')?.clientKind).toBe('web');
    });

    it('allows a null device label', () => {
      const added = store.addPairing({
        id: 'pair-2',
        gatewayId: 'gw-1',
        credentialHash: 'h2',
        deviceLabel: null,
        clientKind: 'mobile',
      });
      expect(added.deviceLabel).toBeNull();
    });

    it('lists pairings for a gateway', () => {
      store.addPairing({
        id: 'p1',
        gatewayId: 'gw-1',
        credentialHash: 'h1',
        deviceLabel: 'a',
        clientKind: 'mobile',
      });
      store.addPairing({
        id: 'p2',
        gatewayId: 'gw-1',
        credentialHash: 'h2',
        deviceLabel: 'b',
        clientKind: 'mobile',
      });
      const list = store.listPairings('gw-1');
      expect(list.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    });

    it('revokes a pairing', () => {
      store.addPairing({
        id: 'p1',
        gatewayId: 'gw-1',
        credentialHash: 'h1',
        deviceLabel: null,
        clientKind: 'mobile',
      });
      expect(store.revokePairing('gw-1', 'p1')).toBe(true);
      const list = store.listPairings('gw-1');
      expect(list[0]?.status).toBe('revoked');
    });

    it('returns false revoking an unknown pairing', () => {
      expect(store.revokePairing('gw-1', 'missing')).toBe(false);
    });
  });

  describe('persistence across reopen', () => {
    it('round-trips records through a temp-file path', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cp-store-'));
      const dbPath = join(dir, 'cp.db');
      try {
        const first = new SqliteStore(dbPath);
        first.createAccount('acct-1');
        first.createGateway({
          gatewayId: 'gw-1',
          accountId: 'acct-1',
          subdomain: 'gw-1.z',
          publicKey: 'pk-1',
        });
        first.addPairing({
          id: 'p1',
          gatewayId: 'gw-1',
          credentialHash: 'h1',
          deviceLabel: 'X',
          clientKind: 'mobile',
        });
        first.close();

        const reopened = new SqliteStore(dbPath);
        expect(reopened.getGateway('gw-1')?.accountId).toBe('acct-1');
        expect(reopened.listPairings('gw-1').map((p) => p.id)).toEqual(['p1']);
        reopened.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('backfills client_kind as mobile for pairing rows written before the column existed', () => {
      const dir = mkdtempSync(join(tmpdir(), 'cp-store-migrate-'));
      const dbPath = join(dir, 'cp.db');
      try {
        // Hand-build the pre-migration schema (no client_kind column) and seed
        // a row directly, bypassing SqliteStore so it can't add the column.
        const raw: DatabaseSync = new Database(dbPath);
        raw.exec(`
          CREATE TABLE accounts (account_id TEXT PRIMARY KEY);
          CREATE TABLE gateways (
            gateway_id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(account_id),
            subdomain  TEXT NOT NULL,
            public_key TEXT NOT NULL DEFAULT '',
            status     TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE pairings (
            id              TEXT PRIMARY KEY,
            gateway_id      TEXT NOT NULL REFERENCES gateways(gateway_id),
            credential_hash TEXT NOT NULL,
            device_label    TEXT,
            status          TEXT NOT NULL,
            created_at      INTEGER NOT NULL
          );
        `);
        raw.prepare('INSERT INTO accounts (account_id) VALUES (?)').run('acct-1');
        raw
          .prepare(
            'INSERT INTO gateways (gateway_id, account_id, subdomain, public_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run('gw-old', 'acct-1', 'gw-old.z', 'pk-old', 'active', 1);
        raw
          .prepare(
            'INSERT INTO pairings (id, gateway_id, credential_hash, device_label, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run('p-old', 'gw-old', 'h-old', 'legacy-device', 'active', 1);
        raw.close();

        const migrated = new SqliteStore(dbPath);
        const pairings = migrated.listPairings('gw-old');
        expect(pairings).toHaveLength(1);
        expect(pairings[0]?.clientKind).toBe('mobile');
        // The same open also adds web_chat_token to the legacy gateways table.
        expect(migrated.getWebChatToken('gw-old')).toBeNull();
        expect(migrated.setWebChatToken('gw-old', 'chat-token')).toBe(true);
        expect(migrated.getWebChatToken('gw-old')).toBe('chat-token');
        // The legacy DB predates signers entirely — CREATE TABLE IF NOT EXISTS
        // creates it fresh on open, so it is immediately usable.
        expect(migrated.listSigners('acct-1')).toEqual([]);
        const signer = migrated.addSigner({
          accountId: 'acct-1',
          publicKey: 'pk-new',
          label: 'new device',
        });
        expect(migrated.listSigners('acct-1')).toEqual([signer]);
        migrated.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('isSubdomainAvailable + getGatewayPublicKey (never recycled)', () => {
    beforeEach(() => {
      store.createAccount('acct-1');
    });

    it('reports an unused label available', () => {
      expect(store.isSubdomainAvailable('alice-mbp')).toBe(true);
    });

    it('reports a claimed label unavailable while active', () => {
      store.createGateway({
        gatewayId: 'alice-mbp',
        accountId: 'acct-1',
        subdomain: 'alice-mbp.relay.local',
        publicKey: 'pk-alice',
      });
      expect(store.isSubdomainAvailable('alice-mbp')).toBe(false);
    });

    it('keeps a revoked label unavailable — never recycled', () => {
      store.createGateway({
        gatewayId: 'alice-mbp',
        accountId: 'acct-1',
        subdomain: 'alice-mbp.relay.local',
        publicKey: 'pk-alice',
      });
      expect(store.revokeGateway('acct-1', 'alice-mbp')).toBe(true);
      expect(store.getGateway('alice-mbp')?.status).toBe('revoked');
      // The row persists, so the label can never be re-claimed.
      expect(store.isSubdomainAvailable('alice-mbp')).toBe(false);
    });

    it('stores and returns a per-gateway web chat token, null until registered', () => {
      store.createGateway({
        gatewayId: 'alice-mbp',
        accountId: 'acct-1',
        subdomain: 'alice-mbp.relay.local',
        publicKey: 'pk-alice',
      });
      expect(store.getWebChatToken('alice-mbp')).toBeNull();
      expect(store.setWebChatToken('alice-mbp', 'chat-token-1')).toBe(true);
      expect(store.getWebChatToken('alice-mbp')).toBe('chat-token-1');
      // Idempotent re-registration overwrites (MC re-uploads on enroll refresh).
      expect(store.setWebChatToken('alice-mbp', 'chat-token-2')).toBe(true);
      expect(store.getWebChatToken('alice-mbp')).toBe('chat-token-2');
    });

    it('refuses to set a web chat token for an unknown gateway', () => {
      expect(store.setWebChatToken('gw-missing', 'chat-token')).toBe(false);
      expect(store.getWebChatToken('gw-missing')).toBeNull();
    });

    it('never exposes the web chat token through gateway records', () => {
      store.createGateway({
        gatewayId: 'alice-mbp',
        accountId: 'acct-1',
        subdomain: 'alice-mbp.relay.local',
        publicKey: 'pk-alice',
      });
      store.setWebChatToken('alice-mbp', 'chat-token-1');
      // GET /v1/gateways serializes these records verbatim — the token must not
      // ride along, or every signed-in browser would get it without a pairing.
      expect(JSON.stringify(store.getGateway('alice-mbp'))).not.toContain('chat-token-1');
      expect(JSON.stringify(store.listGateways('acct-1'))).not.toContain('chat-token-1');
    });

    it('returns the stored public key, or null for an unknown gateway', () => {
      store.createGateway({
        gatewayId: 'alice-mbp',
        accountId: 'acct-1',
        subdomain: 'alice-mbp.relay.local',
        publicKey: 'pk-alice',
      });
      expect(store.getGatewayPublicKey('alice-mbp')).toBe('pk-alice');
      expect(store.getGatewayPublicKey('gw-missing')).toBeNull();
    });
  });

  describe('signers', () => {
    beforeEach(() => {
      store.createAccount('acct-1');
      store.createAccount('acct-2');
    });

    it('adds a signer and reads it back', () => {
      const added = store.addSigner({
        accountId: 'acct-1',
        publicKey: 'pk-signer-1',
        label: 'iPhone 15',
      });
      expect(added.signerId).toMatch(/^sg-[0-9a-f]{12}$/);
      expect(added.accountId).toBe('acct-1');
      expect(added.publicKey).toBe('pk-signer-1');
      expect(added.label).toBe('iPhone 15');
      expect(typeof added.createdAt).toBe('number');
    });

    it('is idempotent per (accountId, publicKey): same key returns the same id, label updated', () => {
      const first = store.addSigner({
        accountId: 'acct-1',
        publicKey: 'pk-signer-1',
        label: 'iPhone 15',
      });
      const second = store.addSigner({
        accountId: 'acct-1',
        publicKey: 'pk-signer-1',
        label: 'iPhone 15 Pro',
      });
      expect(second.signerId).toBe(first.signerId);
      expect(second.label).toBe('iPhone 15 Pro');
      expect(second.createdAt).toBe(first.createdAt);
      expect(store.listSigners('acct-1')).toHaveLength(1);
      expect(store.listSigners('acct-1')[0]?.label).toBe('iPhone 15 Pro');
    });

    it('allows the SAME public key to be registered independently under different accounts', () => {
      const a1 = store.addSigner({ accountId: 'acct-1', publicKey: 'pk-shared', label: 'A' });
      const a2 = store.addSigner({ accountId: 'acct-2', publicKey: 'pk-shared', label: 'B' });
      expect(a1.signerId).not.toBe(a2.signerId);
      expect(store.listSigners('acct-1').map((s) => s.signerId)).toEqual([a1.signerId]);
      expect(store.listSigners('acct-2').map((s) => s.signerId)).toEqual([a2.signerId]);
    });

    it('lists signers scoped to an account', () => {
      store.addSigner({ accountId: 'acct-1', publicKey: 'pk-1', label: 'a' });
      store.addSigner({ accountId: 'acct-1', publicKey: 'pk-2', label: 'b' });
      store.addSigner({ accountId: 'acct-2', publicKey: 'pk-3', label: 'c' });

      expect(
        store
          .listSigners('acct-1')
          .map((s) => s.publicKey)
          .sort(),
      ).toEqual(['pk-1', 'pk-2']);
      expect(store.listSigners('acct-2').map((s) => s.publicKey)).toEqual(['pk-3']);
    });

    it('returns an empty list for an account with no signers', () => {
      expect(store.listSigners('acct-1')).toEqual([]);
    });

    it('counts signers per account', () => {
      expect(store.signerCount('acct-1')).toBe(0);
      store.addSigner({ accountId: 'acct-1', publicKey: 'pk-1', label: 'a' });
      store.addSigner({ accountId: 'acct-1', publicKey: 'pk-2', label: 'b' });
      store.addSigner({ accountId: 'acct-2', publicKey: 'pk-3', label: 'c' });
      expect(store.signerCount('acct-1')).toBe(2);
      expect(store.signerCount('acct-2')).toBe(1);
    });

    it('signerByAccountAndId returns the record for the owner, null for a wrong account or unknown id', () => {
      const added = store.addSigner({ accountId: 'acct-1', publicKey: 'pk-1', label: 'a' });
      expect(store.signerByAccountAndId('acct-1', added.signerId)).toEqual(added);
      expect(store.signerByAccountAndId('acct-2', added.signerId)).toBeNull();
      expect(store.signerByAccountAndId('acct-1', 'sg-missing')).toBeNull();
    });
  });

  describe('approvals + pending pairing claim (Task 3)', () => {
    beforeEach(() => {
      store.createAccount('acct-1');
      store.createGateway({
        gatewayId: 'alice-mbp',
        accountId: 'acct-1',
        subdomain: 'alice-mbp.relay.local',
        publicKey: 'pk-alice',
      });
    });

    function addPendingPairing(id = 'pr-pending-1') {
      return store.addPairing({
        id,
        gatewayId: 'alice-mbp',
        credentialHash: '',
        deviceLabel: 'Safari',
        clientKind: 'web',
        status: 'pending',
      });
    }

    it('addPairing accepts an explicit pending status (defaults to active otherwise)', () => {
      const pending = addPendingPairing();
      expect(pending.status).toBe('pending');
      const active = store.addPairing({
        id: 'pr-active-1',
        gatewayId: 'alice-mbp',
        credentialHash: 'hash',
        deviceLabel: null,
        clientKind: 'mobile',
      });
      expect(active.status).toBe('active');
    });

    it('createApproval + getApproval round-trips a pending approval', () => {
      addPendingPairing();
      const created = store.createApproval({
        approvalId: 'ap-1',
        accountId: 'acct-1',
        gatewayId: 'alice-mbp',
        pairingId: 'pr-pending-1',
        deviceLabel: 'Safari',
        expiresAt: 5000,
      });
      expect(created).toEqual({
        approvalId: 'ap-1',
        accountId: 'acct-1',
        gatewayId: 'alice-mbp',
        pairingId: 'pr-pending-1',
        deviceLabel: 'Safari',
        status: 'pending',
        expiresAt: 5000,
        createdAt: expect.any(Number),
      });
      expect(store.getApproval('ap-1')).toEqual(created);
    });

    it('getApproval returns null for an unknown id', () => {
      expect(store.getApproval('ap-missing')).toBeNull();
    });

    it('decideApproval transitions a pending approval exactly once', () => {
      addPendingPairing();
      store.createApproval({
        approvalId: 'ap-1',
        accountId: 'acct-1',
        gatewayId: 'alice-mbp',
        pairingId: 'pr-pending-1',
        deviceLabel: 'Safari',
        expiresAt: 5000,
      });

      expect(store.decideApproval('ap-1', 'approved')).toBe(true);
      expect(store.getApproval('ap-1')?.status).toBe('approved');

      // Already decided — the second call is a no-op (false), not a second write.
      expect(store.decideApproval('ap-1', 'denied')).toBe(false);
      expect(store.getApproval('ap-1')?.status).toBe('approved');
    });

    it('decideApproval returns false for an unknown approval', () => {
      expect(store.decideApproval('ap-missing', 'denied')).toBe(false);
    });

    it('decideApproval(notExpiredAsOf) succeeds when strictly before the deadline and fails at/after it', () => {
      addPendingPairing();
      store.createApproval({
        approvalId: 'ap-1',
        accountId: 'acct-1',
        gatewayId: 'alice-mbp',
        pairingId: 'pr-pending-1',
        deviceLabel: 'Safari',
        expiresAt: 5000,
      });

      // At/after the deadline: the atomic guard refuses the write outright,
      // and does NOT decide the approval (still pending afterward).
      expect(store.decideApproval('ap-1', 'approved', 5000)).toBe(false);
      expect(store.getApproval('ap-1')?.status).toBe('pending');

      // Strictly before the deadline: succeeds.
      expect(store.decideApproval('ap-1', 'approved', 4999)).toBe(true);
      expect(store.getApproval('ap-1')?.status).toBe('approved');
    });

    it('discardPendingPairing hard-deletes a pending pairing row', () => {
      addPendingPairing();
      expect(store.listPairings('alice-mbp')).toHaveLength(1);

      expect(store.discardPendingPairing('alice-mbp', 'pr-pending-1')).toBe(true);
      expect(store.listPairings('alice-mbp')).toEqual([]);
    });

    it('discardPendingPairing refuses to touch a non-pending pairing', () => {
      const active = store.addPairing({
        id: 'pr-active-1',
        gatewayId: 'alice-mbp',
        credentialHash: 'hash',
        deviceLabel: null,
        clientKind: 'web',
      });
      expect(active.status).toBe('active');

      expect(store.discardPendingPairing('alice-mbp', 'pr-active-1')).toBe(false);
      expect(store.listPairings('alice-mbp')).toHaveLength(1);
    });

    it('discardPendingPairing returns false for an unknown pairing', () => {
      expect(store.discardPendingPairing('alice-mbp', 'pr-missing')).toBe(false);
    });

    // A claim deadline far past any test's clock — used by tests that don't
    // care about TTL enforcement, so the credential is always claimable.
    const FAR_FUTURE_MS = 9_999_999_999;

    it('activatePairing transitions a pending pairing to active and stores the pending-claim value', () => {
      addPendingPairing();

      const ok = store.activatePairing('alice-mbp', 'pr-pending-1', {
        credentialHash: 'hash-1',
        credential: 'raw-credential-1',
        chatToken: 'chat-1',
        credentialExpiresAt: FAR_FUTURE_MS,
      });
      expect(ok).toBe(true);

      const pairing = store.listPairings('alice-mbp')[0];
      expect(pairing.status).toBe('active');
      expect(pairing.credentialHash).toBe('hash-1');
    });

    it('activatePairing refuses to touch a pairing that is not pending', () => {
      const active = store.addPairing({
        id: 'pr-active-1',
        gatewayId: 'alice-mbp',
        credentialHash: 'original-hash',
        deviceLabel: null,
        clientKind: 'web',
      });
      expect(active.status).toBe('active');

      const ok = store.activatePairing('alice-mbp', 'pr-active-1', {
        credentialHash: 'hash-1',
        credential: 'raw-credential-1',
        chatToken: null,
        credentialExpiresAt: FAR_FUTURE_MS,
      });
      expect(ok).toBe(false);
      expect(store.listPairings('alice-mbp')[0].credentialHash).toBe('original-hash');
    });

    it('claimCredential returns the stored value exactly once, then null (single-use)', () => {
      addPendingPairing();
      store.activatePairing('alice-mbp', 'pr-pending-1', {
        credentialHash: 'hash-1',
        credential: 'raw-credential-1',
        chatToken: 'chat-1',
        credentialExpiresAt: FAR_FUTURE_MS,
      });

      const first = store.claimCredential('alice-mbp', 'pr-pending-1', 1000);
      expect(first).toEqual({ credential: 'raw-credential-1', chatToken: 'chat-1' });

      const second = store.claimCredential('alice-mbp', 'pr-pending-1', 1000);
      expect(second).toBeNull();
    });

    it('claimCredential returns null for a pairing with no pending-claim value (never activated)', () => {
      addPendingPairing();
      expect(store.claimCredential('alice-mbp', 'pr-pending-1', 1000)).toBeNull();
    });

    it('claimCredential returns null for an unknown pairing', () => {
      expect(store.claimCredential('alice-mbp', 'pr-missing', 1000)).toBeNull();
    });

    it('claimCredential tolerates a null chat token', () => {
      addPendingPairing();
      store.activatePairing('alice-mbp', 'pr-pending-1', {
        credentialHash: 'hash-1',
        credential: 'raw-credential-1',
        chatToken: null,
        credentialExpiresAt: FAR_FUTURE_MS,
      });

      expect(store.claimCredential('alice-mbp', 'pr-pending-1', 1000)).toEqual({
        credential: 'raw-credential-1',
        chatToken: null,
      });
    });

    it('claimCredential (security fix I3): returns null AND scrubs the value once nowMs reaches the deadline', () => {
      addPendingPairing();
      store.activatePairing('alice-mbp', 'pr-pending-1', {
        credentialHash: 'hash-1',
        credential: 'raw-credential-1',
        chatToken: 'chat-1',
        credentialExpiresAt: 5000,
      });

      // At the deadline: too late.
      expect(store.claimCredential('alice-mbp', 'pr-pending-1', 5000)).toBeNull();

      // Proves it was actually scrubbed (not just filtered on read): calling
      // again with a `nowMs` that would have been WELL within the original
      // deadline still gets nothing, because the value is already gone.
      expect(store.claimCredential('alice-mbp', 'pr-pending-1', 1)).toBeNull();
    });

    it('claimCredential: strictly before the deadline still succeeds', () => {
      addPendingPairing();
      store.activatePairing('alice-mbp', 'pr-pending-1', {
        credentialHash: 'hash-1',
        credential: 'raw-credential-1',
        chatToken: 'chat-1',
        credentialExpiresAt: 5000,
      });

      expect(store.claimCredential('alice-mbp', 'pr-pending-1', 4999)).toEqual({
        credential: 'raw-credential-1',
        chatToken: 'chat-1',
      });
    });
  });
});
