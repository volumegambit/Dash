import { expect, test } from 'vitest';
import type { CompanionAgentStatus } from '../../../../shared/ipc.js';
import { visibleMemberCount } from '../../../../shared/squad.js';
import { squadMembers } from './squadMembers.js';

function s(
  agentId: string,
  agentName: string,
  status: CompanionAgentStatus['status'],
  preview = '',
): CompanionAgentStatus {
  return { agentId, agentName, status, preview };
}

function moods(entries: CompanionAgentStatus[]): string[] {
  return squadMembers(entries, visibleMemberCount(entries)).map((m) => m.mood);
}

test('no agents -> a single idle member', () => {
  expect(visibleMemberCount([])).toBe(1);
  expect(moods([])).toEqual(['idle']);
});

test('one member per running agent, no idle spares', () => {
  const entries = [s('a', 'Alpha', 'working'), s('b', 'Bravo', 'error')];
  expect(visibleMemberCount(entries)).toBe(2);
  expect(moods(entries)).toEqual(['working', 'error']);
});

test('multiple sessions of one agent count as one member', () => {
  const entries = [s('a', 'Alpha', 'working'), s('a', 'Alpha', 'done')];
  expect(visibleMemberCount(entries)).toBe(1);
});

test('member count caps at the roster size of five', () => {
  const entries = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => s(n.toLowerCase(), n, 'working'));
  expect(visibleMemberCount(entries)).toBe(5);
});

test('agents are sorted by name (tiebreak id) for stable member assignment', () => {
  // Apex sorts before Zephyr, so member 0 gets Apex's error.
  expect(moods([s('z1', 'Zephyr', 'working'), s('a1', 'Apex', 'error')])).toEqual([
    'error',
    'working',
  ]);
});

test('name ties break on agentId', () => {
  // Same name; 'a' < 'b' so member 0 is agent a (error).
  expect(moods([s('b', 'Same', 'working'), s('a', 'Same', 'error')])).toEqual(['error', 'working']);
});

test('more agents than members keeps the first five by name', () => {
  const entries = [
    s('1', 'Echo', 'working'),
    s('2', 'Alpha', 'error'),
    s('3', 'Delta', 'needs'),
    s('4', 'Charlie', 'done'),
    s('5', 'Bravo', 'working'),
    s('6', 'Foxtrot', 'error'),
  ];
  // Sorted: Alpha(error), Bravo(working), Charlie(done), Delta(needs), Echo(working) — Foxtrot dropped.
  expect(moods(entries)).toEqual(['error', 'working', 'done', 'needs', 'working']);
});

test('per-agent mood aggregates that agent’s sessions by precedence', () => {
  // One agent, two sessions: working + error -> error wins for that agent.
  expect(moods([s('a', 'Alpha', 'working'), s('a', 'Alpha', 'error')])).toEqual(['error']);
});

test('squadMembers returns the sorted per-agent identity + preview, padding to memberCount', () => {
  const members = squadMembers(
    [
      s('z', 'Zephyr', 'working', 'reading z'),
      s('a', 'Apex', 'error', 'boom'),
      s('a', 'Apex', 'working', 'still going'),
    ],
    3,
  );
  expect(members).toHaveLength(3);
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
  // Slots beyond the agent count carry no agent and no preview.
  expect(members[2]).toEqual({ agentId: null, agentName: null, mood: 'idle', preview: '' });
});

test('squadMembers preview follows the agent’s dominant status', () => {
  // Agent with a working session and a done session: working outranks done, so
  // the preview comes from the working session.
  const members = squadMembers(
    [s('a', 'Alpha', 'done', 'finished earlier'), s('a', 'Alpha', 'working', 'Edit: auth.ts')],
    1,
  );
  expect(members[0]).toEqual({
    agentId: 'a',
    agentName: 'Alpha',
    mood: 'working',
    preview: 'Edit: auth.ts',
  });
});
