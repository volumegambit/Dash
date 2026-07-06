import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { CompanionAgentStatus } from '../../../../shared/ipc.js';
import { CompanionCrew } from './CompanionCrew.js';

function s(
  agentId: string,
  agentName: string,
  status: CompanionAgentStatus['status'],
  preview = '',
): CompanionAgentStatus {
  return { agentId, agentName, status, preview };
}

test('renders exactly five crew members', () => {
  render(<CompanionCrew crew="kitchen" statuses={[]} />);
  // Five sprites, one per member (idle when no agents).
  expect(screen.getAllByRole('img')).toHaveLength(5);
});

test('maps member moods to agents (sorted by name) and shows their previews', () => {
  render(
    <CompanionCrew
      crew="kitchen"
      statuses={[s('z', 'Zephyr', 'working', 'Edit: auth.ts'), s('a', 'Apex', 'error', 'boom')]}
    />,
  );
  // Two active bubbles: Apex (member 0) and Zephyr (member 1).
  const bubbles = screen.getAllByRole('status');
  expect(bubbles).toHaveLength(2);
  const texts = bubbles.map((b) => b.textContent);
  expect(texts).toContain('boom');
  expect(texts).toContain('Edit: auth.ts');
});

test('idle members show no bubble', () => {
  render(<CompanionCrew crew="office" statuses={[s('a', 'Alpha', 'working', 'busy')]} />);
  // Only the single active agent has a bubble; the four spares are silent.
  expect(screen.getAllByRole('status')).toHaveLength(1);
});

test('uses the crew roster sprites in order', () => {
  render(<CompanionCrew crew="office" statuses={[]} />);
  const labels = screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'));
  // Office roster: boss, accountant, intern, it-support, receptionist.
  expect(labels).toEqual(['Boss', 'Accountant', 'Intern', 'IT Support', 'Receptionist']);
});
