import type { JSX } from 'react';
import type { CompanionStatus, PetKind } from '../../../../shared/ipc.js';
import { aggregateMood } from '../aggregateMood.js';
import { PixelPet } from './PixelPet.js';
import { cat } from './cat.js';
import { DEFAULT_PET, PET_KINDS } from './kinds.js';
import { redPanda } from './redPanda.js';
import type { PetSprite } from './types.js';

export { DEFAULT_PET, PET_KINDS };

export const PET_REGISTRY: Record<PetKind, PetSprite> = {
  cat,
  'red-panda': redPanda,
};

function spriteFor(kind: PetKind): PetSprite {
  return PET_REGISTRY[kind] ?? PET_REGISTRY[DEFAULT_PET];
}

/** The floating widget's pet: current selection driven by aggregate session mood. */
export function CompanionPet({
  kind,
  statuses,
  size,
}: {
  kind: PetKind;
  statuses: CompanionStatus[];
  size?: number;
}): JSX.Element {
  return <PixelPet sprite={spriteFor(kind)} mood={aggregateMood(statuses)} size={size} />;
}

/** Small idle-mood preview for the settings picker. */
export function PetThumbnail({ kind, size = 48 }: { kind: PetKind; size?: number }): JSX.Element {
  return <PixelPet sprite={spriteFor(kind)} mood="idle" size={size} />;
}
