import type { AgentDeployAgentConfig } from '@dash/mc';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ModelChainEditor } from '../../../components/ModelChainEditor.js';
import { useAvailableModels } from '../../../hooks/useAvailableModels.js';
import { useAvailableTools } from '../../../hooks/useAvailableTools.js';

type ConfigPatch = {
  model?: string;
  fallbackModels?: string[];
  tools?: string[];
  systemPrompt?: string;
};

interface AgentConfigTabProps {
  deploymentId: string;
  agentConfig: AgentDeployAgentConfig | undefined;
  updateConfig: (id: string, patch: ConfigPatch) => Promise<void>;
}

export function AgentConfigTab({
  deploymentId,
  agentConfig,
  updateConfig,
}: AgentConfigTabProps): JSX.Element {
  const availableModels = useAvailableModels();
  const availableTools = useAvailableTools();

  // Collapsible card state
  const [modelsOpen, setModelsOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  // Model chain editing state
  const [editingChain, setEditingChain] = useState(false);
  const [chainModel, setChainModel] = useState('');
  const [chainFallbacks, setChainFallbacks] = useState<string[]>([]);
  const [chainSaving, setChainSaving] = useState(false);

  // Tools editing state
  const [editingTools, setEditingTools] = useState(false);
  const [toolsDraft, setToolsDraft] = useState<string[]>([]);
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsRestartNeeded, setToolsRestartNeeded] = useState(false);

  // System prompt editing state
  const [editingPrompt, setEditingPrompt] = useState(false);
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
      setEditingChain(false);
    } finally {
      setChainSaving(false);
    }
  };

  const handleSaveTools = async (): Promise<void> => {
    setToolsSaving(true);
    try {
      await updateConfig(deploymentId, { tools: toolsDraft });
      setEditingTools(false);
      setToolsRestartNeeded(true);
    } finally {
      setToolsSaving(false);
    }
  };

  const handleSavePrompt = async (): Promise<void> => {
    setPromptSaving(true);
    try {
      await updateConfig(deploymentId, { systemPrompt: promptDraft });
      setEditingPrompt(false);
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
  const primaryLabel = availableModels.find((m) => m.value === chainModel)?.label ?? chainModel;
  const fallbackCount = chainFallbacks.length;
  const modelsSummary =
    fallbackCount > 0
      ? `${primaryLabel} + ${fallbackCount} fallback${fallbackCount > 1 ? 's' : ''}`
      : primaryLabel;

  const promptText = agentConfig.systemPrompt ?? '';
  const promptSummary = promptText
    ? promptText.length > 100
      ? `${promptText.slice(0, 100)}...`
      : promptText
    : '(none)';

  const enabledToolCount = (agentConfig.tools ?? []).length;
  const totalToolCount = availableTools.length;
  const toolsSummary = `${enabledToolCount} of ${totalToolCount} tools enabled`;

  return (
    <div className="space-y-4">
      {/* Models card */}
      <div className="rounded-lg border border-border">
        <button
          type="button"
          onClick={() => setModelsOpen(!modelsOpen)}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div>
            <h3 className="text-sm font-medium">Models</h3>
            <p className="text-xs text-muted mt-0.5">{modelsSummary}</p>
          </div>
          {modelsOpen ? (
            <ChevronUp size={16} className="text-muted" />
          ) : (
            <ChevronDown size={16} className="text-muted" />
          )}
        </button>
        {modelsOpen && (
          <div className="border-t border-border p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted">Model Chain</h2>
              {!editingChain && (
                <button
                  type="button"
                  onClick={() => setEditingChain(true)}
                  className="text-xs text-primary hover:underline"
                >
                  Edit
                </button>
              )}
            </div>
            {editingChain ? (
              <div className="rounded-lg border border-border bg-sidebar-bg p-3">
                <ModelChainEditor
                  model={chainModel}
                  fallbackModels={chainFallbacks}
                  availableModels={availableModels}
                  onChange={(m, fb) => {
                    setChainModel(m);
                    setChainFallbacks(fb);
                  }}
                />
                <div className="mt-3 flex gap-2">
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
                    onClick={() => setEditingChain(false)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {[chainModel, ...chainFallbacks].map((model, i) => {
                  const label = availableModels.find((m) => m.value === model)?.label ?? model;
                  const keyInfo = modelKeys[model];
                  return (
                    <div
                      key={model}
                      className="flex items-center justify-between rounded-lg border border-border bg-sidebar-bg px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{label}</span>
                        {i === 0 && (
                          <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            primary
                          </span>
                        )}
                        {i > 0 && (
                          <span className="rounded bg-sidebar-hover px-1.5 py-0.5 text-[10px] font-medium text-muted">
                            fallback {i}
                          </span>
                        )}
                      </div>
                      {keyInfo && (
                        <div className="flex items-center gap-2 text-xs text-muted">
                          <span className="font-medium">{keyInfo.label}</span>
                          <span className="font-mono">{keyInfo.masked}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* System Prompt card */}
      <div className="rounded-lg border border-border">
        <button
          type="button"
          onClick={() => setPromptOpen(!promptOpen)}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">System Prompt</h3>
            <p className="text-xs text-muted mt-0.5 truncate">{promptSummary}</p>
          </div>
          {promptOpen ? (
            <ChevronUp size={16} className="ml-2 shrink-0 text-muted" />
          ) : (
            <ChevronDown size={16} className="ml-2 shrink-0 text-muted" />
          )}
        </button>
        {promptOpen && (
          <div className="border-t border-border p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted">Prompt</h2>
              {!editingPrompt && (
                <button
                  type="button"
                  onClick={() => {
                    setPromptDraft(agentConfig.systemPrompt ?? '');
                    setEditingPrompt(true);
                  }}
                  className="text-xs text-primary hover:underline"
                >
                  Edit
                </button>
              )}
            </div>
            {editingPrompt ? (
              <div className="rounded-lg border border-border bg-sidebar-bg p-3">
                <textarea
                  value={promptDraft}
                  onChange={(e) => setPromptDraft(e.target.value)}
                  rows={8}
                  className="w-full resize-y rounded border border-border bg-[#0d0d0d] p-3 text-sm leading-relaxed focus:border-primary focus:outline-none"
                />
                <div className="mt-3 flex gap-2">
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
                    onClick={() => setEditingPrompt(false)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-sidebar-bg p-3 text-sm whitespace-pre-wrap">
                {agentConfig.systemPrompt || <span className="text-muted">(none)</span>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tools card */}
      <div className="rounded-lg border border-border">
        <button
          type="button"
          onClick={() => setToolsOpen(!toolsOpen)}
          className="flex w-full items-center justify-between p-4 text-left"
        >
          <div>
            <h3 className="text-sm font-medium">Tools</h3>
            <p className="text-xs text-muted mt-0.5">{toolsSummary}</p>
          </div>
          {toolsOpen ? (
            <ChevronUp size={16} className="text-muted" />
          ) : (
            <ChevronDown size={16} className="text-muted" />
          )}
        </button>
        {toolsOpen && (
          <div className="border-t border-border p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted">Enabled Tools</h2>
              {!editingTools && (
                <button
                  type="button"
                  onClick={() => {
                    setToolsDraft(agentConfig.tools ?? []);
                    setEditingTools(true);
                  }}
                  className="text-xs text-primary hover:underline"
                >
                  Edit
                </button>
              )}
            </div>
            {toolsRestartNeeded && !editingTools && (
              <div className="mb-2 rounded-lg bg-yellow-900/20 px-3 py-2 text-xs text-yellow-400">
                Tools updated — restart the agent to apply changes.
              </div>
            )}
            {editingTools ? (
              <div className="rounded-lg border border-border bg-sidebar-bg p-3">
                <div className="mb-2 flex items-center justify-between">
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-foreground">
                    <input
                      type="checkbox"
                      checked={toolsDraft.length === availableTools.length}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            toolsDraft.length > 0 && toolsDraft.length < availableTools.length;
                      }}
                      onChange={() =>
                        setToolsDraft((prev) =>
                          prev.length === availableTools.length
                            ? []
                            : availableTools.map((t) => t.value),
                        )
                      }
                      className="accent-primary"
                    />
                    Select all
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {availableTools.map((tool) => (
                    <label
                      key={tool.value}
                      className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-xs transition-colors hover:bg-sidebar-hover"
                    >
                      <input
                        type="checkbox"
                        checked={toolsDraft.includes(tool.value)}
                        onChange={() => toggleDraftTool(tool.value)}
                        className="mt-0.5 accent-primary"
                      />
                      <span>
                        {tool.label}
                        {tool.description && (
                          <span className="block text-[11px] text-muted">{tool.description}</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
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
                    onClick={() => setEditingTools(false)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-sidebar-bg p-3">
                {(agentConfig.tools ?? []).length > 0 ? (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    {availableTools
                      .filter((t) => (agentConfig.tools ?? []).includes(t.value))
                      .map((t) => (
                        <div key={t.value}>
                          <span className="text-sm">{t.label}</span>
                          {t.description && (
                            <span className="ml-1.5 text-xs text-muted">{t.description}</span>
                          )}
                        </div>
                      ))}
                  </div>
                ) : (
                  <span className="text-sm text-muted">(none)</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
