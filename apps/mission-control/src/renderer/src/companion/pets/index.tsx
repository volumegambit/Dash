import type { JSX } from 'react';
import type { CompanionStatus, PetKind } from '../../../../shared/ipc.js';
import { aggregateMood } from '../aggregateMood.js';
import { AnimatedPixelPet } from './AnimatedPixelPet.js';
import { accountantAnimated } from './accountantAnimated.js';
import { astronautAnimated } from './astronautAnimated.js';
import { bakerAnimated } from './bakerAnimated.js';
import { baristaAnimated } from './baristaAnimated.js';
import { bartenderAnimated } from './bartenderAnimated.js';
import { bearAnimated } from './bearAnimated.js';
import { beautyGuruAnimated } from './beautyAnimated.js';
import { beekeeperAnimated } from './beekeeperAnimated.js';
import { bigfootAnimated } from './bigfootAnimated.js';
import { blacksmithAnimated } from './blacksmithAnimated.js';
import { bollywoodStarAnimated } from './bollywoodAnimated.js';
import { bossAnimated } from './bossAnimated.js';
import { bubbleTeaMakerAnimated } from './bubbleTeaMakerAnimated.js';
import { butcherAnimated } from './butcherAnimated.js';
import { catAnimated } from './catAnimated.js';
import { chefAnimated } from './chefAnimated.js';
import { combatMedicAnimated } from './combatMedicAnimated.js';
import { dairyFarmerAnimated } from './dairyFarmerAnimated.js';
import { deliveryCourierAnimated } from './deliveryCourierAnimated.js';
import { detectiveAnimated } from './detectiveAnimated.js';
import { dishwasherAnimated } from './dishwasherAnimated.js';
import { dogAnimated } from './dogAnimated.js';
import { farmerAnimated } from './farmerAnimated.js';
import { fireChiefAnimated } from './fireChiefAnimated.js';
import { fireDalmatianAnimated } from './fireDalmatianAnimated.js';
import { firefighterAnimated } from './firefighterAnimated.js';
import { fishermanAnimated } from './fishermanAnimated.js';
import { fitnessInfluencerAnimated } from './fitnessAnimated.js';
import { fortuneGodAnimated } from './fortuneAnimated.js';
import { fruitPickerAnimated } from './fruitPickerAnimated.js';
import { royalGuardAnimated } from './guardAnimated.js';
import { internAnimated } from './internAnimated.js';
import { itSupportAnimated } from './itSupportAnimated.js';
import { k9HandlerAnimated } from './k9HandlerAnimated.js';
import { kettlebellAthleteAnimated } from './kettlebellAthleteAnimated.js';
import { DEFAULT_PET, PET_KINDS } from './kinds.js';
import { knightAnimated } from './knightAnimated.js';
import { ladderFirefighterAnimated } from './ladderFirefighterAnimated.js';
import { lionAnimated } from './lionAnimated.js';
import { manekiNekoAnimated } from './manekiAnimated.js';
import { merlionAnimated } from './merlionAnimated.js';
import { motorcycleCopAnimated } from './motorcycleCopAnimated.js';
import { ninjaAnimated } from './ninjaAnimated.js';
import { pastryChefAnimated } from './pastryChefAnimated.js';
import { pigAnimated } from './pigAnimated.js';
import { pirateAnimated } from './pirateAnimated.js';
import { policeOfficerAnimated } from './policeOfficerAnimated.js';
import { quokkaAnimated } from './quokkaAnimated.js';
import { rabbitAnimated } from './rabbitAnimated.js';
import { receptionistAnimated } from './receptionistAnimated.js';
import { redPandaAnimated } from './redPandaAnimated.js';
import { riflemanAnimated } from './riflemanAnimated.js';
import { robotAnimated } from './robotAnimated.js';
import { rocketSoldierAnimated } from './rocketSoldierAnimated.js';
import { rookieFirefighterAnimated } from './rookieFirefighterAnimated.js';
import { rowerAnimated } from './rowerAnimated.js';
import { scarecrowAnimated } from './scarecrowAnimated.js';
import { scoutAnimated } from './scoutAnimated.js';
import { sergeantAnimated } from './sergeantAnimated.js';
import { shepherdAnimated } from './shepherdAnimated.js';
import { sledPusherAnimated } from './sledPusherAnimated.js';
import { sommelierAnimated } from './sommelierAnimated.js';
import { sousChefAnimated } from './sousChefAnimated.js';
import { streamerAnimated } from './streamerAnimated.js';
import { sushiChefAnimated } from './sushiChefAnimated.js';
import { swatAnimated } from './swatAnimated.js';
import { techReviewerAnimated } from './techAnimated.js';
import { travelVloggerAnimated } from './travelAnimated.js';
import type { AnimatedPetSprite } from './types.js';
import { unicornAnimated } from './unicornAnimated.js';
import { waiterAnimated } from './waiterAnimated.js';
import { wallBallerAnimated } from './wallBallerAnimated.js';
import { weightlifterAnimated } from './weightlifterAnimated.js';
import { wizardAnimated } from './wizardAnimated.js';
import { wokUncleAnimated } from './wokuncleAnimated.js';

