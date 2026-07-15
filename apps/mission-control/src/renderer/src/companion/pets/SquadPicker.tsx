import type { JSX } from 'react';
import type { CompanionSelection } from '../../../../shared/ipc.js';
import { PetThumbnail } from './index.js';
import { SQUADS, SQUAD_KINDS } from './squads.js';

export function SquadPicker({
  value,
  onChange,
}: {
  value: CompanionSelection;
  onChange: (selection: CompanionSelection) => void;
}): JSX.Element {
  return (
    <div className="mt-3">
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Squads</p>
      <div className="flex flex-wrap gap-3">
        {SQUAD_KINDS.map((squad) => {
          const { label, members } = SQUADS[squad];
          return (
            <button
              key={squad}
              type="button"
              aria-pressed={value === squad}
              aria-label={`${label} squad`}
              onClick={() => onChange(squad)}
              className={`flex flex-col items-center gap-1 rounded-lg border p-2 transition-colors ${
                value === squad
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
    </div>
  );
}
