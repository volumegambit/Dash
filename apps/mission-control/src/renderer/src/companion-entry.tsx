import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CompanionAgentStatus, CompanionSelection } from '../../shared/ipc.js';
import { aggregateMood } from './companion/aggregateMood.js';
import { CompanionCrew } from './companion/pets/CompanionCrew.js';
import { CompanionSpeechBubble } from './companion/pets/CompanionSpeechBubble.js';
import { parseCompanionSelection } from './companion/pets/companionSelection.js';
import { CompanionPet, DEFAULT_PET } from './companion/pets/index.js';
import { useBubbleVisible } from './companion/pets/useBubbleVisible.js';

/**
 * Single-pet widget: the pet (mood = aggregate of all sessions) plus one speech
 * bubble surfacing the dominant session's activity. `statuses` is already
 * ordered by attention priority (error > needs > working > done) then recency,
 * so the first entry is the one to preview.
 */
function CompanionSinglePet({
  selection,
  statuses,
}: {
  selection: CompanionSelection;
  statuses: CompanionAgentStatus[];
}): JSX.Element {
  const mood = aggregateMood(statuses.map((s) => s.status));
  const preview = statuses[0]?.preview ?? '';
  const visible = useBubbleVisible(mood);
  const parsed = parseCompanionSelection(selection);
  const kind = parsed.type === 'pet' ? parsed.pet : DEFAULT_PET;
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
      }}
    >
      <CompanionSpeechBubble text={preview} mood={mood} visible={visible} />
      <CompanionPet kind={kind} statuses={statuses.map((s) => s.status)} size={128} />
    </div>
  );
}

function Widget(): JSX.Element {
  const [statuses, setStatuses] = useState<CompanionAgentStatus[]>([]);
  const [selection, setSelection] = useState<CompanionSelection>(DEFAULT_PET);
  useEffect(() => window.api.onCompanionStatuses(setStatuses), []);
  useEffect(() => window.api.onCompanionPet(setSelection), []);

  const parsed = parseCompanionSelection(selection);
  if (parsed.type === 'crew') {
    return <CompanionCrew crew={parsed.crew} statuses={statuses} />;
  }
  return <CompanionSinglePet selection={selection} statuses={statuses} />;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
