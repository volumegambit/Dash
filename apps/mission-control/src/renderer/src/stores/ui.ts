import { create } from 'zustand';
import type { CompanionSelection } from '../../../shared/ipc.js';
import { parseCompanionSelection } from '../companion/pets/companionSelection.js';

const COMPANION_VISIBLE_KEY = 'dash.companion.visible';
// Holds a CompanionSelection (squad kind) string. The key is unchanged from
// the single-pet/crew eras so old values migrate for free: legacy `crew:*`
// and pet-id values normalize via parseCompanionSelection.
const COMPANION_SELECTION_KEY = 'dash.companion.pet';
// "What does Return do in the composer" — default false (Return inserts a
// newline). See docs/plans/2026-09-13-composer-return-key-configurable-design.md.
const COMPOSER_RETURN_KEY_SENDS_KEY = 'dash.composer.returnKeySends';

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

function loadComposerReturnKeySends(): boolean {
  try {
    return localStorage.getItem(COMPOSER_RETURN_KEY_SENDS_KEY) === '1';
  } catch {
    return false;
  }
}

interface UIState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  expandSidebar: () => void;
  companionVisible: boolean;
  setCompanionVisible: (visible: boolean) => void;
  companionSelection: CompanionSelection;
  setCompanionSelection: (selection: CompanionSelection) => void;
  composerReturnKeySends: boolean;
  setComposerReturnKeySends: (sends: boolean) => void;
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
  composerReturnKeySends: loadComposerReturnKeySends(),
  setComposerReturnKeySends: (composerReturnKeySends) => {
    try {
      localStorage.setItem(COMPOSER_RETURN_KEY_SENDS_KEY, String(composerReturnKeySends));
    } catch {
      // ignore
    }
    set({ composerReturnKeySends });
  },
}));
