import type { CompanionStatus } from '../../../shared/ipc.js';
import type { Mood } from './pets/types.js';

/**
 * Collapse per-session statuses into one widget mood by attention priority:
 * error > needs > working > done > idle. `done` means sessions exist and none
 * are error/needs/working; `idle` means there are no sessions at all.
 */
export function aggregateMood(statuses: CompanionStatus[]): Mood {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('needs')) return 'needs';
  if (statuses.includes('working')) return 'working';
  if (statuses.length > 0) return 'done';
  return 'idle';
}
