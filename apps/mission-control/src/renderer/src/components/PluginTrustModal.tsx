import type { PluginRecord } from '@dash/management';
import { AlertCircle, X } from 'lucide-react';

/** Component kinds that ship executable code (vs. data-only kinds like skills/agents). */
const CODE_KINDS = ['bin', 'hooks', 'mcp', 'providers'];

interface PluginTrustModalProps {
  open: boolean;
  plugin: PluginRecord | null;
  onConfirm(name: string): Promise<void>;
  onCancel(): void;
  submitting?: boolean;
}

export function PluginTrustModal({
  open,
  plugin,
  onConfirm,
  onCancel,
  submitting = false,
}: PluginTrustModalProps): JSX.Element | null {
  if (!open || !plugin) return null;

  // The trust modal is shown for an enabled-but-UNTRUSTED plugin, whose code
  // components are withheld in `noop` pending trust (not yet in `activated`).
  // Compute from the union so we surface the code that WILL run once trusted.
  const codeComponents = [...new Set([...plugin.activated, ...plugin.noop])].filter((c) =>
    CODE_KINDS.includes(c),
  );

  const handleConfirm = async (): Promise<void> => {
    await onConfirm(plugin.name);
  };

  const trustDisabled = !plugin.enabled;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-md border border-border bg-surface shadow-2xl">
        <div className="border-b border-border px-6 py-4 flex items-start justify-between">
          <div>
            <p className="font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
              Trust Plugin
            </p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {plugin.displayName || plugin.name}
            </p>
            {plugin.version && <p className="text-xs text-muted">v{plugin.version}</p>}
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-6 py-4">
          {/* High-contrast warning */}
          <div className="flex gap-3 rounded bg-red-950/30 border border-red-700/50 p-3">
            <AlertCircle size={20} className="flex-shrink-0 text-red-500 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-red-400">This code will run on your machine.</p>
              <p className="text-red-300 text-xs mt-1">
                Only trust plugins from sources you fully understand and trust.
              </p>
            </div>
          </div>

          {/* Code components list */}
          {codeComponents.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted mb-2">This plugin will activate:</p>
              <ul className="space-y-1">
                {codeComponents.map((comp) => (
                  <li key={comp} className="text-sm text-foreground flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                    <code className="font-[family-name:var(--font-mono)] text-xs bg-card-bg px-1.5 py-0.5">
                      {comp}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {codeComponents.length === 0 && (
            <p className="text-xs text-muted italic">No code components to activate.</p>
          )}
        </div>

        <div className="border-t border-border px-6 py-4 flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-4 py-2 text-sm text-muted hover:text-foreground hover:bg-sidebar-hover transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || trustDisabled}
            title={trustDisabled ? 'Enable the plugin first' : undefined}
            className="px-4 py-2 text-sm bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Trusting...' : 'Trust Plugin'}
          </button>
        </div>
      </div>
    </div>
  );
}
