import type { MemoryConfig, MemoryContent, MemoryInfo, MemoryType } from '@dash/management';
import { create } from 'zustand';

const DEFAULT_CONFIG: MemoryConfig = { enabled: true, sweep: 'auto' };

interface AgentMemoryState {
  memories: MemoryInfo[];
  config: MemoryConfig;
  loading: boolean;
  error: string | null;

  load(agentId: string): Promise<void>;
  open(agentId: string, name: string): Promise<MemoryContent | null>;
  put(
    agentId: string,
    name: string,
    input: { description: string; type: MemoryType; content: string },
  ): Promise<void>;
  remove(agentId: string, name: string): Promise<void>;
  saveConfig(agentId: string, patch: Partial<MemoryConfig>): Promise<void>;
  clearError(): void;
}

export const useAgentMemoryStore = create<AgentMemoryState>((set, get) => ({
  memories: [],
  config: DEFAULT_CONFIG,
  loading: false,
  error: null,

  async load(agentId) {
    set({ loading: true, error: null });
    try {
      const [memories, config] = await Promise.all([
        window.api.memoryList(agentId),
        window.api.memoryGetConfig(agentId),
      ]);
      set({ memories, config, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async open(agentId, name) {
    set({ error: null });
    try {
      return await window.api.memoryGet(agentId, name);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async put(agentId, name, input) {
    set({ error: null });
    try {
      await window.api.memoryPut(agentId, name, input);
      await get().load(agentId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async remove(agentId, name) {
    set({ error: null });
    try {
      await window.api.memoryRemove(agentId, name);
      await get().load(agentId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async saveConfig(agentId, patch) {
    set({ error: null });
    try {
      const next = await window.api.memoryUpdateConfig(agentId, patch);
      set({ config: next });
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  clearError() {
    set({ error: null });
  },
}));
