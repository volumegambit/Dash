import type { CompanionSelection, CrewKind, PetKind } from '../../../../shared/ipc.js';
import { CREW_KINDS } from './crews.js';
import { DEFAULT_PET, PET_KINDS } from './kinds.js';

/** A parsed companion selection: a single pet or a whole crew. */
export type ParsedSelection = { type: 'pet'; pet: PetKind } | { type: 'crew'; crew: CrewKind };

const CREW_PREFIX = 'crew:';

function isPetKind(v: string): v is PetKind {
  return (PET_KINDS as readonly string[]).includes(v);
}

function isCrewKind(v: string): v is CrewKind {
  return (CREW_KINDS as readonly string[]).includes(v);
}

/**
 * Parse a persisted/IPC selection string into a discriminated union, falling
 * back to the default pet for anything unrecognized. Old persisted `PetKind`
 * strings (no `crew:` prefix) parse as `{ type: 'pet' }` unchanged.
 */
export function parseCompanionSelection(raw: string | null): ParsedSelection {
  if (raw) {
    if (raw.startsWith(CREW_PREFIX)) {
      const crew = raw.slice(CREW_PREFIX.length);
      if (isCrewKind(crew)) return { type: 'crew', crew };
    } else if (isPetKind(raw)) {
      return { type: 'pet', pet: raw };
    }
  }
  return { type: 'pet', pet: DEFAULT_PET };
}

/** Serialize a parsed selection back to its `CompanionSelection` string. */
export function serializeCompanionSelection(selection: ParsedSelection): CompanionSelection {
  return selection.type === 'crew' ? `crew:${selection.crew}` : selection.pet;
}
