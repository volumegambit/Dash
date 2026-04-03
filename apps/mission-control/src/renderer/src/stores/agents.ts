import type { CreateAgentRequest, GatewayAgent } from '../../../shared/ipc.js';
import { create } from 'zustand';

interface AgentsState {
  agents: GatewayAgent[];
  loading: boolean;
  error: string | null;

  loadAgents(): Promise<void>;
  createAgent(config: CreateAgentRequest): Promise<GatewayAgent>;
  updateAgent(id: string, patch: Partial<CreateAgentRequest>): Promise<void>;
  removeAgent(id: string): Promise<void>;
  disableAgent(id: string): Promise<void>;
  enableAgent(id: string): Promise<void>;
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  loading: true,
  error: null,

  async loadAgents() {
    set({ loading: true, error: null });
    try {
      const agents = await window.api.agentsList();
      set({ agents, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async createAgent(config) {
    const agent = await window.api.agentsCreate(config);
    await get().loadAgents();
    return agent;
  },

  async updateAgent(id, patch) {
    await window.api.agentsUpdate(id, patch);
    await get().loadAgents();
  },

  async removeAgent(id) {
    await window.api.agentsRemove(id);
    await get().loadAgents();
  },

  async disableAgent(id) {
    await window.api.agentsDisable(id);
    await get().loadAgents();
  },

  async enableAgent(id) {
    await window.api.agentsEnable(id);
    await get().loadAgents();
  },
}));
