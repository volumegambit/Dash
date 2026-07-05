import type { JSX } from 'react';
import type { PetKind } from '../../../../shared/ipc.js';
import { PetThumbnail } from './index.js';
import { PET_KINDS } from './kinds.js';

const LABEL: Record<PetKind, string> = {
  astronaut: 'Astronaut',
  bear: 'Bear',
  'beauty-guru': 'Beauty Guru',
  bigfoot: 'Bigfoot',
  'bollywood-star': 'Bollywood Star',
  cat: 'Cat',
  chef: 'Chef',
  dog: 'Dog',
  'fitness-influencer': 'Fitness Influencer',
  'fortune-god': 'Fortune God',
  knight: 'Knight',
  lion: 'Lion',
  'maneki-neko': 'Maneki-neko',
  merlion: 'Merlion',
  ninja: 'Ninja',
  pig: 'Pig',
  pirate: 'Pirate',
  quokka: 'Quokka',
  rabbit: 'Rabbit',
  'red-panda': 'Red panda',
  robot: 'Robot',
  'royal-guard': 'Royal Guard',
  streamer: 'Streamer',
  'tech-reviewer': 'Tech Reviewer',
  'travel-vlogger': 'Travel Vlogger',
  unicorn: 'Unicorn',
  wizard: 'Wizard',
  'wok-uncle': 'Wok Uncle',
  'sous-chef': 'Sous Chef',
  'pastry-chef': 'Pastry Chef',
  'sushi-chef': 'Sushi Chef',
  butcher: 'Butcher',
  dishwasher: 'Dishwasher',
  boss: 'Boss',
  accountant: 'Accountant',
  intern: 'Intern',
  'it-support': 'IT Support',
  receptionist: 'Receptionist',
  waiter: 'Waiter',
  barista: 'Barista',
  sommelier: 'Sommelier',
  bartender: 'Bartender',
  hostess: 'Hostess',
  sergeant: 'Sergeant',
  scout: 'Scout',
  'combat-medic': 'Combat Medic',
  'radio-operator': 'Radio Operator',
  general: 'General',
  'police-officer': 'Police Officer',
  detective: 'Detective',
  'k9-handler': 'K9 Handler',
  swat: 'SWAT',
  'police-chief': 'Police Chief',
  firefighter: 'Firefighter',
  'fire-chief': 'Fire Chief',
  'ladder-firefighter': 'Ladder Firefighter',
  'rookie-firefighter': 'Rookie Firefighter',
  'fire-dalmatian': 'Fire Dalmatian',
  baker: 'Baker',
  blacksmith: 'Blacksmith',
  fisherman: 'Fisherman',
  shepherd: 'Shepherd',
  'town-crier': 'Town Crier',
  farmer: 'Farmer',
  'dairy-farmer': 'Dairy Farmer',
  'fruit-picker': 'Fruit Picker',
  beekeeper: 'Beekeeper',
  scarecrow: 'Scarecrow',
};

export function PetPicker({
  value,
  onChange,
}: {
  value: PetKind;
  onChange: (kind: PetKind) => void;
}): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap gap-3">
      {PET_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={value === kind}
          onClick={() => onChange(kind)}
          className={`flex flex-col items-center gap-1 rounded-lg border p-2 transition-colors ${
            value === kind
              ? 'border-accent'
              : 'border-border hover:border-accent/50 hover:bg-card-hover'
          }`}
        >
          <PetThumbnail kind={kind} size={48} />
          <span className="text-[11px] text-muted">{LABEL[kind]}</span>
        </button>
      ))}
    </div>
  );
}
