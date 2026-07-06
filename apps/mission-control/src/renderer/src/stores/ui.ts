import { create } from 'zustand';
import type { CompanionSelection } from '../../../shared/ipc.js';
import {
  parseCompanionSelection,
  serializeCompanionSelection,
} from '../companion/pets/companionSelection.js';

const COMPANION_VISIBLE_KEY = 'dash.companion.visible';
// Holds a CompanionSelection string (a PetKind or `crew:<CrewKind>`). The key
// is unchanged from when it held only a PetKind, so old values migrate for
// free: a persisted pet id is already a valid selection.
const COMPANION_SELECTION_KEY = 'dash.companion.pet';

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

/**
 * Load the persisted companion selection, normalized: unknown or malformed
 * values (including invalid crews) collapse to the default pet.
 */
export function loadCompanionSelection(): CompanionSelection {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(COMPANION_SELECTION_KEY);
  } catch {
    // ignore
  }
  return serializeCompanionSelection(parseCompanionSelection(raw));
}

interface UIState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  expandSidebar: () => void;
  companionVisible: boolean;
  setCompanionVisible: (visible: boolean) => void;
  companionSelection: CompanionSelection;
  setCompanionSelection: (selection: CompanionSelection) => void;
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
  companionSelection: loadCompanionSelection(),
  setCompanionSelection: (companionSelection) => {
    try {
      localStorage.setItem(COMPANION_SELECTION_KEY, companionSelection);
    } catch {
      // ignore
    }
    set({ companionSelection });
  },
}));
