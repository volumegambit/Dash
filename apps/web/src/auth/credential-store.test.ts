import 'fake-indexeddb/auto';
import { CredentialStore } from './credential-store';

describe('CredentialStore', () => {
  it('returns null for a gatewayId that was never set', async () => {
    const store = new CredentialStore();
    await expect(store.get('never-set-gw')).resolves.toBeNull();
  });

  it('round-trips set -> get for a gatewayId', async () => {
    const store = new CredentialStore();
    await store.set('gw-1', 'credential-abc');
    await expect(store.get('gw-1')).resolves.toBe('credential-abc');
  });

  it('overwrites an existing credential for the same gatewayId', async () => {
    const store = new CredentialStore();
    await store.set('gw-2', 'first');
    await store.set('gw-2', 'second');
    await expect(store.get('gw-2')).resolves.toBe('second');
  });

  it('deletes a credential, after which get resolves to null', async () => {
    const store = new CredentialStore();
    await store.set('gw-3', 'to-be-deleted');
    await store.delete('gw-3');
    await expect(store.get('gw-3')).resolves.toBeNull();
  });

  it('delete of a never-set gatewayId is a no-op (does not throw)', async () => {
    const store = new CredentialStore();
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('keeps credentials for different gatewayIds independent', async () => {
    const store = new CredentialStore();
    await store.set('gw-a', 'cred-a');
    await store.set('gw-b', 'cred-b');
    await expect(store.get('gw-a')).resolves.toBe('cred-a');
    await expect(store.get('gw-b')).resolves.toBe('cred-b');
  });

  it('persists across separate CredentialStore instances (same underlying IndexedDB)', async () => {
    const writer = new CredentialStore();
    await writer.set('gw-shared', 'shared-cred');
    const reader = new CredentialStore();
    await expect(reader.get('gw-shared')).resolves.toBe('shared-cred');
  });
});
