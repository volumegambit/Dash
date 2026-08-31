import 'fake-indexeddb/auto';
import { CredentialStore, type StoredCredential } from './credential-store';

function cred(relayCredential: string, chatToken: string, pairingId = 'p-1'): StoredCredential {
  return { relayCredential, chatToken, pairingId };
}

describe('CredentialStore', () => {
  it('returns null for a gatewayId that was never set', async () => {
    const store = new CredentialStore();
    await expect(store.get('never-set-gw')).resolves.toBeNull();
  });

  it('round-trips set -> get for a gatewayId', async () => {
    const store = new CredentialStore();
    await store.set('gw-1', cred('relay-abc', 'chat-abc'));
    await expect(store.get('gw-1')).resolves.toEqual(cred('relay-abc', 'chat-abc'));
  });

  it('overwrites an existing credential for the same gatewayId', async () => {
    const store = new CredentialStore();
    await store.set('gw-2', cred('relay-1', 'chat-1'));
    await store.set('gw-2', cred('relay-2', 'chat-2'));
    await expect(store.get('gw-2')).resolves.toEqual(cred('relay-2', 'chat-2'));
  });

  it('deletes a credential, after which get resolves to null', async () => {
    const store = new CredentialStore();
    await store.set('gw-3', cred('relay-3', 'chat-3'));
    await store.delete('gw-3');
    await expect(store.get('gw-3')).resolves.toBeNull();
  });

  it('delete of a never-set gatewayId is a no-op (does not throw)', async () => {
    const store = new CredentialStore();
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('keeps credentials for different gatewayIds independent', async () => {
    const store = new CredentialStore();
    await store.set('gw-a', cred('relay-a', 'chat-a'));
    await store.set('gw-b', cred('relay-b', 'chat-b'));
    await expect(store.get('gw-a')).resolves.toEqual(cred('relay-a', 'chat-a'));
    await expect(store.get('gw-b')).resolves.toEqual(cred('relay-b', 'chat-b'));
  });

  it('persists across separate CredentialStore instances (same underlying IndexedDB)', async () => {
    const writer = new CredentialStore();
    await writer.set('gw-shared', cred('relay-shared', 'chat-shared'));
    const reader = new CredentialStore();
    await expect(reader.get('gw-shared')).resolves.toEqual(cred('relay-shared', 'chat-shared'));
  });

  it('treats a pre-migration bare-string value as absent rather than misreading it', async () => {
    const store = new CredentialStore();
    // Simulate data written by the pre-Task-12b-fix shape (a bare string).
    const db = await (store as unknown as { getDb(): Promise<IDBDatabase> }).getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('credentials', 'readwrite');
      tx.objectStore('credentials').put('legacy-bare-string', 'gw-legacy');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await expect(store.get('gw-legacy')).resolves.toBeNull();
  });

  it('treats a pre-pairingId-migration record (missing pairingId) as absent rather than misreading it', async () => {
    const store = new CredentialStore();
    // Simulate data written by the pre-Task-13 two-field shape.
    const db = await (store as unknown as { getDb(): Promise<IDBDatabase> }).getDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('credentials', 'readwrite');
      tx.objectStore('credentials').put(
        { relayCredential: 'relay-old', chatToken: 'chat-old' },
        'gw-two-field',
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await expect(store.get('gw-two-field')).resolves.toBeNull();
  });
});
