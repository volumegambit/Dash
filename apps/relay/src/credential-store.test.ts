import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableCredentialStore, PairingCredentialStore } from './credential-store.js';

function tmpDb() {
  return join(mkdtempSync(join(tmpdir(), 'relay-store-')), 'creds.db');
}

/** The relay's canonical pairing-hash form (matches the store's internal `hashCred`). */
function hashOf(credential: string): string {
  return createHash('sha256').update(credential).digest('base64url');
}

describe('PairingCredentialStore', () => {
  it('provisions a credential that then validates', () => {
    const store = new PairingCredentialStore();
    const cred = store.provision('t1', 'gw-1');
    expect(cred).toBeTruthy();
    expect(store.isValid('gw-1', cred)).toBe(true);
  });

  it('rejects an unknown or empty credential', () => {
    const store = new PairingCredentialStore();
    store.provision('t1', 'gw-1');
    expect(store.isValid('gw-1', 'not-the-credential')).toBe(false);
    expect(store.isValid('gw-1', '')).toBe(false);
    expect(store.isValid('gw-unknown', 'whatever')).toBe(false);
  });

  it('scopes credentials to their gateway', () => {
    const store = new PairingCredentialStore();
    const cred = store.provision('t1', 'gw-1');
    // A valid credential for gw-1 must not authorize gw-2.
    expect(store.isValid('gw-2', cred)).toBe(false);
  });

  it('supports multiple credentials per gateway (one per device)', () => {
    const store = new PairingCredentialStore();
    const a = store.provision('t1', 'gw-1');
    const b = store.provision('t1', 'gw-1');
    expect(a).not.toBe(b);
    expect(store.isValid('gw-1', a)).toBe(true);
    expect(store.isValid('gw-1', b)).toBe(true);
  });

  it('revoke invalidates only the named credential immediately', () => {
    const store = new PairingCredentialStore();
    const a = store.provision('t1', 'gw-1');
    const b = store.provision('t1', 'gw-1');
    expect(store.revoke('t1', 'gw-1', a)).toBe(true);
    expect(store.isValid('gw-1', a)).toBe(false);
    expect(store.isValid('gw-1', b)).toBe(true); // the other device still works
    // Revoking again is a no-op and reports false.
    expect(store.revoke('t1', 'gw-1', a)).toBe(false);
  });

  it('caps stored credentials per gateway, evicting the never-validated oldest', () => {
    const store = new PairingCredentialStore(3); // small cap for the test
    const first = store.provision('t1', 'gw-1');
    const second = store.provision('t1', 'gw-1');
    store.provision('t1', 'gw-1');
    const fourth = store.provision('t1', 'gw-1'); // exceeds the cap of 3

    expect(store.isValid('gw-1', first)).toBe(false); // oldest, never validated → evicted
    expect(store.isValid('gw-1', second)).toBe(true); // still within the window
    expect(store.isValid('gw-1', fourth)).toBe(true); // newest kept
  });

  it('evicts least-recently-validated, sparing an actively-connecting device', () => {
    const store = new PairingCredentialStore(2);
    const active = store.provision('t1', 'gw-1'); // order: active
    const orphan = store.provision('t1', 'gw-1'); // order: active, orphan
    expect(store.isValid('gw-1', active)).toBe(true); // used → order: orphan, active
    const fresh = store.provision('t1', 'gw-1'); // size 3 > 2 → evict the front (orphan)

    expect(store.isValid('gw-1', orphan)).toBe(false); // never-validated orphan evicted
    expect(store.isValid('gw-1', active)).toBe(true); // active device kept despite being older
    expect(store.isValid('gw-1', fresh)).toBe(true);
  });

  it('revokeAll drops every credential for a gateway', () => {
    const store = new PairingCredentialStore();
    const a = store.provision('t1', 'gw-1');
    const b = store.provision('t1', 'gw-1');
    store.revokeAll('t1', 'gw-1');
    expect(store.isValid('gw-1', a)).toBe(false);
    expect(store.isValid('gw-1', b)).toBe(false);
  });

  it('revokeByHash invalidates only the credential whose hash matches', () => {
    const store = new PairingCredentialStore();
    const a = store.provision('t1', 'gw-1');
    const b = store.provision('t1', 'gw-1');
    // The caller knows only the hash (the control plane never keeps the raw secret).
    expect(store.revokeByHash('t1', 'gw-1', hashOf(a))).toBe(true);
    expect(store.isValid('gw-1', a)).toBe(false);
    expect(store.isValid('gw-1', b)).toBe(true); // the other device still works
    // Revoking again is a no-op and reports false.
    expect(store.revokeByHash('t1', 'gw-1', hashOf(a))).toBe(false);
    // An unknown gateway is a no-op too.
    expect(store.revokeByHash('t1', 'gw-unknown', hashOf(b))).toBe(false);
  });
});

describe('DurableCredentialStore', () => {
  test('durable store validates a provisioned credential and rejects junk', () => {
    const s = new DurableCredentialStore(tmpDb());
    const cred = s.provision('t1', 'gw-1');
    expect(s.isValid('gw-1', cred)).toBe(true);
    expect(s.isValid('gw-1', 'nope')).toBe(false);
    expect(s.isValid('gw-2', cred)).toBe(false); // gatewayId-scoped
  });

  test('revoke and revokeAll take effect immediately', () => {
    const s = new DurableCredentialStore(tmpDb());
    const a = s.provision('t1', 'gw-1');
    const b = s.provision('t1', 'gw-1');
    expect(s.revoke('t1', 'gw-1', a)).toBe(true);
    expect(s.isValid('gw-1', a)).toBe(false);
    expect(s.isValid('gw-1', b)).toBe(true);
    s.revokeAll('t1', 'gw-1');
    expect(s.isValid('gw-1', b)).toBe(false);
  });

  test('persists across reopen (durability)', () => {
    const path = tmpDb();
    const cred = new DurableCredentialStore(path).provision('t1', 'gw-1');
    expect(new DurableCredentialStore(path).isValid('gw-1', cred)).toBe(true);
  });

  test('does NOT store the raw credential (hashed at rest)', () => {
    const path = tmpDb();
    const s = new DurableCredentialStore(path);
    const cred = s.provision('t1', 'gw-1');
    const raw = require('node:fs').readFileSync(path);
    expect(raw.includes(Buffer.from(cred))).toBe(false);
  });

  test('enforces a per-tenant credential cap (oldest evicted)', () => {
    const s = new DurableCredentialStore(tmpDb(), { maxPerGateway: 2 });
    const a = s.provision('t1', 'gw-1');
    s.provision('t1', 'gw-1');
    s.provision('t1', 'gw-1'); // evicts `a`
    expect(s.isValid('gw-1', a)).toBe(false);
  });

  test('revokeByHash deletes only the matching credential', () => {
    const s = new DurableCredentialStore(tmpDb());
    const a = s.provision('t1', 'gw-1');
    const b = s.provision('t1', 'gw-1');
    expect(s.revokeByHash('t1', 'gw-1', hashOf(a))).toBe(true);
    expect(s.isValid('gw-1', a)).toBe(false);
    expect(s.isValid('gw-1', b)).toBe(true);
    // Idempotent: revoking an already-absent hash reports false.
    expect(s.revokeByHash('t1', 'gw-1', hashOf(a))).toBe(false);
  });
});
