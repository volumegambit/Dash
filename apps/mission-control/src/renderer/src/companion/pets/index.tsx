import type { JSX } from 'react';
import type { CompanionStatus, PetKind } from '../../../../shared/ipc.js';
import { aggregateMood } from '../aggregateMood.js';
import { AnimatedPixelPet } from './AnimatedPixelPet.js';
import { catAnimated } from './catAnimated.js';
import { dogAnimated } from './dogAnimated.js';
import { DEFAULT_PET, PET_KINDS } from './kinds.js';
import { redPandaAnimated } from './redPandaAnimated.js';
import type { AnimatedPetSprite } from './types.js';

export { DEFAULT_PET, PET_KINDS };

export const PET_REGISTRY: Record<PetKind, AnimatedPetSprite> = {
  cat: catAnimated,
  dog: dogAnimated,
  'red-panda': redPandaAnimated,
};

function spriteFor(kind: PetKind): AnimatedPetSprite {
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
  return <AnimatedPixelPet sprite={spriteFor(kind)} mood={aggregateMood(statuses)} size={size} />;
}

/** Small idle-mood preview for the settings picker. */
export function PetThumbnail({ kind, size = 48 }: { kind: PetKind; size?: number }): JSX.Element {
  return <AnimatedPixelPet sprite={spriteFor(kind)} mood="idle" size={size} />;
}
