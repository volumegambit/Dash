import { createFileRoute } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/ipc.js';
import { ModelChainEditor } from '../components/ModelChainEditor.js';
import { useAvailableModels } from '../hooks/useAvailableModels.js';

function Settings(): JSX.Element {
  const [version, setVersion] = useState<string>('...');
  const [settings, setSettings] = useState<AppSettings>({});
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const {
    models: availableModels,
    refreshing: modelsRefreshing,
    refresh: refreshModels,
  } = useAvailableModels();

  useEffect(() => {
    window.api.getVersion().then(setVersion);
    window.api
      .settingsGet()
      .then(setSettings)
      .catch(() => {});
  }, []);

  const handleRestartGateway = useCallback(async () => {
    setRestarting(true);
    try {
      await window.api.gatewayRestart();
    } catch {
      // Will recover on next health poll
    } finally {
      setRestarting(false);
    }
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
    <div className="h-full flex flex-col overflow-hidden">
      {/* Page header */}
      <div className="bg-surface px-8 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
            Settings
          </h1>
          <p className="mt-1 text-sm text-muted">Application settings and configuration.</p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-8">
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

        <div className="mt-6 rounded-lg border border-border bg-card-bg p-4">
          <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
            Gateway
          </h2>
          <p className="mb-3 text-xs text-muted">
            The gateway process manages agents, channels, and credentials.
          </p>
          <button
            type="button"
            onClick={handleRestartGateway}
            disabled={restarting}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={restarting ? 'animate-spin' : ''} />
            {restarting ? 'Restarting...' : 'Restart Gateway'}
          </button>
        </div>

        <div className="mt-6 rounded-lg border border-border bg-card-bg p-4">
          <h2 className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
            About
          </h2>
          <p className="mt-2 text-sm text-muted">
            DashSquad v<span className="text-foreground">{version}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings')({
  component: Settings,
});
