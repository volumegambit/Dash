const DB_NAME = 'dash-web';
const DB_VERSION = 1;
const STORE_NAME = 'credentials';

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolves once `tx` commits; rejects on error/abort. */
function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * What a paired browser needs to traverse the relay to its gateway:
 * `relayCredential` authenticates the relay hop itself (sent as the WS
 * `dash.relay-credential.<value>` subprotocol / `x-dash-relay-credential`
 * REST header — see `ChatSocket`/`MobileRestClient`), while `chatToken` is
 * the gateway's own mobile-v1 bearer (the same value the pairing QR carries
 * to phones) sent as `Authorization: Bearer <chatToken>` on mobile-v1
 * requests. Both are needed; neither alone is sufficient.
 */
export interface StoredCredential {
  relayCredential: string;
  chatToken: string;
}

function isStoredCredential(value: unknown): value is StoredCredential {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<StoredCredential>).relayCredential === 'string' &&
    typeof (value as Partial<StoredCredential>).chatToken === 'string'
  );
}

/**
 * Stores paired-device credentials keyed by `gatewayId` in IndexedDB
 * (db `dash-web`, object store `credentials`). Deliberately dependency-free —
 * a thin promisified wrapper over the raw browser IndexedDB API, no
 * third-party IDB helper in the production bundle.
 *
 * Values are `StoredCredential` records (not bare strings) — a pre-existing
 * value from before that shape landed fails `isStoredCredential` and reads
 * back as `null`, which just forces re-pairing rather than misbehaving with
 * half the data it needs.
 */
export class CredentialStore {
  private dbPromise: Promise<IDBDatabase> | undefined;

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  async get(gatewayId: string): Promise<StoredCredential | null> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const result = await promisifyRequest(tx.objectStore(STORE_NAME).get(gatewayId));
    return isStoredCredential(result) ? result : null;
  }

  async set(gatewayId: string, credential: StoredCredential): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(credential, gatewayId);
    await promisifyTransaction(tx);
  }

  async delete(gatewayId: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(gatewayId);
    await promisifyTransaction(tx);
  }
}
