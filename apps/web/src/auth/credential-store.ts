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
 * Stores paired-device credentials keyed by `gatewayId` in IndexedDB
 * (db `dash-web`, object store `credentials`). Deliberately dependency-free —
 * a thin promisified wrapper over the raw browser IndexedDB API, no
 * third-party IDB helper in the production bundle.
 */
export class CredentialStore {
  private dbPromise: Promise<IDBDatabase> | undefined;

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  async get(gatewayId: string): Promise<string | null> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const result = await promisifyRequest(tx.objectStore(STORE_NAME).get(gatewayId));
    return typeof result === 'string' ? result : null;
  }

  async set(gatewayId: string, credential: string): Promise<void> {
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
