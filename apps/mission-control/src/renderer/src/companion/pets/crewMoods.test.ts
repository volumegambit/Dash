import { expect, test } from 'vitest';
import type { CompanionAgentStatus } from '../../../../shared/ipc.js';
import { crewMembers, crewMoods } from './crewMoods.js';

function s(
  agentId: string,
  agentName: string,
  status: CompanionAgentStatus['status'],
  preview = '',
): CompanionAgentStatus {
  return { agentId, agentName, status, preview };
}

test('no agents -> all idle', () => {
  expect(crewMoods([], 5)).toEqual(['idle', 'idle', 'idle', 'idle', 'idle']);
});

test('two agents -> two mapped moods then idle padding', () => {
  const moods = crewMoods([s('a', 'Alpha', 'working'), s('b', 'Bravo', 'error')], 5);
  expect(moods).toEqual(['working', 'error', 'idle', 'idle', 'idle']);
});

test('agents are sorted by name (tiebreak id) for stable member assignment', () => {
  const moods = crewMoods([s('z1', 'Zephyr', 'working'), s('a1', 'Apex', 'error')], 5);
  // Apex sorts before Zephyr, so member 0 gets Apex's error.
  expect(moods).toEqual(['error', 'working', 'idle', 'idle', 'idle']);
});

test('name ties break on agentId', () => {
  const moods = crewMoods([s('b', 'Same', 'working'), s('a', 'Same', 'error')], 5);
  // Same name; 'a' < 'b' so member 0 is agent a (error).
  expect(moods).toEqual(['error', 'working', 'idle', 'idle', 'idle']);
});

test('more agents than members keeps the first N by name', () => {
  const moods = crewMoods(
    [
      s('1', 'Echo', 'working'),
      s('2', 'Alpha', 'error'),
      s('3', 'Delta', 'needs'),
      s('4', 'Charlie', 'done'),
      s('5', 'Bravo', 'working'),
      s('6', 'Foxtrot', 'error'),
    ],
    5,
  );
  // Sorted: Alpha(error), Bravo(working), Charlie(done), Delta(needs), Echo(working) — Foxtrot dropped.
  expect(moods).toEqual(['error', 'working', 'done', 'needs', 'working']);
});

test('per-agent mood aggregates that agent’s sessions by precedence', () => {
  // One agent, two sessions: working + error -> error wins for that agent.
  const moods = crewMoods([s('a', 'Alpha', 'working'), s('a', 'Alpha', 'error')], 5);
  expect(moods).toEqual(['error', 'idle', 'idle', 'idle', 'idle']);
});

test('memberCount clamps the output length', () => {
  expect(crewMoods([s('a', 'Alpha', 'working')], 3)).toEqual(['working', 'idle', 'idle']);
});

test('crewMembers returns the sorted per-agent identity + preview for the first N', () => {
  const members = crewMembers(
    [
      s('z', 'Zephyr', 'working', 'reading z'),
      s('a', 'Apex', 'error', 'boom'),
      s('a', 'Apex', 'working', 'still going'),
    ],
    5,
  );
  expect(members).toHaveLength(5);
  // Apex sorts first; its aggregate mood is error and it shows an error preview.
  expect(members[0]).toEqual({
    agentId: 'a',
    agentName: 'Apex',
    mood: 'error',
    preview: 'boom',
  });
  expect(members[1]).toEqual({
    agentId: 'z',
    agentName: 'Zephyr',
    mood: 'working',
    preview: 'reading z',
  });
  // Spare members carry no agent and no preview.
  expect(members[2]).toEqual({ agentId: null, agentName: null, mood: 'idle', preview: '' });
});

test('crewMembers preview follows the agent’s dominant status', () => {
  // Agent with a working session and a done session: working outranks done, so
  // the preview comes from the working session.
  const members = crewMembers(
    [s('a', 'Alpha', 'done', 'finished earlier'), s('a', 'Alpha', 'working', 'Edit: auth.ts')],
    5,
  );
  expect(members[0]).toEqual({
    agentId: 'a',
    agentName: 'Alpha',
    mood: 'working',
    preview: 'Edit: auth.ts',
  });
});
