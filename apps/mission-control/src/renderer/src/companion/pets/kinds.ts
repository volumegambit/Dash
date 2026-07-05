import type { PetKind } from '../../../../shared/ipc.js';

/** All selectable pets, in picker display order. */
export const PET_KINDS: readonly PetKind[] = ['cat', 'red-panda'];

/** Pet used when the stored value is unset or invalid. */
export const DEFAULT_PET: PetKind = 'red-panda';
