import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PET } from '../companion/pets/kinds.js';
import { loadCompanionPet, useUIStore } from './ui.js';

describe('ui store companion flags', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({ companionVisible: true, companionPet: DEFAULT_PET });
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

  it('companionPet defaults to the default pet when unset', () => {
    localStorage.removeItem('dash.companion.pet');
    useUIStore.setState({ companionPet: DEFAULT_PET });
    expect(useUIStore.getState().companionPet).toBe(DEFAULT_PET);
  });

  it('setCompanionPet persists a valid kind and rejects an invalid one on reload', () => {
    useUIStore.getState().setCompanionPet('cat');
    expect(localStorage.getItem('dash.companion.pet')).toBe('cat');
    expect(useUIStore.getState().companionPet).toBe('cat');
    expect(loadCompanionPet()).toBe('cat');

    localStorage.setItem('dash.companion.pet', 'nonsense');
    expect(loadCompanionPet()).toBe(DEFAULT_PET);
  });
});
