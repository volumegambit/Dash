import type { JSX } from 'react';
import type { CompanionStatus, PetKind } from '../../../../shared/ipc.js';
import { aggregateMood } from '../aggregateMood.js';
import { AnimatedPixelPet } from './AnimatedPixelPet.js';
import { PixelPet } from './PixelPet.js';
import { cat } from './cat.js';
import { DEFAULT_PET, PET_KINDS } from './kinds.js';
import { redPandaAnimated } from './redPandaAnimated.js';
import type { AnyPetSprite, Mood } from './types.js';
import { isAnimatedPetSprite } from './types.js';

export { DEFAULT_PET, PET_KINDS };

export const PET_REGISTRY: Record<PetKind, AnyPetSprite> = {
  cat,
  'red-panda': redPandaAnimated,
};

function spriteFor(kind: PetKind): AnyPetSprite {
  return PET_REGISTRY[kind] ?? PET_REGISTRY[DEFAULT_PET];
}

/** Render any pet — grid pets go through PixelPet, frame-based pets animate. */
function Pet({
  sprite,
  mood,
  size,
}: { sprite: AnyPetSprite; mood: Mood; size?: number }): JSX.Element {
  return isAnimatedPetSprite(sprite) ? (
    <AnimatedPixelPet sprite={sprite} mood={mood} size={size} />
  ) : (
    <PixelPet sprite={sprite} mood={mood} size={size} />
  );
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
  return <Pet sprite={spriteFor(kind)} mood={aggregateMood(statuses)} size={size} />;
}

/** Small idle-mood preview for the settings picker. */
export function PetThumbnail({ kind, size = 48 }: { kind: PetKind; size?: number }): JSX.Element {
  return <Pet sprite={spriteFor(kind)} mood="idle" size={size} />;
}
