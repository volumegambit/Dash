import type { JSX } from 'react';
import type { CompanionStatus, PetKind } from '../../../../shared/ipc.js';
import { aggregateMood } from '../aggregateMood.js';
import { AnimatedPixelPet } from './AnimatedPixelPet.js';
import { astronautAnimated } from './astronautAnimated.js';
import { bearAnimated } from './bearAnimated.js';
import { bigfootAnimated } from './bigfootAnimated.js';
import { bollywoodStarAnimated } from './bollywoodAnimated.js';
import { catAnimated } from './catAnimated.js';
import { chefAnimated } from './chefAnimated.js';
import { dogAnimated } from './dogAnimated.js';
import { fortuneGodAnimated } from './fortuneAnimated.js';
import { royalGuardAnimated } from './guardAnimated.js';
import { DEFAULT_PET, PET_KINDS } from './kinds.js';
import { knightAnimated } from './knightAnimated.js';
import { lionAnimated } from './lionAnimated.js';
import { manekiNekoAnimated } from './manekiAnimated.js';
import { merlionAnimated } from './merlionAnimated.js';
import { ninjaAnimated } from './ninjaAnimated.js';
import { pigAnimated } from './pigAnimated.js';
import { pirateAnimated } from './pirateAnimated.js';
import { quokkaAnimated } from './quokkaAnimated.js';
import { rabbitAnimated } from './rabbitAnimated.js';
import { redPandaAnimated } from './redPandaAnimated.js';
import { robotAnimated } from './robotAnimated.js';
import type { AnimatedPetSprite } from './types.js';
import { unicornAnimated } from './unicornAnimated.js';
import { wizardAnimated } from './wizardAnimated.js';

export { DEFAULT_PET, PET_KINDS };

export const PET_REGISTRY: Record<PetKind, AnimatedPetSprite> = {
  astronaut: astronautAnimated,
  bear: bearAnimated,
  bigfoot: bigfootAnimated,
  'bollywood-star': bollywoodStarAnimated,
  cat: catAnimated,
  chef: chefAnimated,
  dog: dogAnimated,
  'fortune-god': fortuneGodAnimated,
  knight: knightAnimated,
  lion: lionAnimated,
  'maneki-neko': manekiNekoAnimated,
  merlion: merlionAnimated,
  ninja: ninjaAnimated,
  pig: pigAnimated,
  pirate: pirateAnimated,
  quokka: quokkaAnimated,
  rabbit: rabbitAnimated,
  'red-panda': redPandaAnimated,
  robot: robotAnimated,
  'royal-guard': royalGuardAnimated,
  unicorn: unicornAnimated,
  wizard: wizardAnimated,
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
