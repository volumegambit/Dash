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
  it('renders every settings section in the sub-nav with its route', () => {
    render(<SettingsLayout />);
    const expected: Array<[string, string]> = [
      ['General', '/settings'],
      ['Agent Defaults', '/settings/agent-defaults'],
      ['AI Providers', '/settings/ai-providers'],
      ['Connectors (MCP)', '/settings/connectors'],
      ['Plugins', '/settings/plugins'],
      ['Messaging Apps', '/settings/messaging-apps'],
      ['Devices', '/settings/devices'],
    ];
    for (const [label, href] of expected) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });

  it('groups provider/tool and access sections under labeled headers', () => {
    render(<SettingsLayout />);
    expect(screen.getByText('PROVIDERS & TOOLS')).toBeInTheDocument();
    expect(screen.getByText('ACCESS')).toBeInTheDocument();
  });

  it('renders the active section in an outlet next to the sub-nav', () => {
    render(<SettingsLayout />);
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
  });
});
