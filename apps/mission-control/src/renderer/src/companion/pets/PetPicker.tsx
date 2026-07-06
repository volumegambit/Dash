import type { JSX } from 'react';
import type { CompanionSelection } from '../../../../shared/ipc.js';
import { CREWS, CREW_KINDS } from './crews.js';
import { PetThumbnail } from './index.js';
import { PET_KINDS } from './kinds.js';
import type { PetKind } from './types.js';

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
  'bubble-tea-maker': 'Bubble Tea Maker',
  sergeant: 'Sergeant',
  scout: 'Scout',
  'combat-medic': 'Combat Medic',
  rifleman: 'Rifleman',
  'rocket-soldier': 'Rocket Soldier',
  'police-officer': 'Police Officer',
  detective: 'Detective',
  'k9-handler': 'K9 Handler',
  swat: 'SWAT',
  'motorcycle-cop': 'Motorcycle Cop',
  firefighter: 'Firefighter',
  'fire-chief': 'Fire Chief',
  'ladder-firefighter': 'Ladder Firefighter',
  'rookie-firefighter': 'Rookie Firefighter',
  'fire-dalmatian': 'Fire Dalmatian',
  baker: 'Baker',
  blacksmith: 'Blacksmith',
  fisherman: 'Fisherman',
  shepherd: 'Shepherd',
  'delivery-courier': 'Delivery Courier',
  farmer: 'Farmer',
  'dairy-farmer': 'Dairy Farmer',
  'fruit-picker': 'Fruit Picker',
  beekeeper: 'Beekeeper',
  scarecrow: 'Scarecrow',
  'sled-pusher': 'Sled Pusher',
  'wall-baller': 'Wall Baller',
  rower: 'Rower',
  'kettlebell-athlete': 'Kettlebell Athlete',
  weightlifter: 'Weightlifter',
};

export function PetPicker({
  value,
  onChange,
}: {
  value: CompanionSelection;
  onChange: (selection: CompanionSelection) => void;
}): JSX.Element {
  return (
    <div className="mt-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Crews</p>
      <div className="flex flex-wrap gap-3">
        {CREW_KINDS.map((crew) => {
          const selection: CompanionSelection = `crew:${crew}`;
          const { label, members } = CREWS[crew];
          return (
            <button
              key={crew}
              type="button"
              aria-pressed={value === selection}
              aria-label={`${label} crew`}
              onClick={() => onChange(selection)}
              className={`flex flex-col items-center gap-1 rounded-lg border p-2 transition-colors ${
                value === selection
                  ? 'border-accent'
                  : 'border-border hover:border-accent/50 hover:bg-card-hover'
              }`}
            >
              <span className="flex gap-0.5">
                {members.map((member) => (
                  <PetThumbnail key={member} kind={member} size={24} />
                ))}
              </span>
              <span className="text-[11px] text-muted">{label}</span>
            </button>
          );
        })}
      </div>

      <p className="mb-2 mt-4 text-[11px] font-medium uppercase tracking-wide text-muted">Pets</p>
      <div className="flex flex-wrap gap-3">
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
    </div>
  );
}
