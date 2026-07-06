import type { JSX } from 'react';
import type { CompanionAgentStatus } from '../../../../shared/ipc.js';
import { AnimatedPixelPet } from './AnimatedPixelPet.js';
import { CompanionSpeechBubble } from './CompanionSpeechBubble.js';
import { crewMembers } from './crewMoods.js';
import { CREWS, CREW_SIZE, type CrewKind } from './crews.js';
import { PET_REGISTRY } from './index.js';
import type { Mood, PetKind } from './types.js';
import { useBubbleVisible } from './useBubbleVisible.js';

/** Per-member sprite size in the fleet row. */
const MEMBER_SIZE = 88;

/** One fleet slot: the pet plus its (optional) activity bubble. */
function CrewMemberPet({
  kind,
  mood,
  preview,
  staggered,
}: {
  kind: PetKind;
  mood: Mood;
  preview: string;
  staggered: boolean;
}): JSX.Element {
  const visible = useBubbleVisible(mood);
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        justifyContent: 'center',
        // Stagger every other member down so 5-wide bubbles don't collide.
        paddingTop: staggered ? 22 : 0,
      }}
    >
      <CompanionSpeechBubble text={preview} mood={mood} visible={visible} />
      <AnimatedPixelPet sprite={PET_REGISTRY[kind]} mood={mood} size={MEMBER_SIZE} />
    </div>
  );
}

/**
 * Fleet renderer: the selected crew's five pets in a row, each mirroring one
 * running agent's status (member `i` ← the `i`-th agent, sorted by name). Each
 * active member floats a speech bubble with its agent's current activity;
 * spares render idle and silent. The `done` bubble lingers then fades (see
 * {@link useBubbleVisible}).
 */
export function CompanionCrew({
  crew,
  statuses,
}: {
  crew: CrewKind;
  statuses: CompanionAgentStatus[];
}): JSX.Element {
  const roster = CREWS[crew].members;
  const members = crewMembers(statuses, CREW_SIZE);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 4,
        width: '100%',
        height: '100%',
      }}
    >
      {roster.map((kind, i) => (
        <CrewMemberPet
          key={kind}
          kind={kind}
          mood={members[i].mood}
          preview={members[i].preview}
          staggered={i % 2 === 1}
        />
      ))}
    </div>
  );
}
