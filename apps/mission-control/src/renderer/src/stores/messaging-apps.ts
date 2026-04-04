import { create } from 'zustand';
import type { GatewayChannel } from '../../../shared/ipc.js';

interface ChannelsState {
  channels: GatewayChannel[];
  loading: boolean;
  error: string | null;

  loadChannels(): Promise<void>;
  createChannel(config: {
    name: string;
    adapter: string;
    token?: string;
    globalDenyList?: string[];
    routing: GatewayChannel['routing'];
  }): Promise<void>;
  updateChannel(
    name: string,
    patch: Partial<Pick<GatewayChannel, 'globalDenyList' | 'routing'>>,
  ): Promise<void>;
  removeChannel(name: string): Promise<void>;
}

export const useChannelsStore = create<ChannelsState>((set, get) => ({
  channels: [],
  loading: true,
  error: null,

  async loadChannels() {
    set({ loading: true, error: null });
    try {
      const channels = await window.api.channelsList();
      set({ channels, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async createChannel(config) {
    await window.api.channelsCreate(config);
    await get().loadChannels();
  },

  async updateChannel(name, patch) {
    await window.api.channelsUpdate(name, patch);
    await get().loadChannels();
  },

  async removeChannel(name) {
    await window.api.channelsRemove(name);
    await get().loadChannels();
  },
}));
