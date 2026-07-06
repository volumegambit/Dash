import type { CrewKind, PetKind } from '../../../../shared/ipc.js';

export type { CrewKind };

type CrewMembers = readonly [PetKind, PetKind, PetKind, PetKind, PetKind];

export interface Crew {
  label: string;
  members: CrewMembers;
}

/**
 * The nine selectable crews. Each renders five pets side by side, one per
 * running agent (see {@link crewMoods}). Members are listed in display order.
 * The `gym` kind is named to avoid clashing with the standalone
 * `fitness-influencer` pet.
 */
export const CREWS: Record<CrewKind, Crew> = {
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
    label: 'Fire Crew',
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

/** Crews in picker display order. */
export const CREW_KINDS: readonly CrewKind[] = [
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

/** Number of pets in every crew (fleet size). */
export const CREW_SIZE = 5;
