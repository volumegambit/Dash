import { expect, test } from 'vitest';
import { PET_REGISTRY } from './index.js';
import { DEFAULT_SQUAD, SQUADS, SQUAD_KINDS } from './squads.js';

test('there are nine squads and SQUAD_KINDS lists each exactly once', () => {
  const keys = Object.keys(SQUADS);
  expect(keys).toHaveLength(9);
  expect([...SQUAD_KINDS].sort()).toEqual(keys.sort());
});

test('the default squad is a known squad', () => {
  expect(SQUAD_KINDS).toContain(DEFAULT_SQUAD);
});

test('every squad has five distinct members that all exist in the registry', () => {
  for (const kind of SQUAD_KINDS) {
    const { members } = SQUADS[kind];
    expect(members, kind).toHaveLength(5);
    expect(new Set(members).size, `${kind} has duplicate members`).toBe(5);
    for (const member of members) {
      expect(PET_REGISTRY[member], `${kind} member ${member}`).toBeDefined();
    }
  }
});

test('each squad has a human label', () => {
  for (const kind of SQUAD_KINDS) {
    expect(SQUADS[kind].label.length, kind).toBeGreaterThan(0);
  }
});

test('exact rosters match the product spec', () => {
  expect(SQUADS.kitchen.members).toEqual([
    'sous-chef',
    'pastry-chef',
    'sushi-chef',
    'butcher',
    'dishwasher',
  ]);
  expect(SQUADS.office.members).toEqual([
    'boss',
    'accountant',
    'intern',
    'it-support',
    'receptionist',
  ]);
  expect(SQUADS.wait.members).toEqual([
    'waiter',
    'barista',
    'sommelier',
    'bartender',
    'bubble-tea-maker',
  ]);
  expect(SQUADS.soldier.members).toEqual([
    'sergeant',
    'scout',
    'combat-medic',
    'rifleman',
    'rocket-soldier',
  ]);
  expect(SQUADS.police.members).toEqual([
    'police-officer',
    'detective',
    'k9-handler',
    'swat',
    'motorcycle-cop',
  ]);
  expect(SQUADS.fire.members).toEqual([
    'firefighter',
    'fire-chief',
    'ladder-firefighter',
    'rookie-firefighter',
    'fire-dalmatian',
  ]);
  expect(SQUADS.villager.members).toEqual([
    'baker',
    'blacksmith',
    'fisherman',
    'shepherd',
    'delivery-courier',
  ]);
  expect(SQUADS.farmer.members).toEqual([
    'farmer',
    'dairy-farmer',
    'fruit-picker',
    'beekeeper',
    'scarecrow',
  ]);
  expect(SQUADS.gym.members).toEqual([
    'sled-pusher',
    'wall-baller',
    'rower',
    'kettlebell-athlete',
    'weightlifter',
  ]);
});
