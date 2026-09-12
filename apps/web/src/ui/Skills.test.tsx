import type { MobileAgent, MobileSkill } from '@dash/mobile-contract';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Skills } from './Skills.js';

afterEach(cleanup);

const AGENT = { id: 'a1', name: 'Chief of Staff' } as MobileAgent;

const LEARNED: MobileSkill = {
  name: 'write-files',
  description: 'Use when writing files in this project',
  source: 'agent',
  content: '- Always use printf instead of echo.',
};

const BUILTIN: MobileSkill = {
  name: 'deep-research',
  description: 'Use for multi-source research',
  source: 'plugin',
};

function client(skills: MobileSkill[], agents: MobileAgent[] = [AGENT]) {
  return {
    listAgents: vi.fn(async () => agents),
    listAgentSkills: vi.fn(async () => skills),
  };
}

describe('Skills', () => {
  it('lists an agent’s skills with their provenance', async () => {
    render(<Skills client={client([LEARNED, BUILTIN])} />);

    expect(await screen.findByText('write-files')).toBeTruthy();
    expect(screen.getByText('deep-research')).toBeTruthy();
    // A skill the agent taught itself is called out as such.
    expect(screen.getByText('Learned')).toBeTruthy();
    expect(screen.getByText('Built-in')).toBeTruthy();
  });

  it('reveals the lessons behind a learned skill on demand', async () => {
    render(<Skills client={client([LEARNED])} />);

    const header = await screen.findByRole('button', { name: /write-files/ });
    expect(screen.queryByText(/Always use printf/)).toBeNull();

    await userEvent.click(header);

    expect(screen.getByText(/Always use printf/)).toBeTruthy();
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('says so plainly when an agent has learned nothing yet', async () => {
    render(<Skills client={client([])} />);
    expect(await screen.findByText(/no skills yet/i)).toBeTruthy();
  });

  it('surfaces a load failure instead of rendering an empty list', async () => {
    const failing = {
      listAgents: vi.fn(async () => [AGENT]),
      listAgentSkills: vi.fn(async () => {
        throw new Error('gateway unreachable');
      }),
    };

    render(<Skills client={failing} />);

    expect(await screen.findByText('gateway unreachable')).toBeTruthy();
  });

  it('offers an agent picker only when there is more than one agent', async () => {
    const { unmount } = render(<Skills client={client([LEARNED])} />);
    await screen.findByText('write-files');
    expect(screen.queryByLabelText('Agent')).toBeNull();
    unmount();

    render(
      <Skills
        client={client([LEARNED], [AGENT, { id: 'a2', name: 'Researcher' } as MobileAgent])}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Agent')).toBeTruthy());
  });
});
