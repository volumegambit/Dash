import { create } from 'zustand';
import type {
  McpAddConnectorConfig,
  McpAddConnectorResult,
  McpConnectorInfo,
} from '../../../shared/ipc.js';

interface ConnectorsState {
  connectors: McpConnectorInfo[];
  allowlist: string[];
  loading: boolean;
  error: string | null;

  loadConnectors(): Promise<void>;
  addConnector(config: McpAddConnectorConfig): Promise<McpAddConnectorResult>;
  removeConnector(name: string): Promise<void>;
  reconnectConnector(name: string): Promise<void>;
  getConnector(name: string): Promise<McpConnectorInfo>;
  loadAllowlist(): Promise<void>;
  setAllowlist(patterns: string[]): Promise<void>;
  initConnectorListeners(): () => void;
}

export const useConnectorsStore = create<ConnectorsState>((set, get) => ({
  connectors: [],
  allowlist: [],
  loading: false,
  error: null,

  async loadConnectors() {
    set({ loading: true, error: null });
    try {
      const connectors = await window.api.mcpListConnectors();
      set({ connectors, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async addConnector(config) {
    set({ error: null });
    try {
      const result = await window.api.mcpAddConnector(config);
      await get().loadConnectors();
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      set({ error: msg });
      throw err;
    }
  },

  async removeConnector(name) {
    set({ error: null });
    try {
      await window.api.mcpRemoveConnector(name);
      await get().loadConnectors();
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async reconnectConnector(name) {
    set({ error: null });
    try {
      await window.api.mcpReconnectConnector(name);
      await get().loadConnectors();
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async getConnector(name) {
    return window.api.mcpGetConnector(name);
  },

  async loadAllowlist() {
    try {
      const allowlist = await window.api.mcpGetAllowlist();
      set({ allowlist });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async setAllowlist(patterns) {
    set({ error: null });
    try {
      await window.api.mcpSetAllowlist(patterns);
      set({ allowlist: patterns });
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  initConnectorListeners() {
    const unsub = window.api.onMcpStatusChanged((change) => {
      set((state) => {
        const connectors = state.connectors.map((c) =>
          c.name === change.serverName ? { ...c, status: change.status } : c,
        );
        return { connectors };
      });
    });
    return unsub;
  },
}));
