import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar.js';
import { useUIStore } from '../stores/ui.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

describe('Sidebar', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarCollapsed: false });
  });

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

  it('renders a collapse toggle button', () => {
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeInTheDocument();
  });

  it('hides nav labels when collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Agents')).not.toBeInTheDocument();
  });

  it('hides the Mission Control wordmark when collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.queryByText('Mission Control')).not.toBeInTheDocument();
  });

  it('hides section headers when collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.queryByText('CORE')).not.toBeInTheDocument();
    expect(screen.queryByText('MANAGE')).not.toBeInTheDocument();
    expect(screen.queryByText('CONFIGURE')).not.toBeInTheDocument();
  });

  it('shows expand button when collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
  });

  it('clicking collapse toggle collapses the sidebar', () => {
    render(<Sidebar />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    });
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it('clicking expand toggle expands the sidebar', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /expand sidebar/i }));
    });
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });
});
