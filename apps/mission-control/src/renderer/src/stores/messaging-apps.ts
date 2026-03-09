import type { MessagingApp } from '@dash/mc';
import { create } from 'zustand';
import type { ChannelHealthEntry } from '../../../shared/ipc.js';

interface MessagingAppsState {
  apps: MessagingApp[];
  loading: boolean;
  error: string | null;
  channelHealth: ChannelHealthEntry[];

  loadApps(): Promise<void>;
  createApp(
    app: Omit<MessagingApp, 'id' | 'createdAt' | 'credentialsKey'>,
    token: string,
  ): Promise<MessagingApp>;
  updateApp(id: string, patch: Partial<MessagingApp>): Promise<void>;
  deleteApp(id: string): Promise<void>;
  pollHealth(deploymentId: string): Promise<void>;
  getAppHealth(appId: string): ChannelHealthEntry | undefined;
  getWorstHealth(): 'connected' | 'connecting' | 'disconnected' | 'needs_reauth' | null;
}

export const useMessagingAppsStore = create<MessagingAppsState>((set, get) => ({
  apps: [],
  loading: false,
  error: null,
  channelHealth: [],

  async loadApps() {
    set({ loading: true, error: null });
    try {
      const apps = await window.api.messagingAppsList();
      set({ apps, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async createApp(app, token) {
    set({ error: null });
    try {
      const newApp = await window.api.messagingAppsCreate(app, token);
      await get().loadApps();
      return newApp;
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  async updateApp(id, patch) {
    set({ error: null });
    try {
      await window.api.messagingAppsUpdate(id, patch);
      await get().loadApps();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async deleteApp(id) {
    set({ error: null });
    try {
      await window.api.messagingAppsDelete(id);
      await get().loadApps();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async pollHealth(deploymentId: string) {
    try {
      const channelHealth = await window.api.deploymentsGetChannelHealth(deploymentId);
      set({ channelHealth });
    } catch {
      // Ignore — deployment may not be running
    }
  },

  getAppHealth(appId: string) {
    return get().channelHealth.find((h) => h.appId === appId);
  },

  getWorstHealth() {
    const health = get().channelHealth;
    if (health.length === 0) return null;
    const order = ['needs_reauth', 'disconnected', 'connecting', 'connected'] as const;
    for (const state of order) {
      if (health.some((h) => h.health === state)) return state;
    }
    return 'connected';
  },
}));
