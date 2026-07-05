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

  it('renders all expected nav items', () => {
    render(<Sidebar />);
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.queryByText('Secrets')).not.toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Messaging Apps')).toBeInTheDocument();
    expect(screen.getByText('Plugins')).toBeInTheDocument();
  });

  it('does not render a Dashboard nav item', () => {
    render(<Sidebar />);
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('does not render a Deploy nav item', () => {
    render(<Sidebar />);
    expect(screen.queryByText('Deploy')).not.toBeInTheDocument();
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

  it('hides section headers when collapsed', () => {
    useUIStore.setState({ sidebarCollapsed: true });
    render(<Sidebar />);
    expect(screen.queryByText('CORE')).not.toBeInTheDocument();
    expect(screen.queryByText('MANAGE')).not.toBeInTheDocument();
    expect(screen.queryByText('CONFIGURE')).not.toBeInTheDocument();
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
