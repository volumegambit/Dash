import type { AgentDeployAgentConfig } from '@dash/mc';
import { ChevronDown, ChevronUp, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ModelChainEditor } from '../../../components/ModelChainEditor.js';
import { ALL_TOOL_IDS, TOOL_GROUPS } from '../../../components/deploy-options.js';
import { useAvailableModels } from '../../../hooks/useAvailableModels.js';

type ConfigPatch = {
  model?: string;
  fallbackModels?: string[];
  tools?: string[];
  systemPrompt?: string;
};

interface AgentConfigTabProps {
  deploymentId: string;
  agentConfig: AgentDeployAgentConfig | undefined;
  workspace?: string;
  updateConfig: (id: string, patch: ConfigPatch) => Promise<void>;
}

export function AgentConfigTab({
  deploymentId,
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
  const [openCard, setOpenCard] = useState<'models' | 'prompt' | 'tools' | null>(null);

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

  // Credential key resolution
  const [modelKeys, setModelKeys] = useState<Record<string, { label: string; masked: string }>>({});

  // Extract credentialKeys from the runtime config (exists at runtime but not on the declared type)
  const credentialKeys = (
    agentConfig as AgentDeployAgentConfig & { credentialKeys?: Record<string, string> }
  )?.credentialKeys;

  // Sync chain model/fallbacks when agentConfig changes
  useEffect(() => {
    if (agentConfig?.model) {
      setChainModel(agentConfig.model);
      setChainFallbacks(agentConfig.fallbackModels ?? []);
    }
  }, [agentConfig?.model, agentConfig?.fallbackModels]);

  // Resolve credential keys for display
  useEffect(() => {
    if (!agentConfig?.model) return;
    const allModels = [agentConfig.model, ...(agentConfig.fallbackModels ?? [])];
    const seen = new Set<string>();
    const result: Record<string, { label: string; masked: string }> = {};

    const resolve = async (): Promise<void> => {
      for (const model of allModels) {
        const provider = model.split('/')[0];
        if (!provider || seen.has(provider)) {
          if (provider && result[provider]) {
            result[model] = result[Object.keys(result).find((k) => k.startsWith(provider)) ?? ''];
          }
          continue;
        }
        seen.add(provider);
        const credName = credentialKeys?.[provider] ?? 'default';
        const secretKey = `${provider}-api-key:${credName}`;
        try {
          const val = await window.api.secretsGet(secretKey);
          const masked =
            val && val.length > 17
              ? `${val.slice(0, 10)}${'*'.repeat(6)}${val.slice(-7)}`
              : val
                ? '********'
                : 'N/A';
          result[model] = { label: credName, masked };
        } catch {
          result[model] = { label: credName, masked: 'N/A' };
        }
      }
      for (const model of allModels) {
        if (!result[model]) {
          const provider = model.split('/')[0];
          const match = allModels.find((m) => result[m] && m.split('/')[0] === provider);
          if (match) result[model] = result[match];
        }
      }
      setModelKeys(result);
    };
    resolve();
  }, [agentConfig?.model, agentConfig?.fallbackModels, credentialKeys]);

  const handleSaveChain = async (): Promise<void> => {
    setChainSaving(true);
    try {
      await updateConfig(deploymentId, { model: chainModel, fallbackModels: chainFallbacks });
      setOpenCard(null);
    } finally {
      setChainSaving(false);
    }
  };

  const handleSaveTools = async (): Promise<void> => {
    setToolsSaving(true);
    try {
      await updateConfig(deploymentId, { tools: toolsDraft });
      setOpenCard(null);
      setToolsRestartNeeded(true);
    } finally {
      setToolsSaving(false);
    }
  };

  const handleSavePrompt = async (): Promise<void> => {
    setPromptSaving(true);
    try {
      await updateConfig(deploymentId, { systemPrompt: promptDraft });
      setOpenCard(null);
    } finally {
      setPromptSaving(false);
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
  const enabledGroupCount = TOOL_GROUPS.filter((g) => g.tools.every((t) => enabledTools.has(t)))
    .length;
  const toolsSummary = `${enabledGroupCount} of ${TOOL_GROUPS.length} groups enabled`;

  return (
    <div className="space-y-4">
      {/* Workspace card (read-only) */}
      {workspace && (
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between p-4">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">Workspace</h3>
              <p className="mt-0.5 min-w-0 truncate font-mono text-xs text-muted" title={workspace}>
                {workspace}
              </p>
            </div>
            <button
              type="button"
              onClick={() => window.api.openPath(workspace)}
              className="shrink-0 rounded p-1 text-muted transition-colors hover:text-foreground"
              title="Open in Finder"
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Models card */}
      <div className="rounded-lg border border-border">
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
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleSaveChain}
                disabled={chainSaving}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {chainSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setOpenCard(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* System Prompt card */}
      <div className="rounded-lg border border-border">
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
              className="w-full resize-y rounded border border-border bg-[#0d0d0d] p-3 text-sm leading-relaxed focus:border-primary focus:outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleSavePrompt}
                disabled={promptSaving}
                className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {promptSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setOpenCard(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Tools card */}
      <div className="rounded-lg border border-border">
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
              <div className="mb-2 rounded-lg bg-yellow-900/20 px-3 py-2 text-xs text-yellow-400">
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
                  className="accent-primary"
                />
                Select all
              </label>
            </div>
            <div className="space-y-2">
              {TOOL_GROUPS.map((group) => {
                const allEnabled = group.tools.every((t) => toolsDraft.includes(t));
                const someEnabled =
                  !allEnabled && group.tools.some((t) => toolsDraft.includes(t));
                return (
                  <label
                    key={group.name}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-xs transition-colors hover:bg-sidebar-hover"
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
                      className="mt-0.5 accent-primary"
                    />
                    <span>
                      <span className="font-medium">{group.name}</span>
                      <span className="ml-1.5 text-[11px] text-muted">
                        ({group.tools.length} tools)
                      </span>
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
                className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {toolsSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setOpenCard(null)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
