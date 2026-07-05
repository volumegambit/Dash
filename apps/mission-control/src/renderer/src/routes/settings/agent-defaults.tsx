import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../../shared/ipc.js';
import { ModelChainEditor } from '../../components/ModelChainEditor.js';
import { WebSearchSettings } from '../../components/WebSearchSettings.js';
import { useAvailableModels } from '../../hooks/useAvailableModels.js';

export function AgentDefaultsSettings(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>({});
  const [saving, setSaving] = useState(false);
  const {
    models: availableModels,
    refreshing: modelsRefreshing,
    refresh: refreshModels,
  } = useAvailableModels();

  useEffect(() => {
    window.api
      .settingsGet()
      .then(setSettings)
      .catch(() => {});
  }, []);

  const handleChainChange = async (model: string, fallbackModels: string[]): Promise<void> => {
    const patch: AppSettings = { defaultModel: model, defaultFallbackModels: fallbackModels };
    setSettings((prev) => ({ ...prev, ...patch }));
    setSaving(true);
    try {
      await window.api.settingsSet(patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="rounded-lg border border-border bg-card-bg p-4">
        <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
          Default Model Chain
        </h2>
        <p className="mb-4 text-xs text-muted">
          Pre-populates the model selection when creating a new agent.
          {saving && <span className="ml-2 text-accent">Saving...</span>}
        </p>
        <ModelChainEditor
          model={settings.defaultModel ?? availableModels[0]?.value ?? ''}
          fallbackModels={settings.defaultFallbackModels ?? []}
          availableModels={availableModels}
          onChange={handleChainChange}
          onRefresh={refreshModels}
          refreshing={modelsRefreshing}
        />
      </div>

      <WebSearchSettings />
    </>
  );
}

export const Route = createFileRoute('/settings/agent-defaults')({
  component: AgentDefaultsSettings,
});
