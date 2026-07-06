import { expect, test } from 'vitest';
import { CREWS, CREW_KINDS } from './crews.js';
import { PET_REGISTRY } from './index.js';

test('there are nine crews and CREW_KINDS lists each exactly once', () => {
  const keys = Object.keys(CREWS);
  expect(keys).toHaveLength(9);
  expect([...CREW_KINDS].sort()).toEqual(keys.sort());
});

test('every crew has five distinct members that all exist in the registry', () => {
  for (const kind of CREW_KINDS) {
    const { members } = CREWS[kind];
    expect(members, kind).toHaveLength(5);
    expect(new Set(members).size, `${kind} has duplicate members`).toBe(5);
    for (const member of members) {
      expect(PET_REGISTRY[member], `${kind} member ${member}`).toBeDefined();
    }
  }
});

test('each crew has a human label', () => {
  for (const kind of CREW_KINDS) {
    expect(CREWS[kind].label.length, kind).toBeGreaterThan(0);
  }
});

test('exact rosters match the product spec', () => {
  expect(CREWS.kitchen.members).toEqual([
    'sous-chef',
    'pastry-chef',
    'sushi-chef',
    'butcher',
    'dishwasher',
  ]);
  expect(CREWS.office.members).toEqual([
    'boss',
    'accountant',
    'intern',
    'it-support',
    'receptionist',
  ]);
  expect(CREWS.wait.members).toEqual([
    'waiter',
    'barista',
    'sommelier',
    'bartender',
    'bubble-tea-maker',
  ]);
  expect(CREWS.soldier.members).toEqual([
    'sergeant',
    'scout',
    'combat-medic',
    'rifleman',
    'rocket-soldier',
  ]);
  expect(CREWS.police.members).toEqual([
    'police-officer',
    'detective',
    'k9-handler',
    'swat',
    'motorcycle-cop',
  ]);
  expect(CREWS.fire.members).toEqual([
    'firefighter',
    'fire-chief',
    'ladder-firefighter',
    'rookie-firefighter',
    'fire-dalmatian',
  ]);
  expect(CREWS.villager.members).toEqual([
    'baker',
    'blacksmith',
    'fisherman',
    'shepherd',
    'delivery-courier',
  ]);
  expect(CREWS.farmer.members).toEqual([
    'farmer',
    'dairy-farmer',
    'fruit-picker',
    'beekeeper',
    'scarecrow',
  ]);
  expect(CREWS.gym.members).toEqual([
    'sled-pusher',
    'wall-baller',
    'rower',
    'kettlebell-athlete',
    'weightlifter',
  ]);
});
