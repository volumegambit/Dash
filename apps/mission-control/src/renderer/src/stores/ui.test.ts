import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SQUAD } from '../companion/pets/squads.js';
import { loadCompanionSelection, useUIStore } from './ui.js';

describe('ui store squad flags', () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({ companionVisible: true, companionSelection: DEFAULT_SQUAD });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults companionVisible to true', () => {
    expect(useUIStore.getState().companionVisible).toBe(true);
  });

  it('toggles squad visibility and persists it', () => {
    useUIStore.getState().setCompanionVisible(false);
    expect(useUIStore.getState().companionVisible).toBe(false);
    expect(localStorage.getItem('dash.companion.visible')).toBe('false');

    useUIStore.getState().setCompanionVisible(true);
    expect(useUIStore.getState().companionVisible).toBe(true);
    expect(localStorage.getItem('dash.companion.visible')).toBe('true');
  });

  it('companionSelection defaults to the default squad when unset', () => {
    localStorage.removeItem('dash.companion.pet');
    expect(loadCompanionSelection()).toBe(DEFAULT_SQUAD);
  });

  it('setCompanionSelection persists a squad and rejects an invalid one on reload', () => {
    useUIStore.getState().setCompanionSelection('office');
    expect(localStorage.getItem('dash.companion.pet')).toBe('office');
    expect(useUIStore.getState().companionSelection).toBe('office');
    expect(loadCompanionSelection()).toBe('office');

    localStorage.setItem('dash.companion.pet', 'nonsense');
    expect(loadCompanionSelection()).toBe(DEFAULT_SQUAD);
  });

  it('legacy crew-prefixed values keep working (backward compat)', () => {
    localStorage.setItem('dash.companion.pet', 'crew:gym');
    expect(loadCompanionSelection()).toBe('gym');
  });

  it('an invalid crew id falls back to the default squad on reload', () => {
    localStorage.setItem('dash.companion.pet', 'crew:not-a-crew');
    expect(loadCompanionSelection()).toBe(DEFAULT_SQUAD);
  });

  it('retired single-pet values fall back to the default squad', () => {
    localStorage.setItem('dash.companion.pet', 'wok-uncle');
    expect(loadCompanionSelection()).toBe(DEFAULT_SQUAD);
  });
});
