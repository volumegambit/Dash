import type { PetKind, SquadKind } from '../../../../shared/ipc.js';

export type { SquadKind };

type SquadMembers = readonly [PetKind, PetKind, PetKind, PetKind, PetKind];

export interface Squad {
  label: string;
  members: SquadMembers;
}

/**
 * The nine selectable squads. The widget renders one member per running agent
 * (see {@link squadMembers}), taking members in the display order listed here.
 * The `gym` kind keeps its historical id from the crew era; persisted values
 * must keep parsing (see parseCompanionSelection).
 */
export const SQUADS: Record<SquadKind, Squad> = {
  kitchen: {
    label: 'Kitchen',
    members: ['sous-chef', 'pastry-chef', 'sushi-chef', 'butcher', 'dishwasher'],
  },
  office: {
    label: 'Office',
    members: ['boss', 'accountant', 'intern', 'it-support', 'receptionist'],
  },
  wait: {
    label: 'Wait Staff',
    members: ['waiter', 'barista', 'sommelier', 'bartender', 'bubble-tea-maker'],
  },
  soldier: {
    label: 'Soldiers',
    members: ['sergeant', 'scout', 'combat-medic', 'rifleman', 'rocket-soldier'],
  },
  police: {
    label: 'Police',
    members: ['police-officer', 'detective', 'k9-handler', 'swat', 'motorcycle-cop'],
  },
  fire: {
    label: 'Fire Squad',
    members: [
      'firefighter',
      'fire-chief',
      'ladder-firefighter',
      'rookie-firefighter',
      'fire-dalmatian',
    ],
  },
  villager: {
    label: 'Villagers',
    members: ['baker', 'blacksmith', 'fisherman', 'shepherd', 'delivery-courier'],
  },
  farmer: {
    label: 'Farmers',
    members: ['farmer', 'dairy-farmer', 'fruit-picker', 'beekeeper', 'scarecrow'],
  },
  gym: {
    label: 'Gym',
    members: ['sled-pusher', 'wall-baller', 'rower', 'kettlebell-athlete', 'weightlifter'],
  },
};

/** Squads in picker display order. */
export const SQUAD_KINDS: readonly SquadKind[] = [
  'kitchen',
  'office',
  'wait',
  'soldier',
  'police',
  'fire',
  'villager',
  'farmer',
  'gym',
];

/** Maximum members a squad can show at once (roster size). */
export const SQUAD_SIZE = 5;

/** Squad used when the stored selection is unset or invalid. */
export const DEFAULT_SQUAD: SquadKind = 'kitchen';
