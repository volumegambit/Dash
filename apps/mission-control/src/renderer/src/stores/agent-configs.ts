import { create } from 'zustand';
import type { RuntimeAgentConfig, RuntimeAgentInfo } from '../../../shared/ipc.js';

interface AgentConfigsState {
  /** Map of agent name → config (from gateway) */
  configs: Record<string, RuntimeAgentConfig>;
  loading: boolean;
  error: string | null;

  /** Fetch all agent configs from gateway. Called once on app startup. */
  loadAll(): Promise<void>;

  /** Fetch a single agent's config from gateway. Called on config-changed events. */
  refresh(agentName: string): Promise<void>;

  /** Get config for an agent by name. Returns undefined if not loaded. */
  getConfig(agentName: string): RuntimeAgentConfig | undefined;
}

export const useAgentConfigsStore = create<AgentConfigsState>((set, get) => ({
  configs: {},
  loading: false,
  error: null,

  async loadAll() {
    set({ loading: true, error: null });
    try {
      const agents: RuntimeAgentInfo[] = await window.api.deploymentsListAgentConfigs();
      const configs: Record<string, RuntimeAgentConfig> = {};
      for (const agent of agents) {
        configs[agent.name] = agent.config;
      }
      set({ configs, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async refresh(agentName: string) {
    try {
      const agent: RuntimeAgentInfo = await window.api.deploymentsGetAgentConfig(agentName);
      set({ configs: { ...get().configs, [agentName]: agent.config } });
    } catch {
      // Agent may have been removed — delete from local cache
      const { [agentName]: _, ...rest } = get().configs;
      set({ configs: rest });
    }
  },

  getConfig(agentName: string) {
    return get().configs[agentName];
  },
}));
