import { create } from 'zustand';

interface UIState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  companionVisible: boolean;
  companionCollapsed: boolean;
  setCompanionVisible: (visible: boolean) => void;
  setCompanionCollapsed: (collapsed: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: true,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  companionVisible: true,
  companionCollapsed: true,
  setCompanionVisible: (companionVisible) => set({ companionVisible }),
  setCompanionCollapsed: (companionCollapsed) => set({ companionCollapsed }),
}));
