import type { JSX } from 'react';
import type { PetKind } from '../../../../shared/ipc.js';
import { PetThumbnail } from './index.js';
import { PET_KINDS } from './kinds.js';

const LABEL: Record<PetKind, string> = { cat: 'Cat', dog: 'Dog', 'red-panda': 'Red panda' };

export function PetPicker({
  value,
  onChange,
}: {
  value: PetKind;
  onChange: (kind: PetKind) => void;
}): JSX.Element {
  return (
    <div className="mt-3 flex gap-3">
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
