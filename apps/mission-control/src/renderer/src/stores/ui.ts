import { create } from 'zustand';
import type { PetKind } from '../../../shared/ipc.js';
import { DEFAULT_PET, PET_KINDS } from '../companion/pets/kinds.js';

const COMPANION_VISIBLE_KEY = 'dash.companion.visible';
const COMPANION_PET_KEY = 'dash.companion.pet';

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

export function loadCompanionPet(): PetKind {
  try {
    const v = localStorage.getItem(COMPANION_PET_KEY);
    if (v && (PET_KINDS as readonly string[]).includes(v)) return v as PetKind;
  } catch {
    // ignore
  }
  return DEFAULT_PET;
}

interface UIState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  expandSidebar: () => void;
  companionVisible: boolean;
  setCompanionVisible: (visible: boolean) => void;
  companionPet: PetKind;
  setCompanionPet: (pet: PetKind) => void;
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
  companionPet: loadCompanionPet(),
  setCompanionPet: (companionPet) => {
    try {
      localStorage.setItem(COMPANION_PET_KEY, companionPet);
    } catch {
      // ignore
    }
    set({ companionPet });
  },
}));
