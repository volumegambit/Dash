import type { MessagingApp } from '@dash/mc';
import { create } from 'zustand';

interface MessagingAppsState {
  apps: MessagingApp[];
  loading: boolean;
  error: string | null;

  loadApps(): Promise<void>;
  createApp(app: Omit<MessagingApp, 'id' | 'createdAt'>): Promise<MessagingApp>;
  updateApp(id: string, patch: Partial<MessagingApp>): Promise<void>;
  deleteApp(id: string): Promise<void>;
}

export const useMessagingAppsStore = create<MessagingAppsState>((set, get) => ({
  apps: [],
  loading: false,
  error: null,

  async loadApps() {
    set({ loading: true, error: null });
    try {
      const apps = await window.api.messagingAppsList();
      set({ apps, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async createApp(app) {
    const newApp = await window.api.messagingAppsCreate(app);
    await get().loadApps();
    return newApp;
  },

  async updateApp(id, patch) {
    await window.api.messagingAppsUpdate(id, patch);
    await get().loadApps();
  },

  async deleteApp(id) {
    await window.api.messagingAppsDelete(id);
    await get().loadApps();
  },
}));
