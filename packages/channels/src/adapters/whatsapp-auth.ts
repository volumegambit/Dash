import { initAuthCreds } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState } from '@whiskeysockets/baileys';
import type { SecretStore } from '../types.js';

export interface BaileysAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export async function makeBaileysAuthState(
  store: SecretStore,
  prefix: string,
): Promise<BaileysAuthState> {
  // Load or initialise credentials
  const credsJson = await store.get(`${prefix}creds`);
  const creds: AuthenticationCreds = credsJson
    ? (JSON.parse(credsJson) as AuthenticationCreds)
    : initAuthCreds();

  // Serialize saveCreds to prevent concurrent writes
  let writeQueue: Promise<void> = Promise.resolve();

  function saveCreds(): Promise<void> {
    writeQueue = writeQueue.then(() =>
      store.set(`${prefix}creds`, JSON.stringify(creds)),
    );
    return writeQueue;
  }

  const keys: AuthenticationState['keys'] = {
    async get(type, ids) {
      const result: Record<string, unknown> = {};
      await Promise.all(
        ids.map(async (id) => {
          const raw = await store.get(`${prefix}key:${type}-${id}`);
          result[id] = raw ? (JSON.parse(raw) as unknown) : null;
        }),
      );
      return result as unknown as ReturnType<AuthenticationState['keys']['get']> extends Promise<infer T> ? T : never;
    },

    async set(data) {
      const tasks: Promise<void>[] = [];
      for (const type of Object.keys(data)) {
        const typeData = data[type as keyof typeof data] as Record<string, unknown> | null | undefined;
        if (!typeData) continue;
        for (const [id, value] of Object.entries(typeData)) {
          const storeKey = `${prefix}key:${type}-${id}`;
          if (value != null) {
            tasks.push(store.set(storeKey, JSON.stringify(value)));
          } else {
            tasks.push(store.delete(storeKey));
          }
        }
      }
      await Promise.all(tasks);
    },
  };

  return {
    state: { creds, keys },
    saveCreds,
  };
}
