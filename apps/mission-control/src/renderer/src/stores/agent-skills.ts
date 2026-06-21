import type { SkillInfo, SkillsConfig } from '@dash/management';
import { create } from 'zustand';

interface AgentSkillsState {
  skills: SkillInfo[];
  config: SkillsConfig;
  loading: boolean;
  error: string | null;

  load(agentId: string): Promise<void>;
  create(
    agentId: string,
    input: { name: string; description: string; content: string },
  ): Promise<void>;
  edit(agentId: string, name: string, content: string): Promise<void>;
  install(agentId: string, source: string, name?: string): Promise<void>;
  remove(agentId: string, name: string): Promise<void>;
  saveConfig(agentId: string, config: SkillsConfig): Promise<void>;
  clearError(): void;
}

export const useAgentSkillsStore = create<AgentSkillsState>((set, get) => ({
  skills: [],
  config: {},
  loading: false,
  error: null,

  async load(agentId) {
    set({ loading: true, error: null });
    try {
      const [skills, config] = await Promise.all([
        window.api.skillsList(agentId),
        window.api.skillsGetConfig(agentId),
      ]);
      set({ skills, config, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async create(agentId, input) {
    set({ error: null });
    try {
      await window.api.skillsCreate(agentId, input.name, input.description, input.content);
      await get().load(agentId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async edit(agentId, name, content) {
    set({ error: null });
    try {
      await window.api.skillsUpdateContent(agentId, name, content);
      await get().load(agentId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async install(agentId, source, name) {
    set({ error: null });
    try {
      await window.api.skillsInstall(agentId, source, name);
      await get().load(agentId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async remove(agentId, name) {
    set({ error: null });
    try {
      await window.api.skillsRemove(agentId, name);
      await get().load(agentId);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async saveConfig(agentId, config) {
    set({ error: null });
    try {
      const next = await window.api.skillsUpdateConfig(agentId, config);
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
