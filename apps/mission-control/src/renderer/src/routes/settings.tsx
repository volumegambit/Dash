import { providerSecretKey } from '@dash/mc/provider-keys';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/ipc.js';
import { ModelChainEditor } from '../components/ModelChainEditor.js';
import { useAvailableModels } from '../hooks/useAvailableModels.js';
import { useSecretsStore } from '../stores/secrets.js';

function Settings(): JSX.Element {
  const [version, setVersion] = useState<string>('...');
  const [settings, setSettings] = useState<AppSettings>({});
  const [saving, setSaving] = useState(false);
  const {
    models: availableModels,
    refreshing: modelsRefreshing,
    refresh: refreshModels,
  } = useAvailableModels();

  // Brave Search key state
  const { loadKeys, setSecret, deleteSecret, getSecret } = useSecretsStore();
  const keys = useSecretsStore((s) => s.keys);
  const [braveKeyMasked, setBraveKeyMasked] = useState<string | null>(null);
  const [braveKeyInput, setBraveKeyInput] = useState('');
  const [braveKeySaving, setBraveKeySaving] = useState(false);

  useEffect(() => {
    window.api.getVersion().then(setVersion);
    window.api
      .settingsGet()
      .then(setSettings)
      .catch(() => {});
    loadKeys();
  }, [loadKeys]);

  // Load masked Brave key when keys are available
  useEffect(() => {
    const hasBrave = keys.some((k) => k.startsWith(providerSecretKey('brave')));
    if (hasBrave) {
      getSecret(providerSecretKey('brave')).then((val) => {
        if (val) {
          setBraveKeyMasked(`${val.slice(0, 6)}${'•'.repeat(6)}${val.slice(-4)}`);
        }
      });
    } else {
      setBraveKeyMasked(null);
    }
  }, [keys, getSecret]);

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

  const handleSaveBraveKey = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = braveKeyInput.trim();
      if (!trimmed) return;
      setBraveKeySaving(true);
      try {
        await setSecret(providerSecretKey('brave'), trimmed);
        setBraveKeyMasked(`${trimmed.slice(0, 6)}${'•'.repeat(6)}${trimmed.slice(-4)}`);
        setBraveKeyInput('');
      } finally {
        setBraveKeySaving(false);
      }
    },
    [braveKeyInput, setSecret],
  );

  const handleRemoveBraveKey = useCallback(async () => {
    await deleteSecret(providerSecretKey('brave'));
    setBraveKeyMasked(null);
    setBraveKeyInput('');
  }, [deleteSecret]);

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
          onRefresh={refreshModels}
          refreshing={modelsRefreshing}
        />
      </div>

      <div className="mt-6 rounded-lg border border-border bg-sidebar-bg p-4">
        <h2 className="mb-1 text-sm font-semibold">Web Search</h2>
        <p className="mb-4 text-xs text-muted">
          API key for web search. Currently supports Brave Search.
        </p>
        {braveKeyMasked ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 rounded border border-border bg-sidebar-hover px-3 py-1.5 text-xs font-mono text-muted">
              {braveKeyMasked}
            </span>
            <button
              type="button"
              onClick={handleRemoveBraveKey}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/20"
            >
              Remove
            </button>
          </div>
        ) : (
          <form className="flex gap-2" onSubmit={handleSaveBraveKey}>
            <input
              type="password"
              value={braveKeyInput}
              onChange={(e) => setBraveKeyInput(e.target.value)}
              placeholder="BSA-xxxxxxxxxxxxxxxx"
              className="flex-1 rounded-lg border border-border bg-sidebar-bg px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
            />
            <button
              type="submit"
              disabled={!braveKeyInput.trim() || braveKeySaving}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {braveKeySaving ? 'Saving...' : 'Save'}
            </button>
          </form>
        )}
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
