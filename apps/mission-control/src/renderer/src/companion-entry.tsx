import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CompanionStatus } from '../../shared/ipc.js';
import { CompanionTree } from './companion/CompanionTree.js';

function Widget(): JSX.Element {
  const [statuses, setStatuses] = useState<CompanionStatus[]>([]);
  useEffect(() => window.api.onCompanionStatuses(setStatuses), []);
  return <CompanionTree statuses={statuses} size={128} />;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
