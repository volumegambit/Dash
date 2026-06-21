import { describe, expect, it } from 'vitest';
import { useUIStore } from './ui.js';

describe('ui store companion flags', () => {
  it('defaults companionVisible to true and companionCollapsed to true', () => {
    const s = useUIStore.getState();
    expect(s.companionVisible).toBe(true);
    expect(s.companionCollapsed).toBe(true);
  });

  it('toggles companion visibility and collapse', () => {
    useUIStore.getState().setCompanionVisible(false);
    expect(useUIStore.getState().companionVisible).toBe(false);
    useUIStore.getState().setCompanionCollapsed(false);
    expect(useUIStore.getState().companionCollapsed).toBe(false);
  });
});
