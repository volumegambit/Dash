import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CompanionStatus, PetKind } from '../../shared/ipc.js';
import { CompanionPet, DEFAULT_PET } from './companion/pets/index.js';

function Widget(): JSX.Element {
  const [statuses, setStatuses] = useState<CompanionStatus[]>([]);
  const [pet, setPet] = useState<PetKind>(DEFAULT_PET);
  useEffect(() => window.api.onCompanionStatuses(setStatuses), []);
  useEffect(() => window.api.onCompanionPet(setPet), []);
  return <CompanionPet kind={pet} statuses={statuses} size={128} />;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
