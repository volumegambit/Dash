import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ModelChainEditor } from '../components/ModelChainEditor.js';
import type { AppSettings } from '../../../shared/ipc.js';
import { useAvailableModels } from '../hooks/useAvailableModels.js';

function Settings(): JSX.Element {
  const [version, setVersion] = useState<string>('...');
  const [settings, setSettings] = useState<AppSettings>({});
  const [saving, setSaving] = useState(false);
  const availableModels = useAvailableModels();

  useEffect(() => {
    window.api.getVersion().then(setVersion);
    window.api.settingsGet().then(setSettings).catch(() => {});
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
    <div>
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-2 text-muted">Application settings and configuration.</p>

      <div className="mt-6 rounded-lg border border-border bg-sidebar-bg p-4">
        <h2 className="mb-1 text-sm font-semibold">Default Model Chain</h2>
        <p className="mb-4 text-xs text-muted">
          Pre-populates the model selection when creating a new agent.
          {saving && <span className="ml-2 text-primary">Saving...</span>}
        </p>
        <ModelChainEditor
          model={settings.defaultModel ?? availableModels[0]?.value ?? ''}
          fallbackModels={settings.defaultFallbackModels ?? []}
          availableModels={availableModels}
          onChange={handleChainChange}
        />
      </div>

      <div className="mt-6 rounded-lg border border-border bg-sidebar-bg p-4">
        <h2 className="text-sm font-semibold">About</h2>
        <p className="mt-2 text-sm text-muted">
          Mission Control v<span className="text-foreground">{version}</span>
        </p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings')({
  component: Settings,
});
