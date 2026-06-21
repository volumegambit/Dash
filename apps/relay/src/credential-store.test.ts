import { PairingCredentialStore } from './credential-store.js';

describe('PairingCredentialStore', () => {
  it('provisions a credential that then validates', () => {
    const store = new PairingCredentialStore();
    const cred = store.provision('gw-1');
    expect(cred).toBeTruthy();
    expect(store.isValid('gw-1', cred)).toBe(true);
  });

  it('rejects an unknown or empty credential', () => {
    const store = new PairingCredentialStore();
    store.provision('gw-1');
    expect(store.isValid('gw-1', 'not-the-credential')).toBe(false);
    expect(store.isValid('gw-1', '')).toBe(false);
    expect(store.isValid('gw-unknown', 'whatever')).toBe(false);
  });

  it('scopes credentials to their gateway', () => {
    const store = new PairingCredentialStore();
    const cred = store.provision('gw-1');
    // A valid credential for gw-1 must not authorize gw-2.
    expect(store.isValid('gw-2', cred)).toBe(false);
  });

  it('supports multiple credentials per gateway (one per device)', () => {
    const store = new PairingCredentialStore();
    const a = store.provision('gw-1');
    const b = store.provision('gw-1');
    expect(a).not.toBe(b);
    expect(store.isValid('gw-1', a)).toBe(true);
    expect(store.isValid('gw-1', b)).toBe(true);
  });

  it('revoke invalidates only the named credential immediately', () => {
    const store = new PairingCredentialStore();
    const a = store.provision('gw-1');
    const b = store.provision('gw-1');
    expect(store.revoke('gw-1', a)).toBe(true);
    expect(store.isValid('gw-1', a)).toBe(false);
    expect(store.isValid('gw-1', b)).toBe(true); // the other device still works
    // Revoking again is a no-op and reports false.
    expect(store.revoke('gw-1', a)).toBe(false);
  });

  it('caps stored credentials per gateway, evicting the oldest', () => {
    const store = new PairingCredentialStore(3); // small cap for the test
    const first = store.provision('gw-1');
    const second = store.provision('gw-1');
    store.provision('gw-1');
    const fourth = store.provision('gw-1'); // exceeds the cap of 3

    expect(store.isValid('gw-1', first)).toBe(false); // oldest evicted
    expect(store.isValid('gw-1', second)).toBe(true); // still within the window
    expect(store.isValid('gw-1', fourth)).toBe(true); // newest kept
  });

  it('revokeAll drops every credential for a gateway', () => {
    const store = new PairingCredentialStore();
    const a = store.provision('gw-1');
    const b = store.provision('gw-1');
    store.revokeAll('gw-1');
    expect(store.isValid('gw-1', a)).toBe(false);
    expect(store.isValid('gw-1', b)).toBe(false);
  });
});
