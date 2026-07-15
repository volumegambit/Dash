import type { JSX } from 'react';
import type { PetKind } from '../../../../shared/ipc.js';
import { AnimatedPixelPet } from './AnimatedPixelPet.js';
import { accountantAnimated } from './accountantAnimated.js';
import { bakerAnimated } from './bakerAnimated.js';
import { baristaAnimated } from './baristaAnimated.js';
import { bartenderAnimated } from './bartenderAnimated.js';
import { beekeeperAnimated } from './beekeeperAnimated.js';
import { blacksmithAnimated } from './blacksmithAnimated.js';
import { bossAnimated } from './bossAnimated.js';
import { bubbleTeaMakerAnimated } from './bubbleTeaMakerAnimated.js';
import { butcherAnimated } from './butcherAnimated.js';
import { combatMedicAnimated } from './combatMedicAnimated.js';
import { dairyFarmerAnimated } from './dairyFarmerAnimated.js';
import { deliveryCourierAnimated } from './deliveryCourierAnimated.js';
import { detectiveAnimated } from './detectiveAnimated.js';
import { dishwasherAnimated } from './dishwasherAnimated.js';
import { farmerAnimated } from './farmerAnimated.js';
import { fireChiefAnimated } from './fireChiefAnimated.js';
import { fireDalmatianAnimated } from './fireDalmatianAnimated.js';
import { firefighterAnimated } from './firefighterAnimated.js';
import { fishermanAnimated } from './fishermanAnimated.js';
import { fruitPickerAnimated } from './fruitPickerAnimated.js';
import { internAnimated } from './internAnimated.js';
import { itSupportAnimated } from './itSupportAnimated.js';
import { k9HandlerAnimated } from './k9HandlerAnimated.js';
import { kettlebellAthleteAnimated } from './kettlebellAthleteAnimated.js';
import { PET_KINDS } from './kinds.js';
import { ladderFirefighterAnimated } from './ladderFirefighterAnimated.js';
import { motorcycleCopAnimated } from './motorcycleCopAnimated.js';
import { pastryChefAnimated } from './pastryChefAnimated.js';
import { policeOfficerAnimated } from './policeOfficerAnimated.js';
import { receptionistAnimated } from './receptionistAnimated.js';
import { riflemanAnimated } from './riflemanAnimated.js';
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
import { sushiChefAnimated } from './sushiChefAnimated.js';
import { swatAnimated } from './swatAnimated.js';
import type { AnimatedPetSprite } from './types.js';
import { waiterAnimated } from './waiterAnimated.js';
import { wallBallerAnimated } from './wallBallerAnimated.js';
import { weightlifterAnimated } from './weightlifterAnimated.js';

export { PET_KINDS };

export const PET_REGISTRY: Record<PetKind, AnimatedPetSprite> = {
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

/** Small idle-mood preview for the settings picker. */
export function PetThumbnail({ kind, size = 48 }: { kind: PetKind; size?: number }): JSX.Element {
  return <AnimatedPixelPet sprite={PET_REGISTRY[kind]} mood="idle" size={size} />;
}
