import { create } from 'zustand';
import type { CompanionSelection } from '../../../shared/ipc.js';
import { parseCompanionSelection } from '../companion/pets/companionSelection.js';

const COMPANION_VISIBLE_KEY = 'dash.companion.visible';
// Holds a CompanionSelection (squad kind) string. The key is unchanged from
// the single-pet/crew eras so old values migrate for free: legacy `crew:*`
// and pet-id values normalize via parseCompanionSelection.
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
 * Load the persisted squad selection, normalized: unknown or malformed values
 * (including retired pet ids) collapse to the default squad.
 */
export function loadCompanionSelection(): CompanionSelection {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(COMPANION_SELECTION_KEY);
  } catch {
    // ignore
  }
  return parseCompanionSelection(raw);
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
