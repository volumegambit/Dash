import '@testing-library/jest-dom/vitest';
import type { PluginRecord } from '@dash/management';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../../../../../../vitest.setup.js';
import { AgentConfigTab } from './AgentConfigTab.js';

function pluginRecord(name: string, patch: Partial<PluginRecord> = {}): PluginRecord {
  return {
    name,
    status: 'loaded',
    enabled: true,
    trusted: true,
    activated: [],
    noop: [],
    ...patch,
  };
}

const baseConfig = {
  model: 'claude-sonnet-4-6',
  systemPrompt: '',
  tools: [],
};

describe('AgentConfigTab plugins card', () => {
  beforeEach(() => {
    mockApi.plugins.list.mockReset();
    mockApi.mcpListConnectors.mockReset();
    mockApi.mcpListConnectors.mockResolvedValue([]);
    mockApi.modelsList.mockResolvedValue({
      models: [{ value: 'claude-sonnet-4-6', label: 'Sonnet', provider: 'anthropic' }],
      source: 'live',
      errors: {},
      fetchedAt: '2026-04-13T00:00:00Z',
      supportedModelsReviewedAt: '2026-04-13',
    });
  });

  it('lists pool plugins as assignable when the plugins card is opened', async () => {
    const user = userEvent.setup();
    mockApi.plugins.list.mockResolvedValue([
      pluginRecord('alpha', { displayName: 'Alpha Plugin' }),
      pluginRecord('beta'),
    ]);
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab agentId="agent-1" agentConfig={baseConfig} updateConfig={updateConfig} />,
    );

    await user.click(screen.getByRole('button', { name: /plugins/i }));

    // The assignable option list should show both plugins (by displayName/name).
    expect(await screen.findByRole('option', { name: /Alpha Plugin/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /beta/i })).toBeInTheDocument();
  });

  it('assigns a plugin → updateConfig called with the selected name', async () => {
    const user = userEvent.setup();
    mockApi.plugins.list.mockResolvedValue([
      pluginRecord('alpha', { displayName: 'Alpha Plugin' }),
      pluginRecord('beta'),
    ]);
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab agentId="agent-1" agentConfig={baseConfig} updateConfig={updateConfig} />,
    );

    await user.click(screen.getByRole('button', { name: /plugins/i }));
    await screen.findByRole('option', { name: /Alpha Plugin/i });

    await user.selectOptions(screen.getByRole('combobox'), 'alpha');

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith('agent-1', { plugins: ['alpha'] }),
    );
  });

  it('unassigning the last plugin saves plugins: null (clear → all)', async () => {
    const user = userEvent.setup();
    mockApi.plugins.list.mockResolvedValue([
      pluginRecord('alpha', { displayName: 'Alpha Plugin' }),
    ]);
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab
        agentId="agent-1"
        agentConfig={{ ...baseConfig, plugins: ['alpha'] }}
        updateConfig={updateConfig}
      />,
    );

    await user.click(screen.getByRole('button', { name: /plugins/i }));

    // The assigned chip carries a remove button.
    const remove = await screen.findByRole('button', { name: /remove alpha/i });
    await user.click(remove);

    // Clearing must send `null`, NOT `undefined`. `undefined` is dropped by
    // JSON.stringify over the wire so the gateway merges nothing and the
    // selection sticks; `null` survives and the gateway treats it as
    // "clear to all". After clearing, the "All plugins" display returns.
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('agent-1', { plugins: null }));
    expect(
      await screen.findByText(/all plugins \(default\)\. this agent sees every loaded plugin/i),
    ).toBeInTheDocument();
  });

  it('does not offer disabled/error plugins as assignable options', async () => {
    const user = userEvent.setup();
    mockApi.plugins.list.mockResolvedValue([
      pluginRecord('alpha', { displayName: 'Alpha Plugin' }),
      pluginRecord('broken', { displayName: 'Broken Plugin', status: 'disabled' }),
      pluginRecord('crashed', { displayName: 'Crashed Plugin', status: 'error' }),
    ]);
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab agentId="agent-1" agentConfig={baseConfig} updateConfig={updateConfig} />,
    );

    await user.click(screen.getByRole('button', { name: /plugins/i }));

    // Only the loaded plugin is assignable; disabled/error plugins contribute
    // nothing to routing, so they must not appear in the picker.
    expect(await screen.findByRole('option', { name: /Alpha Plugin/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Broken Plugin/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Crashed Plugin/i })).not.toBeInTheDocument();
  });

  it('keeps an already-assigned plugin visible+removable even if it is not loaded', async () => {
    const user = userEvent.setup();
    // 'alpha' is assigned to the agent but is currently in error state. The
    // user must still be able to SEE and REMOVE it (so they can recover from a
    // plugin that errored after being scoped in).
    mockApi.plugins.list.mockResolvedValue([
      pluginRecord('alpha', { displayName: 'Alpha Plugin', status: 'error' }),
      pluginRecord('beta', { displayName: 'Beta Plugin' }),
    ]);
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab
        agentId="agent-1"
        agentConfig={{ ...baseConfig, plugins: ['alpha'] }}
        updateConfig={updateConfig}
      />,
    );

    await user.click(screen.getByRole('button', { name: /plugins/i }));

    // The assigned (errored) plugin chip + its remove button are present.
    expect(await screen.findByRole('button', { name: /remove alpha/i })).toBeInTheDocument();
    // It is NOT re-offered in the assignable picker (already assigned).
    expect(screen.queryByRole('option', { name: /Alpha Plugin/i })).not.toBeInTheDocument();
    // The loaded, unassigned 'beta' is still assignable.
    expect(screen.getByRole('option', { name: /Beta Plugin/i })).toBeInTheDocument();
  });

  it('shows the "All plugins" indicator for a legacy agent (plugins undefined)', async () => {
    const user = userEvent.setup();
    mockApi.plugins.list.mockResolvedValue([pluginRecord('alpha')]);
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab agentId="agent-1" agentConfig={baseConfig} updateConfig={updateConfig} />,
    );

    // Collapsed summary reflects the default-all state.
    expect(screen.getByText(/all plugins/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /plugins/i }));

    // Display mode shows the "All plugins" indicator (with the explanatory
    // copy), not an empty list. The assigned-chip remove buttons must be absent.
    expect(
      await screen.findByText(/all plugins \(default\)\. this agent sees every loaded plugin/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });
});
