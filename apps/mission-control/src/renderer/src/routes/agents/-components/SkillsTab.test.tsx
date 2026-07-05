import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { SkillsConfigStrip } from './SkillsTab.js';

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