export { DEFAULT_PET, PET_KINDS };

export const PET_REGISTRY: Record<PetKind, AnimatedPetSprite> = {
  astronaut: astronautAnimated,
  bear: bearAnimated,
  'beauty-guru': beautyGuruAnimated,
  bigfoot: bigfootAnimated,
  'bollywood-star': bollywoodStarAnimated,
  cat: catAnimated,
  chef: chefAnimated,
  dog: dogAnimated,
  'fitness-influencer': fitnessInfluencerAnimated,
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
  streamer: streamerAnimated,
  'tech-reviewer': techReviewerAnimated,
  'travel-vlogger': travelVloggerAnimated,
  unicorn: unicornAnimated,
  wizard: wizardAnimated,
  'wok-uncle': wokUncleAnimated,
  'sous-chef': sousChefAnimated,
  'pastry-chef': pastryChefAnimated,
  'sushi-chef': sushiChefAnimated,
  butcher: butcherAnimated,
  dishwasher: dishwasherAnimated,
  boss: bossAnimated,
  accountant: accountantAnimated,
  intern: internAnimated,
  'it-support': itSupportAnimated,
  receptionist: receptionistAnimated,
  waiter: waiterAnimated,
  barista: baristaAnimated,
  sommelier: sommelierAnimated,
  bartender: bartenderAnimated,
  'bubble-tea-maker': bubbleTeaMakerAnimated,
  sergeant: sergeantAnimated,
  scout: scoutAnimated,
  'combat-medic': combatMedicAnimated,
  rifleman: riflemanAnimated,
  'rocket-soldier': rocketSoldierAnimated,
  'police-officer': policeOfficerAnimated,
  detective: detectiveAnimated,
  'k9-handler': k9HandlerAnimated,
  swat: swatAnimated,
  'motorcycle-cop': motorcycleCopAnimated,
  firefighter: firefighterAnimated,
  'fire-chief': fireChiefAnimated,
  'ladder-firefighter': ladderFirefighterAnimated,
  'rookie-firefighter': rookieFirefighterAnimated,
  'fire-dalmatian': fireDalmatianAnimated,
  baker: bakerAnimated,
  blacksmith: blacksmithAnimated,
  fisherman: fishermanAnimated,
  shepherd: shepherdAnimated,
  'delivery-courier': deliveryCourierAnimated,
  farmer: farmerAnimated,
  'dairy-farmer': dairyFarmerAnimated,
  'fruit-picker': fruitPickerAnimated,
  beekeeper: beekeeperAnimated,
  scarecrow: scarecrowAnimated,
  'sled-pusher': sledPusherAnimated,
  'wall-baller': wallBallerAnimated,
  rower: rowerAnimated,
  'kettlebell-athlete': kettlebellAthleteAnimated,
  weightlifter: weightlifterAnimated,
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
