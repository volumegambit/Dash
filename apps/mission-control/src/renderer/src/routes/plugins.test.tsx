import '@testing-library/jest-dom/vitest';
import type { InstalledPlugin, PluginRecord } from '@dash/management';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockApi } from '../../../../vitest.setup.js';
import { usePluginsStore } from '../stores/plugins.js';
import { PluginsScreen } from './plugins.js';

function makeRecord(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    name: 'sample-plugin',
    status: 'loaded',
    enabled: true,
    trusted: false,
    activated: ['skills'],
    noop: ['mcp'],
    version: '1.2.3',
    displayName: 'Sample Plugin',
    ...overrides,
  };
}

function makeInstalled(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    name: 'sample-plugin',
    version: '1.2.3',
    location: '/data/plugins/sample-plugin',
    scanVerdict: 'safe',
    scanReasons: [],
    source: 'git:owner/repo',
    ...overrides,
  };
}

describe('PluginsScreen', () => {
  beforeEach(() => {
    // Reset zustand store between tests so records don't leak across renders.
    usePluginsStore.setState({ records: [], loading: false, error: null });
  });

  it('renders each plugin with name, version, and status badge', async () => {
    mockApi.plugins.list.mockResolvedValue([
      makeRecord(),
      makeRecord({
        name: 'other',
        displayName: 'Other Plugin',
        status: 'disabled',
        enabled: false,
        version: '0.1.0',
      }),
    ]);
    render(<PluginsScreen />);

    expect(await screen.findByText('Sample Plugin')).toBeInTheDocument();
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
    expect(screen.getByText(/Loaded/)).toBeInTheDocument();

    expect(screen.getByText('Other Plugin')).toBeInTheDocument();
    expect(screen.getByText(/Disabled/)).toBeInTheDocument();
  });

  it('shows activated contributions and struck-through noop contributions', async () => {
    mockApi.plugins.list.mockResolvedValue([makeRecord({ activated: ['skills'], noop: ['mcp'] })]);
    render(<PluginsScreen />);

    const activated = await screen.findByText('skills');
    expect(activated).toBeInTheDocument();
    const noop = screen.getByText('mcp');
    expect(noop).toHaveClass('line-through');
  });

  it('surfaces a failure message for an errored plugin', async () => {
    mockApi.plugins.list.mockResolvedValue([
      makeRecord({ status: 'error', failure: 'manifest parse failed' }),
    ]);
    render(<PluginsScreen />);

    expect(await screen.findByText(/Error/)).toBeInTheDocument();
    expect(screen.getByText('manifest parse failed')).toBeInTheDocument();
  });

  it('install form submits with source and optional name', async () => {
    const user = userEvent.setup();
    mockApi.plugins.list.mockResolvedValue([]);
    mockApi.plugins.install.mockResolvedValue(makeInstalled());
    render(<PluginsScreen />);

    await screen.findByText(/No plugins installed/);
    await user.type(screen.getByLabelText('Source'), 'git:owner/repo');
    await user.type(screen.getByLabelText(/Name/), 'my-plugin');
    await user.click(screen.getByRole('button', { name: /^Install$/ }));

    await waitFor(() => {
      expect(mockApi.plugins.install).toHaveBeenCalledWith({
        source: 'git:owner/repo',
        name: 'my-plugin',
      });
    });
  });

  it('surfaces a warning when the install scan verdict is suspicious', async () => {
    const user = userEvent.setup();
    mockApi.plugins.list.mockResolvedValue([]);
    mockApi.plugins.install.mockResolvedValue(
      makeInstalled({ scanVerdict: 'suspicious', scanReasons: ['network access'] }),
    );
    render(<PluginsScreen />);

    await screen.findByText(/No plugins installed/);
    await user.type(screen.getByLabelText('Source'), 'git:owner/repo');
    await user.click(screen.getByRole('button', { name: /^Install$/ }));

    expect(await screen.findByText(/suspicious/)).toBeInTheDocument();
    expect(screen.getByText(/network access/)).toBeInTheDocument();
  });

  it('enable/disable button calls setState with the toggled enabled flag', async () => {
    const user = userEvent.setup();
    const record = makeRecord({ enabled: true });
    mockApi.plugins.list.mockResolvedValue([record]);
    mockApi.plugins.setState.mockResolvedValue({ ...record, enabled: false });
    render(<PluginsScreen />);

    await screen.findByText('Sample Plugin');
    await user.click(screen.getByRole('button', { name: 'Disable' }));

    expect(mockApi.plugins.setState).toHaveBeenCalledWith('sample-plugin', { enabled: false });
  });

  it('Trust button only shows when enabled and opens the trust modal', async () => {
    const user = userEvent.setup();
    mockApi.plugins.list.mockResolvedValue([
      makeRecord({ name: 'a', displayName: 'Disabled One', enabled: false, trusted: false }),
      makeRecord({ name: 'b', displayName: 'Enabled One', enabled: true, trusted: false }),
    ]);
    render(<PluginsScreen />);

    await screen.findByText('Enabled One');
    // Exactly one Trust button — the disabled plugin must not show one.
    const trustButtons = screen.getAllByRole('button', { name: 'Trust' });
    expect(trustButtons).toHaveLength(1);

    await user.click(trustButtons[0]);
    // The modal surfaces the high-contrast "this code runs" warning and a
    // confirm button. Assert on the warning copy (unique) rather than the
    // "Trust Plugin" label, which appears as both the modal title and button.
    expect(await screen.findByText(/This code will run on your machine/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trust Plugin' })).toBeInTheDocument();
  });

  it('confirming the trust modal calls setState with trusted true', async () => {
    const user = userEvent.setup();
    const record = makeRecord({ enabled: true, trusted: false });
    mockApi.plugins.list.mockResolvedValue([record]);
    mockApi.plugins.setState.mockResolvedValue({ ...record, trusted: true });
    render(<PluginsScreen />);

    await screen.findByText('Sample Plugin');
    await user.click(screen.getByRole('button', { name: 'Trust' }));
    await user.click(await screen.findByRole('button', { name: 'Trust Plugin' }));

    expect(mockApi.plugins.setState).toHaveBeenCalledWith('sample-plugin', { trusted: true });
  });

  it('Revoke Trust button calls setState with trusted false', async () => {
    const user = userEvent.setup();
    const record = makeRecord({ enabled: true, trusted: true });
    mockApi.plugins.list.mockResolvedValue([record]);
    mockApi.plugins.setState.mockResolvedValue({ ...record, trusted: false });
    render(<PluginsScreen />);

    await screen.findByText('Sample Plugin');
    await user.click(screen.getByRole('button', { name: 'Revoke Trust' }));

    expect(mockApi.plugins.setState).toHaveBeenCalledWith('sample-plugin', { trusted: false });
  });

  it('remove shows a confirm then calls remove', async () => {
    const user = userEvent.setup();
    mockApi.plugins.list.mockResolvedValue([makeRecord()]);
    mockApi.plugins.remove.mockResolvedValue({ ok: true });
    render(<PluginsScreen />);

    await screen.findByText('Sample Plugin');
    await user.click(screen.getByRole('button', { name: /Remove/ }));

    // Confirm dialog appears
    expect(await screen.findByText('Remove Plugin?')).toBeInTheDocument();
    // Click the confirm action (the destructive Remove inside the dialog)
    const confirmButtons = screen.getAllByRole('button', { name: /^Remove$/ });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    expect(mockApi.plugins.remove).toHaveBeenCalledWith('sample-plugin');
  });

  it('displays the store error state', async () => {
    mockApi.plugins.list.mockRejectedValue(new Error('gateway unreachable'));
    render(<PluginsScreen />);

    expect(await screen.findByText(/gateway unreachable/)).toBeInTheDocument();
  });
});
