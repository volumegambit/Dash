import type { PluginRecord } from '@dash/management';
import { createFileRoute } from '@tanstack/react-router';
import { Download, Loader, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PluginTrustModal } from '../components/PluginTrustModal.js';
import { usePluginsStore } from '../stores/plugins.js';

export const Route = createFileRoute('/plugins')({
  component: PluginsScreen,
});

interface InstallForm {
  source: string;
  name?: string;
}

export function PluginsScreen(): JSX.Element {
  const [installForm, setInstallForm] = useState<InstallForm>({ source: '' });
  const [installError, setInstallError] = useState<string | null>(null);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [installLoading, setInstallLoading] = useState(false);
  const [trustModal, setTrustModal] = useState<{
    plugin: PluginRecord;
    submitting: boolean;
  } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);

  // Select state and actions individually. Actions are stable references in
  // zustand, so depending on `loadPlugins` (rather than the whole store object)
  // keeps the mount effect from re-firing every time `set()` swaps the snapshot.
  const records = usePluginsStore((s) => s.records);
  const loading = usePluginsStore((s) => s.loading);
  const error = usePluginsStore((s) => s.error);
  const loadPlugins = usePluginsStore((s) => s.loadPlugins);
  const setPluginState = usePluginsStore((s) => s.setState);
  const installPlugin = usePluginsStore((s) => s.install);
  const removePlugin = usePluginsStore((s) => s.remove);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  const handleInstall = useCallback(async () => {
    setInstallError(null);
    setInstallNote(null);
    if (!installForm.source.trim()) {
      setInstallError('Source is required');
      return;
    }
    setInstallLoading(true);
    try {
      const result = await installPlugin({
        source: installForm.source.trim(),
        name: installForm.name?.trim() || undefined,
      });
      setInstallForm({ source: '' });

      // RP3-2: the install result is a union — either a flat InstalledPlugin
      // (201) or a reload-pending envelope { ok, installed, note, error } (200).
      // Narrow it before reading scan fields.
      const installed = 'installed' in result ? result.installed : result;
      const reloadNote = 'installed' in result ? result.note : undefined;

      if (installed.scanVerdict === 'suspicious' || installed.scanVerdict === 'dangerous') {
        const reasons = installed.scanReasons.length ? ` ${installed.scanReasons.join(' ')}` : '';
        setInstallError(`Warning: scan verdict is "${installed.scanVerdict}".${reasons}`);
      }
      if (reloadNote) {
        setInstallNote(`Installed; reload pending. ${reloadNote}`);
      }
    } catch (err) {
      setInstallError((err as Error).message);
    } finally {
      setInstallLoading(false);
    }
  }, [installForm, installPlugin]);

  const handleToggleEnable = useCallback(
    async (plugin: PluginRecord) => {
      try {
        await setPluginState(plugin.name, { enabled: !plugin.enabled });
      } catch {
        // Error already captured in the store; the screen renders it.
      }
    },
    [setPluginState],
  );

  const handleToggleTrust = useCallback(
    (plugin: PluginRecord) => {
      if (plugin.trusted) {
        // Revoke trust — fire and forget; store splices the updated record in.
        setPluginState(plugin.name, { trusted: false }).catch(() => {
          // Error surfaced via the store's error state.
        });
      } else if (plugin.enabled) {
        // Open the trust modal for an enabled-but-untrusted plugin.
        setTrustModal({ plugin, submitting: false });
      }
    },
    [setPluginState],
  );

  const handleConfirmTrust = useCallback(
    async (name: string) => {
      if (!trustModal) return;
      setTrustModal({ ...trustModal, submitting: true });
      try {
        await setPluginState(name, { trusted: true });
        setTrustModal(null);
      } catch {
        // Keep the modal open and let the store error surface.
        setTrustModal((prev) => (prev ? { ...prev, submitting: false } : null));
      }
    },
    [trustModal, setPluginState],
  );

  const handleRemove = useCallback(
    async (name: string) => {
      try {
        await removePlugin(name);
        setRemoveConfirm(null);
      } catch {
        // Error surfaced via the store; keep the confirm open.
      }
    },
    [removePlugin],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-surface border-b border-border flex justify-between items-center px-8 py-4 shrink-0">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
            Plugins
          </h1>
          <p className="text-sm text-muted mt-1">Manage installed plugins and contributions</p>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-6 space-y-6">
          {/* Install section */}
          <div className="border border-border bg-card-bg rounded p-4">
            <h2 className="font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent mb-4">
              Install Plugin
            </h2>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="plugin-source"
                  className="block text-xs font-medium text-muted mb-1"
                >
                  Source
                </label>
                <input
                  id="plugin-source"
                  type="text"
                  value={installForm.source}
                  onChange={(e) => setInstallForm({ ...installForm, source: e.target.value })}
                  placeholder="e.g., git:owner/repo, https://example.com/plugin.tar.gz, /path/to/plugin"
                  className="w-full border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="plugin-name" className="block text-xs font-medium text-muted mb-1">
                  Name (optional)
                </label>
                <input
                  id="plugin-name"
                  type="text"
                  value={installForm.name ?? ''}
                  onChange={(e) => setInstallForm({ ...installForm, name: e.target.value })}
                  placeholder="Auto-detected from manifest if omitted"
                  className="w-full border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
              {installError && (
                <p className="text-sm text-red-400 bg-red-950/20 border border-red-700/30 rounded p-2">
                  {installError}
                </p>
              )}
              {installNote && (
                <p className="text-sm text-yellow-300 bg-yellow-950/20 border border-yellow-700/30 rounded p-2">
                  {installNote}
                </p>
              )}
              <button
                type="button"
                onClick={handleInstall}
                disabled={installLoading || !installForm.source.trim()}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-background hover:bg-accent/90 disabled:bg-accent/50 transition-colors"
              >
                <Download size={14} />
                {installLoading ? 'Installing...' : 'Install'}
              </button>
            </div>
          </div>

          {/* Plugins list */}
          {error && (
            <p className="text-sm text-red-400 bg-red-950/20 border border-red-700/30 rounded p-3">
              Error: {error}
            </p>
          )}

          {loading && !records.length ? (
            <div className="flex items-center justify-center py-12">
              <Loader size={20} className="animate-spin text-muted" />
            </div>
          ) : records.length === 0 ? (
            <div className="text-center py-12 text-muted">
              <p className="text-sm">No plugins installed yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {records.map((plugin) => (
                <div key={plugin.name} className="border border-border bg-card-bg rounded p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-medium text-foreground">
                          {plugin.displayName || plugin.name}
                        </h3>
                        {plugin.version && (
                          <span className="text-xs text-muted">v{plugin.version}</span>
                        )}
                        {/* Status badge */}
                        {plugin.status === 'loaded' && (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-green-500/20 text-green-400 rounded">
                            Loaded
                          </span>
                        )}
                        {plugin.status === 'disabled' && (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-gray-500/20 text-gray-400 rounded">
                            Disabled
                          </span>
                        )}
                        {plugin.status === 'error' && (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-red-500/20 text-red-400 rounded">
                            Error
                          </span>
                        )}
                      </div>

                      {/* Failure message */}
                      {plugin.failure && (
                        <p className="text-xs text-red-400 mb-2">{plugin.failure}</p>
                      )}

                      {/* Contributions */}
                      {(plugin.activated.length > 0 || plugin.noop.length > 0) && (
                        <div className="text-xs text-muted mb-3">
                          <span className="font-medium">Contributions:</span>{' '}
                          {plugin.activated.map((c) => (
                            <span
                              key={c}
                              className="inline-block bg-green-500/20 text-green-400 px-1.5 py-0.5 mr-1 rounded"
                            >
                              {c}
                            </span>
                          ))}
                          {plugin.noop.map((c) => (
                            <span
                              key={c}
                              className="inline-block bg-gray-500/20 text-gray-400 px-1.5 py-0.5 mr-1 rounded line-through"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Controls */}
                    <div className="flex flex-col gap-2 shrink-0">
                      {/* Enable/disable toggle */}
                      <button
                        type="button"
                        onClick={() => handleToggleEnable(plugin)}
                        className="px-3 py-1 text-xs border border-border rounded hover:bg-sidebar-hover transition-colors"
                      >
                        {plugin.enabled ? 'Disable' : 'Enable'}
                      </button>

                      {/* Trust toggle (only shown when enabled) */}
                      {plugin.enabled && (
                        <button
                          type="button"
                          onClick={() => handleToggleTrust(plugin)}
                          className={`px-3 py-1 text-xs rounded transition-colors ${
                            plugin.trusted
                              ? 'bg-red-600/30 text-red-400 border border-red-700/50 hover:bg-red-600/40'
                              : 'border border-border hover:bg-sidebar-hover'
                          }`}
                        >
                          {plugin.trusted ? 'Revoke Trust' : 'Trust'}
                        </button>
                      )}

                      {/* Remove button */}
                      <button
                        type="button"
                        onClick={() => setRemoveConfirm(plugin.name)}
                        className="px-3 py-1 text-xs text-red-400 border border-red-700/50 rounded hover:bg-red-950/20 transition-colors"
                      >
                        <Trash2 size={14} className="inline mr-1" />
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Trust modal */}
      <PluginTrustModal
        open={trustModal !== null}
        plugin={trustModal?.plugin ?? null}
        submitting={trustModal?.submitting ?? false}
        onConfirm={handleConfirmTrust}
        onCancel={() => setTrustModal(null)}
      />

      {/* Remove confirm modal */}
      {removeConfirm && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop */}
          <div className="absolute inset-0 bg-black/50" onClick={() => setRemoveConfirm(null)} />
          <div className="relative z-10 w-full max-w-sm border border-border bg-surface shadow-2xl">
            <div className="border-b border-border px-6 py-4">
              <p className="text-sm font-medium text-foreground">Remove Plugin?</p>
              <p className="text-xs text-muted mt-1">
                {records.find((r) => r.name === removeConfirm)?.displayName || removeConfirm}
              </p>
            </div>
            <div className="px-6 py-4 text-xs text-muted">
              <p>This will delete the plugin directory from your machine.</p>
            </div>
            <div className="border-t border-border px-6 py-4 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setRemoveConfirm(null)}
                className="px-4 py-2 text-sm text-muted hover:text-foreground hover:bg-sidebar-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  handleRemove(removeConfirm);
                }}
                className="px-4 py-2 text-sm bg-red-600 text-white hover:bg-red-700"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
