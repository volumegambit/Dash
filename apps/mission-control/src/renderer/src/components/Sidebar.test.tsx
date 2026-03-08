import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

describe('Sidebar', () => {
  it('renders all expected nav items', () => {
    render(<Sidebar />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Secrets')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('does not render a Deploy nav item', () => {
    render(<Sidebar />);
    expect(screen.queryByText('Deploy')).not.toBeInTheDocument();
  });
});
