import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CompanionAgentStatus, CompanionSelection } from '../../shared/ipc.js';
import { CompanionSquad } from './companion/pets/CompanionSquad.js';
import { parseCompanionSelection } from './companion/pets/companionSelection.js';
import { DEFAULT_SQUAD } from './companion/pets/squads.js';

/**
 * Squad widget: one member per running agent, each with a speech bubble of
 * that agent's current activity. Selection strings arrive over IPC and are
 * normalized to a squad (legacy pet/crew values included).
 */
function Widget(): JSX.Element {
  const [statuses, setStatuses] = useState<CompanionAgentStatus[]>([]);
  const [selection, setSelection] = useState<CompanionSelection>(DEFAULT_SQUAD);
  useEffect(() => window.api.onCompanionStatuses(setStatuses), []);
  useEffect(() => window.api.onCompanionPet(setSelection), []);

  return <CompanionSquad squad={parseCompanionSelection(selection)} statuses={statuses} />;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
