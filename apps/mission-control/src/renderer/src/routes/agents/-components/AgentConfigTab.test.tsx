import '@testing-library/jest-dom/vitest';
import type { PluginRecord, RuntimePluginProvider } from '@dash/management';
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
    builtin: false,
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

function runtimeProvider(
  id: string,
  patch: Partial<RuntimePluginProvider> = {},
): RuntimePluginProvider {
  return {
    id,
    label: id,
    credentialPrefix: `${id}-api-key`,
    pluginName: 'dash-core-providers',
    ...patch,
  };
}

describe('AgentConfigTab providers card', () => {
  beforeEach(() => {
    mockApi.plugins.list.mockReset();
    mockApi.plugins.list.mockResolvedValue([]);
    mockApi.plugins.runtime.mockReset();
    mockApi.plugins.runtime.mockResolvedValue({ providers: [], plugins: [] });
    mockApi.mcpListConnectors.mockReset();
    mockApi.mcpListConnectors.mockResolvedValue([]);
  });

  it('shows the "All providers" indicator when providers is unset', async () => {
    const user = userEvent.setup();
    mockApi.plugins.runtime.mockResolvedValue({
      providers: [
        runtimeProvider('anthropic', { label: 'Anthropic', ui: { sortOrder: 0 } }),
        runtimeProvider('openai', { label: 'OpenAI', ui: { sortOrder: 1 } }),
      ],
      plugins: [],
    });
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab agentId="agent-1" agentConfig={baseConfig} updateConfig={updateConfig} />,
    );

    // Collapsed summary reflects the default-all state.
    expect(screen.getByText(/all providers \(default\)/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /providers/i }));

    // Expanded shows the explanatory copy, not an empty list.
    expect(
      await screen.findByText(/all providers \(default\)\. this agent can use every provider/i),
    ).toBeInTheDocument();
  });

  it('lists runtime providers as assignable, sorted and labeled', async () => {
    const user = userEvent.setup();
    // Deliberately reverse gateway order so passing proves the card SORTS by
    // ui.sortOrder (anthropic 0 before openai 1) rather than arrival order.
    mockApi.plugins.runtime.mockResolvedValue({
      providers: [
        runtimeProvider('openai', { label: 'OpenAI', ui: { sortOrder: 1 } }),
        runtimeProvider('anthropic', { label: 'Anthropic', ui: { sortOrder: 0 } }),
      ],
      plugins: [],
    });
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab agentId="agent-1" agentConfig={baseConfig} updateConfig={updateConfig} />,
    );

    await user.click(screen.getByRole('button', { name: /providers/i }));

    // Options carry catalog labels, and appear in sorted order.
    const anthropicOpt = await screen.findByRole('option', { name: /Anthropic/i });
    const openaiOpt = screen.getByRole('option', { name: /OpenAI/i });
    expect(anthropicOpt).toBeInTheDocument();
    expect(openaiOpt).toBeInTheDocument();
    expect(anthropicOpt.compareDocumentPosition(openaiOpt)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('assigns a provider → updateConfig called with the selected id', async () => {
    const user = userEvent.setup();
    mockApi.plugins.runtime.mockResolvedValue({
      providers: [
        runtimeProvider('anthropic', { label: 'Anthropic', ui: { sortOrder: 0 } }),
        runtimeProvider('openai', { label: 'OpenAI', ui: { sortOrder: 1 } }),
      ],
      plugins: [],
    });
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab agentId="agent-1" agentConfig={baseConfig} updateConfig={updateConfig} />,
    );

    await user.click(screen.getByRole('button', { name: /providers/i }));
    await screen.findByRole('option', { name: /Anthropic/i });

    await user.selectOptions(screen.getByRole('combobox'), 'anthropic');

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith('agent-1', { providers: ['anthropic'] }),
    );
  });

  it('unassigning the last provider saves providers: null (clear → all)', async () => {
    const user = userEvent.setup();
    mockApi.plugins.runtime.mockResolvedValue({
      providers: [runtimeProvider('anthropic', { label: 'Anthropic', ui: { sortOrder: 0 } })],
      plugins: [],
    });
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab
        agentId="agent-1"
        agentConfig={{ ...baseConfig, providers: ['anthropic'] }}
        updateConfig={updateConfig}
      />,
    );

    await user.click(screen.getByRole('button', { name: /providers/i }));

    const remove = await screen.findByRole('button', { name: /remove anthropic/i });
    await user.click(remove);

    // Clearing must send `null`, NOT `undefined`. `undefined` is dropped by
    // JSON.stringify over the wire so the gateway merges nothing; `null`
    // survives and the gateway treats it as "clear to all".
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('agent-1', { providers: null }));
    expect(
      await screen.findByText(/all providers \(default\)\. this agent can use every provider/i),
    ).toBeInTheDocument();
  });

  it('shows assigned provider chips with catalog labels', async () => {
    const user = userEvent.setup();
    mockApi.plugins.runtime.mockResolvedValue({
      providers: [
        runtimeProvider('anthropic', { label: 'Anthropic', ui: { sortOrder: 0 } }),
        runtimeProvider('openai', { label: 'OpenAI', ui: { sortOrder: 1 } }),
      ],
      plugins: [],
    });
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab
        agentId="agent-1"
        agentConfig={{ ...baseConfig, providers: ['anthropic'] }}
        updateConfig={updateConfig}
      />,
    );

    // Collapsed summary reflects the selection count.
    expect(screen.getByText(/1 selected/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /providers/i }));

    // The assigned chip carries the catalog label + a remove button; the
    // unassigned provider is still offered in the picker.
    expect(await screen.findByRole('button', { name: /remove anthropic/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Anthropic/i })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /OpenAI/i })).toBeInTheDocument();
  });

  it('renders an API-set `providers: []` as "No providers (agent blocked)", not "All providers"', async () => {
    // The UI itself can never produce `providers: []` (clearing the last chip
    // writes `null`). An empty array can only arrive via the management API and
    // means the agent is BLOCKED from every provider — the collapsed summary and
    // expanded copy must say so honestly, never "All providers (default)" (which
    // would imply the opposite: unrestricted access).
    const user = userEvent.setup();
    mockApi.plugins.runtime.mockResolvedValue({
      providers: [
        runtimeProvider('anthropic', { label: 'Anthropic', ui: { sortOrder: 0 } }),
        runtimeProvider('openai', { label: 'OpenAI', ui: { sortOrder: 1 } }),
      ],
      plugins: [],
    });
    const updateConfig = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentConfigTab
        agentId="agent-1"
        agentConfig={{ ...baseConfig, providers: [] }}
        updateConfig={updateConfig}
      />,
    );

    // Collapsed summary must NOT read "All providers"; it reads the blocked copy.
    expect(screen.getByText(/no providers \(agent blocked\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/all providers \(default\)/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /providers/i }));

    // Expanded copy explains the block and how to recover; no "all providers" lie.
    expect(
      await screen.findByText(/no providers \(agent blocked\)\. this agent's allow-list is empty/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/all providers \(default\)\. this agent can use every provider/i),
    ).not.toBeInTheDocument();
  });
});
