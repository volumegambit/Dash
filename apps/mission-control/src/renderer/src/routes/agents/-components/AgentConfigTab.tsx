import type { PluginRecord, RuntimePluginProvider } from '@dash/management';
import type { GatewayAgent } from '@dash/mc';
import { ChevronDown, ChevronUp, FolderOpen, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { McpConnectorInfo } from '../../../../../shared/ipc.js';
import { HealthDot } from '../../../components/HealthDot.js';
import { ModelChainEditor } from '../../../components/ModelChainEditor.js';
import { ALL_TOOL_IDS, TOOL_GROUPS } from '../../../components/deploy-options.js';
import { sortProviders } from '../../../components/providers.js';
import { useAvailableModels } from '../../../hooks/useAvailableModels.js';

type AgentConfig = GatewayAgent['config'];

type ConfigPatch = {
  model?: string;
  fallbackModels?: string[];
  tools?: string[];
  systemPrompt?: string;
  workspace?: string;
  mcpServers?: string[];
  // `null` is the clear-to-all sentinel: it survives JSON.stringify (unlike
  // `undefined`, which the wire drops, making the clear a no-op) and the gateway
  // treats it as "delete the key → all loaded plugins". A non-empty array scopes.
  plugins?: string[] | null;
  // Same null-clear sentinel semantics as `plugins`: `null` clears the scope
  // back to "all available providers"; a non-empty array scopes the agent.
  providers?: string[] | null;
};

interface AgentConfigTabProps {
  agentId: string;
  agentConfig: AgentConfig | undefined;
  workspace?: string;
  updateConfig: (id: string, patch: ConfigPatch) => Promise<void>;
}

export function AgentConfigTab({
  agentId,
  agentConfig,
  workspace,
  updateConfig,
}: AgentConfigTabProps): JSX.Element {
  const {
    models: availableModels,
    refreshing: modelsRefreshing,
    refresh: refreshModels,
  } = useAvailableModels();

  // Which card is open (null = all collapsed). Opening goes straight to edit mode.
  const [openCard, setOpenCard] = useState<
    'workspace' | 'models' | 'prompt' | 'tools' | 'connectors' | 'plugins' | 'providers' | null
  >(null);

  // Workspace editing state
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [workspaceSaving, setWorkspaceSaving] = useState(false);

  // Model chain editing state
  const [chainModel, setChainModel] = useState('');
  const [chainFallbacks, setChainFallbacks] = useState<string[]>([]);
  const [chainSaving, setChainSaving] = useState(false);

  // Tools editing state
  const [toolsDraft, setToolsDraft] = useState<string[]>([]);
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsRestartNeeded, setToolsRestartNeeded] = useState(false);

  // System prompt editing state
  const [promptDraft, setPromptDraft] = useState('');
  const [promptSaving, setPromptSaving] = useState(false);

  // Connectors state
  const [assignedConnectors, setAssignedConnectors] = useState<string[]>([]);
  const [poolConnectors, setPoolConnectors] = useState<McpConnectorInfo[]>([]);

  // Plugins state. Per-agent plugin selection is visibility/routing only; trust
  // is gateway-wide. Empty = all (undefined): an empty selection means the agent
  // sees every loaded plugin, matching the gateway's `plugins: undefined`
  // backward-compat behavior — NOT "no plugins".
  const [assignedPlugins, setAssignedPlugins] = useState<string[]>([]);
  const [poolPlugins, setPoolPlugins] = useState<PluginRecord[]>([]);

  // Providers state. Per-agent provider selection is an allow-list over the
  // runtime providers surfaced by the gateway. Empty = all: an empty selection
  // means the agent can use every available provider (matching the gateway's
  // `providers: undefined` backward-compat behavior) — NOT "no providers".
  const [assignedProviders, setAssignedProviders] = useState<string[]>([]);
  const [poolProviders, setPoolProviders] = useState<RuntimePluginProvider[]>([]);

  // Sync connectors when agentConfig changes
  useEffect(() => {
    setAssignedConnectors(agentConfig?.mcpServers ?? []);
    window.api
      .mcpListConnectors()
      .then(setPoolConnectors)
      .catch(() => {});
  }, [agentConfig]);

  const unassignedConnectors = poolConnectors.filter((c) => !assignedConnectors.includes(c.name));

  const handleAssignConnector = useCallback(
    async (name: string) => {
      const next = [...assignedConnectors, name];
      setAssignedConnectors(next);
      await updateConfig(agentId, { mcpServers: next });
    },
    [assignedConnectors, agentId, updateConfig],
  );

  const handleUnassignConnector = useCallback(
    async (name: string) => {
      const next = assignedConnectors.filter((s) => s !== name);
      setAssignedConnectors(next);
      await updateConfig(agentId, { mcpServers: next });
    },
    [assignedConnectors, agentId, updateConfig],
  );

  function connectorHealthStatus(
    status: McpConnectorInfo['status'],
  ): 'connected' | 'connecting' | 'disconnected' {
    if (status === 'connected') return 'connected';
    if (status === 'reconnecting') return 'connecting';
    return 'disconnected';
  }

  // Sync plugins when agentConfig changes
  useEffect(() => {
    setAssignedPlugins(agentConfig?.plugins ?? []);
    window.api.plugins
      .list()
      .then(setPoolPlugins)
      .catch(() => {});
  }, [agentConfig]);

  // Assignable options: only LOADED plugins (a disabled/error plugin
  // contributes nothing to routing). Already-assigned names are excluded from
  // the picker but stay visible as chips below — including ones that aren't
  // loaded — so a user can still SEE and remove a selection for a plugin that
  // errored after being scoped in.
  const unassignedPlugins = poolPlugins.filter(
    (p) => p.status === 'loaded' && !assignedPlugins.includes(p.name),
  );

  const handleAssignPlugin = useCallback(
    async (name: string) => {
      // Empty = all: a non-empty selection scopes the agent to those plugins;
      // clearing back to empty writes `null` (= all). `null` survives the wire;
      // `undefined` would be dropped by JSON.stringify, making the clear a no-op.
      const next = [...assignedPlugins, name];
      setAssignedPlugins(next);
      await updateConfig(agentId, { plugins: next.length > 0 ? next : null });
    },
    [assignedPlugins, agentId, updateConfig],
  );

  const handleUnassignPlugin = useCallback(
    async (name: string) => {
      const next = assignedPlugins.filter((p) => p !== name);
      setAssignedPlugins(next);
      await updateConfig(agentId, { plugins: next.length > 0 ? next : null });
    },
    [assignedPlugins, agentId, updateConfig],
  );

  const pluginLabel = (name: string): string =>
    poolPlugins.find((p) => p.name === name)?.displayName ?? name;

  // Sync providers when agentConfig changes. Pool comes from the gateway's
  // runtime providers (the same source the AI Providers page uses), sorted for
  // stable display.
  useEffect(() => {
    setAssignedProviders(agentConfig?.providers ?? []);
    window.api.plugins
      .runtime()
      .then((res) => setPoolProviders(sortProviders(res.providers)))
      .catch(() => {});
  }, [agentConfig]);

  // Assignable options: any runtime provider not already assigned. Assigned ids
  // stay visible as chips below (even if a provider later disappears from the
  // runtime) so a user can always see and remove a scoped selection.
  const unassignedProviders = poolProviders.filter((p) => !assignedProviders.includes(p.id));

  const handleAssignProvider = useCallback(
    async (id: string) => {
      // Empty = all: a non-empty selection scopes the agent to those providers;
      // clearing back to empty writes `null` (= all). `null` survives the wire;
      // `undefined` would be dropped by JSON.stringify, making the clear a no-op.
      const next = [...assignedProviders, id];
      setAssignedProviders(next);
      await updateConfig(agentId, { providers: next.length > 0 ? next : null });
    },
    [assignedProviders, agentId, updateConfig],
  );

  const handleUnassignProvider = useCallback(
    async (id: string) => {
      const next = assignedProviders.filter((p) => p !== id);
      setAssignedProviders(next);
      await updateConfig(agentId, { providers: next.length > 0 ? next : null });
    },
    [assignedProviders, agentId, updateConfig],
  );

  const providerLabel = (id: string): string => poolProviders.find((p) => p.id === id)?.label ?? id;

  // Sync chain model/fallbacks when agentConfig changes
  useEffect(() => {
    if (agentConfig?.model) {
      setChainModel(agentConfig.model);
      setChainFallbacks(agentConfig.fallbackModels ?? []);
    }
  }, [agentConfig?.model, agentConfig?.fallbackModels]);

  const handleSaveChain = async (): Promise<void> => {
    setChainSaving(true);
    try {
      await updateConfig(agentId, { model: chainModel, fallbackModels: chainFallbacks });
      setOpenCard(null);
    } finally {
      setChainSaving(false);
    }
  };

  const handleSaveTools = async (): Promise<void> => {
    setToolsSaving(true);
    try {
      await updateConfig(agentId, { tools: toolsDraft });
      setOpenCard(null);
      setToolsRestartNeeded(true);
    } finally {
      setToolsSaving(false);
    }
  };

  const handleSavePrompt = async (): Promise<void> => {
    setPromptSaving(true);
    try {
      await updateConfig(agentId, { systemPrompt: promptDraft });
      setOpenCard(null);
    } finally {
      setPromptSaving(false);
    }
  };

  const handleSaveWorkspace = async (): Promise<void> => {
    setWorkspaceSaving(true);
    try {
      await updateConfig(agentId, { workspace: workspaceDraft || undefined });
      setOpenCard(null);
    } finally {
      setWorkspaceSaving(false);
    }
  };

  const handleBrowseWorkspace = async (): Promise<void> => {
    const selected = await window.api.dialogOpenDirectory();
    if (selected) {
      setWorkspaceDraft(selected);
    }
  };

  const toggleDraftTool = (tool: string): void => {
    setToolsDraft((prev) =>
      prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool],
    );
  };

  if (!agentConfig) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-muted">
          Agent configuration is not available. Start the agent to view and edit its configuration.
        </p>
      </div>
    );
  }

  // Summaries for collapsed cards
  const modelLabel = (id: string) => availableModels.find((m) => m.value === id)?.label ?? id;
  const primaryLabel = modelLabel(chainModel);
  const modelsSummary =
    chainFallbacks.length > 0
      ? `${primaryLabel} → ${chainFallbacks.map(modelLabel).join(' → ')}`
      : primaryLabel;

  const promptText = agentConfig.systemPrompt ?? '';
  const promptSummary = promptText
    ? promptText.length > 100
      ? `${promptText.slice(0, 100)}...`
      : promptText
    : '(none)';

  const enabledTools = new Set(agentConfig.tools ?? []);
  const enabledGroupCount = TOOL_GROUPS.filter((g) =>
    g.tools.every((t) => enabledTools.has(t)),
  ).length;
  const toolsSummary = `${enabledGroupCount} of ${TOOL_GROUPS.length} groups enabled`;

  return (
    <div className="space-y-4">
      {/* Working Directory card */}
      <div className="rounded-lg border border-border bg-card-bg">
        <button
          type="button"
          onClick={() => {
            if (openCard !== 'workspace') setWorkspaceDraft(workspace ?? '');
            setOpenCard(openCard === 'workspace' ? null : 'workspace');
          }}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">Working Directory</h3>
            <p className="text-xs text-muted mt-0.5 truncate">{workspace || 'Auto-generated'}</p>
          </div>
          <div className="flex items-center gap-1 ml-2 shrink-0">
            {workspace && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  window.api.openPath(workspace);
                }}
                className="rounded p-1 text-muted transition-colors hover:text-foreground"
                title="Open in Finder"
              >
                <FolderOpen size={14} />
              </button>
            )}
            {openCard === 'workspace' ? (
              <ChevronUp size={16} className="text-muted" />
            ) : (
              <ChevronDown size={16} className="text-muted" />
            )}
          </div>
        </button>
        {openCard === 'workspace' && (
          <div className="border-t border-border p-4">
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={workspaceDraft}
                placeholder="Auto-generated"
                className="flex-1 rounded-lg border border-border bg-card-bg px-4 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none"
              />
              {workspaceDraft && (
                <button
                  type="button"
                  onClick={() => setWorkspaceDraft('')}
                  className="rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
                  title="Reset to auto-generated"
                >
                  <RotateCcw size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={handleBrowseWorkspace}
                className="rounded-lg border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground"
              >
                Browse…
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted">
              The working directory for this agent's file and shell tools. Changes take effect on
              new conversations.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleSaveWorkspace}
                disabled={workspaceSaving}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {workspaceSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setOpenCard(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Models card */}
      <div className="rounded-lg border border-border bg-card-bg">
        <button
          type="button"
          onClick={() => setOpenCard(openCard === 'models' ? null : 'models')}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div>
            <h3 className="text-sm font-medium">Models</h3>
            <p className="text-xs text-muted mt-0.5">{modelsSummary}</p>
          </div>
          {openCard === 'models' ? (
            <ChevronUp size={16} className="text-muted" />
          ) : (
            <ChevronDown size={16} className="text-muted" />
          )}
        </button>
        {openCard === 'models' && (
          <div className="border-t border-border p-4">
            <ModelChainEditor
              model={chainModel}
              fallbackModels={chainFallbacks}
              availableModels={availableModels}
              onChange={(m, fb) => {
                setChainModel(m);
                setChainFallbacks(fb);
              }}
              onRefresh={refreshModels}
              refreshing={modelsRefreshing}
              // Live providers-card selection: an empty allow-list means "all",
              // so pass undefined to disable filtering; a non-empty selection
              // filters the dropdown and re-filters immediately as the card edits.
              allowedProviders={assignedProviders.length > 0 ? assignedProviders : undefined}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleSaveChain}
                disabled={chainSaving}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {chainSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setOpenCard(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* System Prompt card */}
      <div className="rounded-lg border border-border bg-card-bg">
        <button
          type="button"
          onClick={() => {
            if (openCard !== 'prompt') setPromptDraft(agentConfig.systemPrompt ?? '');
            setOpenCard(openCard === 'prompt' ? null : 'prompt');
          }}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">System Prompt</h3>
            <p className="text-xs text-muted mt-0.5 truncate">{promptSummary}</p>
          </div>
          {openCard === 'prompt' ? (
            <ChevronUp size={16} className="ml-2 shrink-0 text-muted" />
          ) : (
            <ChevronDown size={16} className="ml-2 shrink-0 text-muted" />
          )}
        </button>
        {openCard === 'prompt' && (
          <div className="border-t border-border p-4">
            <textarea
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              rows={8}
              className="w-full resize-y rounded border border-border bg-card-bg p-3 text-sm leading-relaxed focus:border-accent focus:outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleSavePrompt}
                disabled={promptSaving}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {promptSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setOpenCard(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Tools card */}
      <div className="rounded-lg border border-border bg-card-bg">
        <button
          type="button"
          onClick={() => {
            if (openCard !== 'tools') setToolsDraft(agentConfig.tools ?? []);
            setOpenCard(openCard === 'tools' ? null : 'tools');
          }}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div>
            <h3 className="text-sm font-medium">Tools</h3>
            <p className="text-xs text-muted mt-0.5">{toolsSummary}</p>
          </div>
          {openCard === 'tools' ? (
            <ChevronUp size={16} className="text-muted" />
          ) : (
            <ChevronDown size={16} className="text-muted" />
          )}
        </button>
        {openCard === 'tools' && (
          <div className="border-t border-border p-4">
            {toolsRestartNeeded && (
              <div className="mb-2 rounded-lg bg-yellow-900/20 px-3 py-2 text-xs text-yellow">
                Tools updated — restart the agent to apply changes.
              </div>
            )}
            <div className="mb-3 flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-foreground">
                <input
                  type="checkbox"
                  checked={toolsDraft.length === ALL_TOOL_IDS.length}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        toolsDraft.length > 0 && toolsDraft.length < ALL_TOOL_IDS.length;
                  }}
                  onChange={() =>
                    setToolsDraft((prev) =>
                      prev.length === ALL_TOOL_IDS.length ? [] : [...ALL_TOOL_IDS],
                    )
                  }
                  className="accent-accent"
                />
                Select all
              </label>
            </div>
            <div className="space-y-2">
              {TOOL_GROUPS.map((group) => {
                const allEnabled = group.tools.every((t) => toolsDraft.includes(t));
                const someEnabled = !allEnabled && group.tools.some((t) => toolsDraft.includes(t));
                return (
                  <label
                    key={group.name}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-xs transition-colors hover:bg-card-bg"
                  >
                    <input
                      type="checkbox"
                      checked={allEnabled}
                      ref={(el) => {
                        if (el) el.indeterminate = someEnabled;
                      }}
                      onChange={() =>
                        setToolsDraft((prev) => {
                          const without = prev.filter((t) => !group.tools.includes(t));
                          return allEnabled ? without : [...without, ...group.tools];
                        })
                      }
                      className="mt-0.5 accent-accent"
                    />
                    <span>
                      <span className="font-medium">{group.name}</span>
                      <span className="block text-[11px] text-muted">{group.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleSaveTools}
                disabled={toolsSaving}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {toolsSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setOpenCard(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Connectors card */}
      <div className="rounded-lg border border-border bg-card-bg">
        <button
          type="button"
          onClick={() => setOpenCard(openCard === 'connectors' ? null : 'connectors')}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div>
            <h3 className="text-sm font-medium">Connectors</h3>
            <p className="text-xs text-muted">
              {assignedConnectors.length > 0
                ? `${assignedConnectors.length} connected`
                : 'No connectors assigned'}
            </p>
          </div>
          {openCard === 'connectors' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {openCard === 'connectors' && (
          <div className="border-t border-border p-4">
            {assignedConnectors.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {assignedConnectors.map((name) => {
                  const info = poolConnectors.find((c) => c.name === name);
                  return (
                    <span
                      key={name}
                      className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-sm"
                    >
                      {info && <HealthDot health={connectorHealthStatus(info.status)} />}
                      {name}
                      <button
                        type="button"
                        onClick={() => handleUnassignConnector(name)}
                        className="ml-1 text-fg-muted hover:text-red-500"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {unassignedConnectors.length > 0 ? (
              <select
                onChange={(e) => {
                  handleAssignConnector(e.target.value);
                  e.target.value = '';
                }}
                defaultValue=""
                className="rounded border border-border bg-bg-input px-3 py-1.5 text-sm"
              >
                <option value="" disabled>
                  Add connector...
                </option>
                {unassignedConnectors.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.tools.length} tools)
                  </option>
                ))}
              </select>
            ) : assignedConnectors.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No connectors available.{' '}
                <a href="#/settings/connectors" className="text-accent hover:underline">
                  Add connectors
                </a>{' '}
                first.
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* Plugins card. Per-agent plugin selection is visibility/routing only;
          trust is gateway-wide. Empty = all (undefined). */}
      <div className="rounded-lg border border-border bg-card-bg">
        <button
          type="button"
          onClick={() => setOpenCard(openCard === 'plugins' ? null : 'plugins')}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div>
            <h3 className="text-sm font-medium">Plugins</h3>
            <p className="text-xs text-muted">
              {assignedPlugins.length > 0
                ? `${assignedPlugins.length} selected`
                : 'All plugins (default)'}
            </p>
          </div>
          {openCard === 'plugins' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {openCard === 'plugins' && (
          <div className="border-t border-border p-4">
            {assignedPlugins.length > 0 ? (
              <div className="mb-3 flex flex-wrap gap-2">
                {assignedPlugins.map((name) => (
                  <span
                    key={name}
                    className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-sm"
                  >
                    {pluginLabel(name)}
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      onClick={() => handleUnassignPlugin(name)}
                      className="ml-1 text-fg-muted hover:text-red-500"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mb-3 text-sm text-muted">
                All plugins (default). This agent sees every loaded plugin. Select plugins below to
                scope it to a subset.
              </p>
            )}

            {unassignedPlugins.length > 0 ? (
              <select
                onChange={(e) => {
                  handleAssignPlugin(e.target.value);
                  e.target.value = '';
                }}
                defaultValue=""
                className="rounded border border-border bg-bg-input px-3 py-1.5 text-sm"
              >
                <option value="" disabled>
                  Add plugin...
                </option>
                {unassignedPlugins.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.displayName ?? p.name}
                  </option>
                ))}
              </select>
            ) : poolPlugins.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No plugins installed.{' '}
                <a href="#/settings/plugins" className="text-accent hover:underline">
                  Manage plugins
                </a>{' '}
                first.
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* Providers card. Per-agent provider allow-list over the runtime
          providers. Empty = all available providers (default). */}
      <div className="rounded-lg border border-border bg-card-bg">
        <button
          type="button"
          onClick={() => setOpenCard(openCard === 'providers' ? null : 'providers')}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div>
            <h3 className="text-sm font-medium">Providers</h3>
            <p className="text-xs text-muted">
              {assignedProviders.length > 0
                ? `${assignedProviders.length} selected`
                : 'All providers (default)'}
            </p>
          </div>
          {openCard === 'providers' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {openCard === 'providers' && (
          <div className="border-t border-border p-4">
            {assignedProviders.length > 0 ? (
              <div className="mb-3 flex flex-wrap gap-2">
                {assignedProviders.map((id) => (
                  <span
                    key={id}
                    className="flex items-center gap-1 rounded bg-bg-hover px-2 py-1 text-sm"
                  >
                    {providerLabel(id)}
                    <button
                      type="button"
                      aria-label={`Remove ${id}`}
                      onClick={() => handleUnassignProvider(id)}
                      className="ml-1 text-fg-muted hover:text-red-500"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mb-3 text-sm text-muted">
                All providers (default). This agent can use every provider. Select providers below
                to scope it to a subset — the model dropdown filters to match.
              </p>
            )}

            {unassignedProviders.length > 0 ? (
              <select
                onChange={(e) => {
                  handleAssignProvider(e.target.value);
                  e.target.value = '';
                }}
                defaultValue=""
                className="rounded border border-border bg-bg-input px-3 py-1.5 text-sm"
              >
                <option value="" disabled>
                  Add provider...
                </option>
                {unassignedProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            ) : poolProviders.length === 0 ? (
              <p className="text-sm text-fg-muted">
                No providers available.{' '}
                <a href="#/settings/ai-providers" className="text-accent hover:underline">
                  Add providers
                </a>{' '}
                first.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
