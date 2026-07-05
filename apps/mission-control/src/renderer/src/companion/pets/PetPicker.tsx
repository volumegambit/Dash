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
};

export function PetPicker({
  value,
  onChange,
}: {
  value: PetKind;
  onChange: (kind: PetKind) => void;
}): JSX.Element {
  return (
    <div className="mt-3 flex max-h-72 flex-wrap gap-3 overflow-y-auto pr-2">
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
