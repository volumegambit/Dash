import type { PluginInstallRequest, PluginInstallResponse, PluginRecord } from '@dash/management';
import { create } from 'zustand';

interface PluginsState {
  records: PluginRecord[];
  loading: boolean;
  error: string | null;

  loadPlugins(): Promise<void>;
  setState(name: string, patch: { enabled?: boolean; trusted?: boolean }): Promise<void>;
  install(req: PluginInstallRequest): Promise<PluginInstallResponse>;
  remove(name: string): Promise<void>;
  reload(): Promise<void>;
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  records: [],
  loading: false,
  error: null,

  async loadPlugins() {
    set({ loading: true, error: null });
    try {
      const records = await window.api.plugins.list();
      set({ records, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async setState(name, patch) {
    set({ error: null });
    try {
      // setState returns the updated PluginRecord; splice it in (replace by name).
      const updated = await window.api.plugins.setState(name, patch);
      set((state) => ({
        records: state.records.map((r) => (r.name === name ? updated : r)),
      }));
    } catch (err) {
      // On failure (incl. a 409 reload-failure surfaced as a throw) set error and
      // re-throw without splicing — the screen keeps its modal / shows the error.
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async install(req) {
    set({ error: null });
    try {
      // The install response is the flat PluginInstallResponse union — NOT a full
      // PluginRecord — so we can't splice it directly. Refresh the records list to
      // pick up the new entry, then return the result so the screen can surface
      // scanVerdict/scanReasons and any reload-pending note.
      const result = await window.api.plugins.install(req);
      await get().loadPlugins();
      return result;
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async remove(name) {
    set({ error: null });
    try {
      await window.api.plugins.remove(name);
      set((state) => ({
        records: state.records.filter((r) => r.name !== name),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async reload() {
    set({ error: null });
    try {
      await window.api.plugins.reload();
      await get().loadPlugins();
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },
}));
