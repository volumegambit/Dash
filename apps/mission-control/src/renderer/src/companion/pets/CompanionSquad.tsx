import type { JSX } from 'react';
import type { CompanionAgentStatus, SquadKind } from '../../../../shared/ipc.js';
import { visibleMemberCount } from '../../../../shared/squad.js';
import { AnimatedPixelPet } from './AnimatedPixelPet.js';
import { CompanionSpeechBubble } from './CompanionSpeechBubble.js';
import { PET_REGISTRY } from './index.js';
import { squadMembers } from './squadMembers.js';
import { SQUADS } from './squads.js';
import type { Mood, PetKind } from './types.js';
import { useBubbleVisible } from './useBubbleVisible.js';

/** Per-member sprite size in the squad row. */
const MEMBER_SIZE = 88;

/**
 * Horizontal breathing room on each side of the row. Must be at least half the
 * bubble overhang beyond a member slot ((132 - 88) / 2 = 22) so an edge
 * member's speech bubble is never clipped by the window; the main process
 * bakes the same value into the window width (see companion-window-clamp).
 */
const SIDE_PADDING = 24;

/** One squad slot: the pet plus its (optional) activity bubble. */
function SquadMemberPet({
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
        // Raise every other member's bubble so adjacent bubbles don't collide.
        paddingTop: staggered ? 22 : 0,
      }}
    >
      <CompanionSpeechBubble text={preview} mood={mood} visible={visible} />
      <AnimatedPixelPet sprite={PET_REGISTRY[kind]} mood={mood} size={MEMBER_SIZE} />
    </div>
  );
}

/**
 * Squad renderer: one member per running agent, member `i` mirroring the
 * `i`-th agent (sorted by name) and floating a speech bubble with that agent's
 * current activity. Members are drawn from the squad roster in display order;
 * with no agents running a single idle member remains. The `done` bubble
 * lingers then fades (see {@link useBubbleVisible}).
 */
export function CompanionSquad({
  squad,
  statuses,
}: {
  squad: SquadKind;
  statuses: CompanionAgentStatus[];
}): JSX.Element {
  const roster = SQUADS[squad].members;
  const count = visibleMemberCount(statuses);
  const members = squadMembers(statuses, count);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 4,
        padding: `0 ${SIDE_PADDING}px`,
        boxSizing: 'border-box',
        width: '100%',
        height: '100%',
      }}
    >
      {roster.slice(0, count).map((kind, i) => (
        <SquadMemberPet
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
