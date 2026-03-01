import keytar from 'keytar';

const SERVICE_NAME = 'dash-mission-control';

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export class KeytarSecretStore implements SecretStore {
  async get(key: string): Promise<string | null> {
    return keytar.getPassword(SERVICE_NAME, key);
  }

  async set(key: string, value: string): Promise<void> {
    await keytar.setPassword(SERVICE_NAME, key, value);
  }

  async delete(key: string): Promise<void> {
    await keytar.deletePassword(SERVICE_NAME, key);
  }

  async list(): Promise<string[]> {
    const credentials = await keytar.findCredentials(SERVICE_NAME);
    return credentials.map((c) => c.account);
  }
}
