import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { CompanionAgentStatus } from '../../../../shared/ipc.js';
import { CompanionSquad } from './CompanionSquad.js';

function s(
  agentId: string,
  agentName: string,
  status: CompanionAgentStatus['status'],
  preview = '',
): CompanionAgentStatus {
  return { agentId, agentName, status, preview };
}

test('no agents -> a single idle member, no bubble', () => {
  render(<CompanionSquad squad="kitchen" statuses={[]} />);
  expect(screen.getAllByRole('img')).toHaveLength(1);
  expect(screen.queryByRole('status')).toBeNull();
});

test('renders one member per running agent', () => {
  render(
    <CompanionSquad
      squad="kitchen"
      statuses={[s('a', 'Alpha', 'working'), s('b', 'Bravo', 'working'), s('c', 'Chi', 'done')]}
    />,
  );
  expect(screen.getAllByRole('img')).toHaveLength(3);
});

test('multiple sessions of the same agent render a single member', () => {
  render(
    <CompanionSquad
      squad="kitchen"
      statuses={[s('a', 'Alpha', 'working', 'one'), s('a', 'Alpha', 'done', 'two')]}
    />,
  );
  expect(screen.getAllByRole('img')).toHaveLength(1);
});

test('caps at five members even with more running agents', () => {
  const statuses = ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => s(n.toLowerCase(), n, 'working'));
  render(<CompanionSquad squad="kitchen" statuses={statuses} />);
  expect(screen.getAllByRole('img')).toHaveLength(5);
});

test('every visible member of a busy squad shows its agent’s bubble', () => {
  render(
    <CompanionSquad
      squad="kitchen"
      statuses={[s('z', 'Zephyr', 'working', 'Edit: auth.ts'), s('a', 'Apex', 'error', 'boom')]}
    />,
  );
  // Two members, two visible bubbles: Apex (member 0) and Zephyr (member 1).
  expect(screen.getAllByRole('img')).toHaveLength(2);
  const bubbles = screen.getAllByRole('status');
  expect(bubbles).toHaveLength(2);
  const texts = bubbles.map((b) => b.textContent);
  expect(texts).toContain('boom');
  expect(texts).toContain('Edit: auth.ts');
});

test('uses the squad roster sprites in order', () => {
  render(
    <CompanionSquad
      squad="office"
      statuses={[s('a', 'Alpha', 'working', 'busy'), s('b', 'Bravo', 'working', 'also busy')]}
    />,
  );
  const labels = screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'));
  // Office roster order: boss first, then accountant.
  expect(labels).toEqual(['Boss', 'Accountant']);
});
