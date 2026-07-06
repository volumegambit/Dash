import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { CompanionAgentStatus } from '../../../../shared/ipc.js';
import { AnimatedPixelPet } from './AnimatedPixelPet.js';
import { CompanionSpeechBubble } from './CompanionSpeechBubble.js';
import { bubbleVisibility } from './bubbleVisibility.js';
import { crewMembers } from './crewMoods.js';
import { CREWS, CREW_SIZE, type CrewKind } from './crews.js';
import { PET_REGISTRY } from './index.js';
import type { Mood } from './types.js';

/** Per-member sprite size in the fleet row. */
const MEMBER_SIZE = 88;

/**
 * Fleet renderer: the selected crew's five pets in a row, each mirroring one
 * running agent's status (member `i` ← the `i`-th agent, sorted by name). Each
 * active member floats a speech bubble with its agent's current activity;
 * spares render idle and silent.
 *
 * The `done` bubble fades a few seconds after finishing: we stamp when each
 * member's mood last changed and tick a clock while any bubble is on a timer,
 * delegating the actual decision to the pure {@link bubbleVisibility}.
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

  // Stamp when each member's mood last changed, so `done` can linger then fade.
  const sinceRef = useRef<{ mood: Mood; since: number }[]>([]);
  const now = Date.now();
  const sinceList = members.map((m, i) => {
    const prev = sinceRef.current[i];
    if (!prev || prev.mood !== m.mood) return { mood: m.mood, since: now };
    return prev;
  });
  sinceRef.current = sinceList;

  // Tick a clock while any member is `done`, so its bubble fades on schedule.
  const [, setTick] = useState(0);
  const hasDone = members.some((m) => m.mood === 'done');
  useEffect(() => {
    if (!hasDone) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasDone]);

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
      {roster.map((kind, i) => {
        const member = members[i];
        const since = sinceList[i].since;
        const visible = bubbleVisibility(member.mood, since, Date.now());
        return (
          <div
            key={kind}
            style={{
              position: 'relative',
              display: 'flex',
              justifyContent: 'center',
              // Stagger every other member down so 5-wide bubbles don't collide.
              paddingTop: i % 2 === 0 ? 0 : 22,
            }}
          >
            <CompanionSpeechBubble text={member.preview} mood={member.mood} visible={visible} />
            <AnimatedPixelPet sprite={PET_REGISTRY[kind]} mood={member.mood} size={MEMBER_SIZE} />
          </div>
        );
      })}
    </div>
  );
}
