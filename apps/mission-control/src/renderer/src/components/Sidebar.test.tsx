import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useUIStore } from '../stores/ui.js';
import { Sidebar } from './Sidebar.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    onClick,
    title,
  }: {
    to: string;
    children: ReactNode;
    onClick?: () => void;
    title?: string;
  }) => (
    <a href={to} onClick={onClick} title={title}>
      {children}
    </a>
  ),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarCollapsed: false });
  });

  it('renders the primary nav items and a Settings entry', () => {
    render(<Sidebar />);
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('does not render config destinations at top level (they live under Settings)', () => {
    render(<Sidebar />);
    for (const label of [
      'AI Providers',
      'Connectors (MCP)',
      'Plugins',
      'Messaging Apps',
      'Pair Device',
      'Web Search',
    ]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('does not render retired nav items', () => {
    render(<Sidebar />);
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Deploy')).not.toBeInTheDocument();
    expect(screen.queryByText('Secrets')).not.toBeInTheDocument();
  });

  it('renders no section header over the primary items', () => {
    render(<Sidebar />);
    expect(screen.queryByText('CORE')).not.toBeInTheDocument();
    expect(screen.queryByText('MANAGE')).not.toBeInTheDocument();
    expect(screen.queryByText('PLAN')).not.toBeInTheDocument();
    expect(screen.queryByText('CONFIGURE')).not.toBeInTheDocument();
  });

  it('renders a Feedback button', () => {
    render(<Sidebar />);
    expect(screen.getByText('Feedback')).toBeInTheDocument();
  });

  it('is expanded by default', () => {
    useUIStore.setState(useUIStore.getInitialState());
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('renders collapse toggle buttons at top and bottom', () => {
    render(<Sidebar />);
    expect(screen.getAllByRole('button', { name: /collapse sidebar/i })).toHaveLength(2);
  });

  it('hides nav labels when collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.queryByText('Chat')).not.toBeInTheDocument();
    expect(screen.queryByText('Agents')).not.toBeInTheDocument();
  });

  it('hides the Mission Control wordmark when collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.queryByText('Mission Control')).not.toBeInTheDocument();
  });

  it('hides the DEVELOPER section header when collapsed', () => {
    // import.meta.env.DEV is true under vitest, so the DEVELOPER section renders
    expect(screen.queryByText('DEVELOPER')).not.toBeInTheDocument();
    useUIStore.setState({ sidebarCollapsed: false });
    render(<Sidebar />);
    expect(screen.getByText('DEVELOPER')).toBeInTheDocument();
    act(() => {
      useUIStore.setState({ sidebarCollapsed: true });
    });
    expect(screen.queryByText('DEVELOPER')).not.toBeInTheDocument();
  });

  it('shows expand buttons when collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.getAllByRole('button', { name: /expand sidebar/i })).toHaveLength(2);
  });

  it('clicking the top collapse toggle collapses the sidebar', () => {
    render(<Sidebar />);
    act(() => {
      fireEvent.click(screen.getAllByRole('button', { name: /collapse sidebar/i })[0]);
    });
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
  });

  it('clicking the bottom expand toggle expands the sidebar', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    act(() => {
      fireEvent.click(screen.getAllByRole('button', { name: /expand sidebar/i })[1]);
    });
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('clicking a nav icon while collapsed expands the sidebar', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    act(() => {
      fireEvent.click(screen.getByTitle('Chat'));
    });
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it('clicking a nav item while expanded keeps the sidebar expanded', () => {
    render(<Sidebar />);
    act(() => {
      fireEvent.click(screen.getByText('Chat'));
    });
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });
});
