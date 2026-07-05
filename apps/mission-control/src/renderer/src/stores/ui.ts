import { create } from 'zustand';

const COMPANION_VISIBLE_KEY = 'dash.companion.visible';

function loadCompanionVisible(): boolean {
  try {
    const v = localStorage.getItem(COMPANION_VISIBLE_KEY);
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch {
    // ignore
  }
  return true;
}

interface UIState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  expandSidebar: () => void;
  companionVisible: boolean;
  setCompanionVisible: (visible: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  expandSidebar: () => set({ sidebarCollapsed: false }),
  companionVisible: loadCompanionVisible(),
  setCompanionVisible: (companionVisible) => {
    try {
      localStorage.setItem(COMPANION_VISIBLE_KEY, String(companionVisible));
    } catch {
      // ignore
    }
    set({ companionVisible });
  },
}));
