import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

describe('Sidebar', () => {
  it('renders all expected nav items', () => {
    render(<Sidebar />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.queryByText('Secrets')).not.toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Messaging Apps')).toBeInTheDocument();
  });

  it('does not render a Deploy nav item', () => {
    render(<Sidebar />);
    expect(screen.queryByText('Deploy')).not.toBeInTheDocument();
  });

  it('renders a Feedback button', () => {
    render(<Sidebar />);
    expect(screen.getByText('Feedback')).toBeInTheDocument();
  });
});
