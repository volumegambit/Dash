import type { CompanionSelection, SquadKind } from '../../../../shared/ipc.js';
import { DEFAULT_SQUAD, SQUAD_KINDS } from './squads.js';

/** Legacy prefix from the era when squads were called crews (`crew:kitchen`). */
const LEGACY_CREW_PREFIX = 'crew:';

function isSquadKind(v: string): v is SquadKind {
  return (SQUAD_KINDS as readonly string[]).includes(v);
}

/**
 * Normalize a persisted/IPC selection string to a squad. Legacy values keep
 * working: `crew:<kind>` (the old crew selection) parses as `<kind>`, and
 * anything unrecognized — including pet ids from the retired single-pet mode —
 * falls back to the default squad.
 */
export function parseCompanionSelection(raw: string | null): CompanionSelection {
  if (raw) {
    const kind = raw.startsWith(LEGACY_CREW_PREFIX) ? raw.slice(LEGACY_CREW_PREFIX.length) : raw;
    if (isSquadKind(kind)) return kind;
  }
  return DEFAULT_SQUAD;
}
