import type { PetKind } from '../../../../shared/ipc.js';

/** All selectable pets, in picker display order. */
export const PET_KINDS: readonly PetKind[] = [
  'astronaut',
  'bear',
  'bigfoot',
  'bollywood-star',
  'cat',
  'chef',
  'dog',
  'fortune-god',
  'knight',
  'lion',
  'maneki-neko',
  'merlion',
  'ninja',
  'pig',
  'pirate',
  'quokka',
  'rabbit',
  'red-panda',
  'robot',
  'royal-guard',
  'unicorn',
  'wizard',
];

/** Pet used when the stored value is unset or invalid. */
export const DEFAULT_PET: PetKind = 'red-panda';
