import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PET } from '../companion/pets/kinds.js';
import { loadCompanionSelection, useUIStore } from './ui.js';

describe('ui store companion flags', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({ companionVisible: true, companionSelection: DEFAULT_PET });
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

  it('companionSelection defaults to the default pet when unset', () => {
    localStorage.removeItem('dash.companion.pet');
    expect(loadCompanionSelection()).toBe(DEFAULT_PET);
  });

  it('setCompanionSelection persists a pet and rejects an invalid one on reload', () => {
    useUIStore.getState().setCompanionSelection('cat');
    expect(localStorage.getItem('dash.companion.pet')).toBe('cat');
    expect(useUIStore.getState().companionSelection).toBe('cat');
    expect(loadCompanionSelection()).toBe('cat');

    localStorage.setItem('dash.companion.pet', 'nonsense');
    expect(loadCompanionSelection()).toBe(DEFAULT_PET);
  });

  it('setCompanionSelection persists a crew selection', () => {
    useUIStore.getState().setCompanionSelection('crew:kitchen');
    expect(localStorage.getItem('dash.companion.pet')).toBe('crew:kitchen');
    expect(useUIStore.getState().companionSelection).toBe('crew:kitchen');
    expect(loadCompanionSelection()).toBe('crew:kitchen');
  });

  it('an invalid crew id falls back to the default pet on reload', () => {
    localStorage.setItem('dash.companion.pet', 'crew:not-a-crew');
    expect(loadCompanionSelection()).toBe(DEFAULT_PET);
  });

  it('old persisted pet values keep working (backward compat)', () => {
    localStorage.setItem('dash.companion.pet', 'wok-uncle');
    expect(loadCompanionSelection()).toBe('wok-uncle');
  });
});
