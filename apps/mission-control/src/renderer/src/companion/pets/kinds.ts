import type { PetKind } from '../../../../shared/ipc.js';

/** All selectable pets, in picker display order. */
export const PET_KINDS: readonly PetKind[] = [
  'astronaut',
  'bear',
  'beauty-guru',
  'bigfoot',
  'bollywood-star',
  'cat',
  'chef',
  'dog',
  'fitness-influencer',
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
  'streamer',
  'tech-reviewer',
  'travel-vlogger',
  'unicorn',
  'wizard',
  'wok-uncle',
];

/** Pet used when the stored value is unset or invalid. */
export const DEFAULT_PET: PetKind = 'red-panda';
