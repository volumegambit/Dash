import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CompanionAgentStatus, PetKind } from '../../shared/ipc.js';
import { CompanionPet, DEFAULT_PET } from './companion/pets/index.js';

function Widget(): JSX.Element {
  const [statuses, setStatuses] = useState<CompanionAgentStatus[]>([]);
  const [pet, setPet] = useState<PetKind>(DEFAULT_PET);
  useEffect(() => window.api.onCompanionStatuses(setStatuses), []);
  useEffect(() => window.api.onCompanionPet(setPet), []);
  // Single-pet path: the aggregate mood derives from the bare status list, so
  // existing behavior is unchanged by the richer per-agent payload.
  return <CompanionPet kind={pet} statuses={statuses.map((s) => s.status)} size={128} />;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
