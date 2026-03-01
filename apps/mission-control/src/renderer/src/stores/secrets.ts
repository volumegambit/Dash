import { create } from 'zustand';

interface SecretsState {
  unlocked: boolean;
  needsSetup: boolean;
  loading: boolean;
  error: string | null;
  keys: string[];

  checkStatus(): Promise<void>;
  setup(password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  loadKeys(): Promise<void>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
}

export const useSecretsStore = create<SecretsState>((set, get) => ({
  unlocked: false,
  needsSetup: false,
  loading: true,
  error: null,
  keys: [],

  async checkStatus() {
    set({ loading: true, error: null });
    try {
      const [unlocked, needsSetup] = await Promise.all([
        window.api.secretsIsUnlocked(),
        window.api.secretsNeedsSetup(),
      ]);
      set({ unlocked, needsSetup, loading: false });
      if (unlocked) {
        await get().loadKeys();
      }
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async setup(password: string) {
    set({ loading: true, error: null });
    try {
      await window.api.secretsSetup(password);
      set({ unlocked: true, needsSetup: false, loading: false });
      await get().loadKeys();
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async unlock(password: string) {
    set({ loading: true, error: null });
    try {
      await window.api.secretsUnlock(password);
      set({ unlocked: true, loading: false });
      await get().loadKeys();
    } catch (err) {
      set({ loading: false, error: 'Wrong password. Please try again.' });
    }
  },

  async lock() {
    try {
      await window.api.secretsLock();
      set({ unlocked: false, keys: [], error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async loadKeys() {
    try {
      const keys = await window.api.secretsList();
      set({ keys });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async setSecret(key: string, value: string) {
    try {
      await window.api.secretsSet(key, value);
      await get().loadKeys();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async deleteSecret(key: string) {
    try {
      await window.api.secretsDelete(key);
      await get().loadKeys();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async getSecret(key: string) {
    try {
      return await window.api.secretsGet(key);
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },
}));
