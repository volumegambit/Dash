import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { mockApi } from '../../../../../../vitest.setup.js';
import { SkillsConfigStrip, SkillsTab } from './SkillsTab.js';

describe('SkillsConfigStrip', () => {
  it('renders no bundled-library checkbox', () => {
    render(<SkillsConfigStrip config={{}} onSave={vi.fn()} />);
    expect(screen.queryByText('Include bundled skill library')).not.toBeInTheDocument();
  });

  it('renders the extra skill directories textarea', () => {
    render(<SkillsConfigStrip config={{}} onSave={vi.fn()} />);
    expect(screen.getByText('Extra skill directories (one per line)')).toBeInTheDocument();
  });
});

describe('SkillsTab lessons', () => {
  const learned = {
    name: 'write-files',
    description: 'Use when writing files',
    location: '/skills/write-files/SKILL.md',
    content: '- Use printf, not echo.',
    editable: true,
    source: 'agent' as const,
  };

  const book = {
    version: 1 as const,
    skill: 'write-files',
    description: 'Use when writing files',
    augments: [],
    bullets: [
      {
        id: 'aaa111',
        text: 'Use printf, not echo.',
        helpful: 3,
        harmful: 1,
        createdAt: '2026-09-06',
        lastTouchedAt: '2026-09-06',
      },
    ],
    retired: [],
  };

  it('shows a learned skill’s lessons with their counters', async () => {
    mockApi.skillsList.mockResolvedValue([learned]);
    mockApi.skillsGetConfig.mockResolvedValue({});
    mockApi.skillsLessons.mockResolvedValue(book);

    render(<SkillsTab agentId="a1" />);
    await userEvent.click(await screen.findByText('write-files'));

    const lessons = await screen.findByTestId('skill-lessons');
    expect(lessons.textContent).toContain('Use printf, not echo.');
    // The counters are the second judge; showing them is what makes
    // self-retirement legible rather than mysterious.
    expect(lessons.textContent).toContain('3↑');
    expect(lessons.textContent).toContain('1↓');
  });

  it('retires a lesson and re-renders from the returned book', async () => {
    mockApi.skillsList.mockResolvedValue([learned]);
    mockApi.skillsGetConfig.mockResolvedValue({});
    mockApi.skillsLessons.mockResolvedValue(book);
    mockApi.skillsRetireLesson.mockResolvedValue({ ...book, bullets: [], retired: book.bullets });

    render(<SkillsTab agentId="a1" />);
    await userEvent.click(await screen.findByText('write-files'));
    await userEvent.click(await screen.findByTitle('Retire this lesson'));

    expect(mockApi.skillsRetireLesson).toHaveBeenCalledWith('a1', 'write-files', 'aaa111');
    await waitFor(() => expect(screen.queryByTestId('skill-lessons')).toBeNull());
  });

  it('falls back to the raw body for a skill that is not a lesson book', async () => {
    mockApi.skillsList.mockResolvedValue([{ ...learned, source: 'managed' as const }]);
    mockApi.skillsGetConfig.mockResolvedValue({});
    mockApi.skillsLessons.mockResolvedValue(null);

    render(<SkillsTab agentId="a1" />);
    await userEvent.click(await screen.findByText('write-files'));

    expect(screen.queryByTestId('skill-lessons')).toBeNull();
    expect(await screen.findByText('- Use printf, not echo.')).toBeTruthy();
    // Not an agent-created skill, so no lesson lookup should even be attempted.
    expect(mockApi.skillsLessons).not.toHaveBeenCalled();
  });
});
