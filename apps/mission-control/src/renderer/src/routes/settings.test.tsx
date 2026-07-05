import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsLayout } from './settings.js';

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  Outlet: () => <div data-testid="outlet" />,
}));

describe('Settings layout', () => {
  it('renders the General, Agent Defaults, and Devices tabs', () => {
    render(<SettingsLayout />);
    expect(screen.getByRole('link', { name: 'General' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Agent Defaults' })).toHaveAttribute(
      'href',
      '/settings/agent-defaults',
    );
    expect(screen.getByRole('link', { name: 'Devices' })).toHaveAttribute(
      'href',
      '/settings/devices',
    );
  });

  it('renders the active tab content in an outlet under the page header', () => {
    render(<SettingsLayout />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });
});
