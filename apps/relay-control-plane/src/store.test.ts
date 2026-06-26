import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './store.js';

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
      });
      expect(added.id).toBe('pair-1');
      expect(added.gatewayId).toBe('gw-1');
      expect(added.credentialHash).toBe('deadbeefhash');
      expect(added.deviceLabel).toBe('iPhone');
      expect(added.status).toBe('active');
      expect(typeof added.createdAt).toBe('number');
    });

    it('stores only the hash — no raw credential leaks into the record', () => {
      const added = store.addPairing({
        id: 'pair-1',
        gatewayId: 'gw-1',
        credentialHash: 'hash-only',
        deviceLabel: null,
      });
      // The store takes a hash; the record carries exactly that and nothing
      // resembling a raw secret field.
      expect(added.credentialHash).toBe('hash-only');
      expect(JSON.stringify(added)).not.toContain('credential"');
    });

    it('allows a null device label', () => {
      const added = store.addPairing({
        id: 'pair-2',
        gatewayId: 'gw-1',
        credentialHash: 'h2',
        deviceLabel: null,
      });
      expect(added.deviceLabel).toBeNull();
    });

    it('lists pairings for a gateway', () => {
      store.addPairing({ id: 'p1', gatewayId: 'gw-1', credentialHash: 'h1', deviceLabel: 'a' });
      store.addPairing({ id: 'p2', gatewayId: 'gw-1', credentialHash: 'h2', deviceLabel: 'b' });
      const list = store.listPairings('gw-1');
      expect(list.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    });

    it('revokes a pairing', () => {
      store.addPairing({ id: 'p1', gatewayId: 'gw-1', credentialHash: 'h1', deviceLabel: null });
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
        first.addPairing({ id: 'p1', gatewayId: 'gw-1', credentialHash: 'h1', deviceLabel: 'X' });
        first.close();

        const reopened = new SqliteStore(dbPath);
        expect(reopened.getGateway('gw-1')?.accountId).toBe('acct-1');
        expect(reopened.listPairings('gw-1').map((p) => p.id)).toEqual(['p1']);
        reopened.close();
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
});
