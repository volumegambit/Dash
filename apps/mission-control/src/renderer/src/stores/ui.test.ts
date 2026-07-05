import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from './ui.js';

describe('ui store companion flags', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({ companionVisible: true });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults companionVisible to true', () => {
    expect(useUIStore.getState().companionVisible).toBe(true);
  });

  it('toggles companion visibility and persists it', () => {
    useUIStore.getState().setCompanionVisible(false);
    expect(useUIStore.getState().companionVisible).toBe(false);
    expect(localStorage.getItem('dash.companion.visible')).toBe('false');

    useUIStore.getState().setCompanionVisible(true);
    expect(useUIStore.getState().companionVisible).toBe(true);
    expect(localStorage.getItem('dash.companion.visible')).toBe('true');
  });
});
