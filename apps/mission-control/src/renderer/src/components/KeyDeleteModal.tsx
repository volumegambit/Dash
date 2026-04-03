import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';

interface KeyDeleteModalProps {
  provider: string;
  keyName: string;
  affectedAgents: { deploymentId: string; name: string }[];
  availableKeys: string[];
  onConfirm: (assignments: { deploymentId: string; newKeyName: string | null }[]) => void;
  onClose: () => void;
}

export function KeyDeleteModal({
  provider,
  keyName,
  affectedAgents,
  availableKeys,
  onConfirm,
  onClose,
}: KeyDeleteModalProps): JSX.Element {
  const [assignIndividually, setAssignIndividually] = useState(false);
  const [globalKey, setGlobalKey] = useState<string | null>(
    availableKeys.length > 0 ? availableKeys[0] : null,
  );
  const [perAgentKeys, setPerAgentKeys] = useState<Record<string, string | null>>(
    Object.fromEntries(
      affectedAgents.map((a) => [
        a.deploymentId,
        availableKeys.length > 0 ? availableKeys[0] : null,
      ]),
    ),
  );

  const hasReplacement = assignIndividually
    ? Object.values(perAgentKeys).some((k) => k !== null)
    : globalKey !== null;

  const handleConfirm = (): void => {
    if (assignIndividually) {
      onConfirm(
        affectedAgents.map((a) => ({
          deploymentId: a.deploymentId,
          newKeyName: perAgentKeys[a.deploymentId] ?? null,
        })),
      );
    } else {
      onConfirm(
        affectedAgents.map((a) => ({
          deploymentId: a.deploymentId,
          newKeyName: globalKey,
        })),
      );
    }
  };

  const noKeysAvailable = availableKeys.length === 0;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: custom modal uses div for flexible Tailwind styling */}
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-lg bg-background border border-border p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={20} className="text-yellow" />
            <h2 className="text-lg font-semibold text-foreground">Remove API Key</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {noKeysAvailable ? (
          <p className="mb-4 text-sm text-yellow-200">
            This is the only <span className="font-medium">{provider}</span> key. Removing it will
            prevent these agents from making API calls.
          </p>
        ) : (
          <p className="mb-4 text-sm text-muted">
            The key <span className="font-medium text-foreground">"{keyName}"</span> is used by the
            following agents. Choose a replacement key or these agents will lose access to{' '}
            <span className="font-medium text-foreground">{provider}</span>.
          </p>
        )}

        {/* Global replacement dropdown */}
        {!assignIndividually && !noKeysAvailable && (
          <div className="mb-4">
            <label className="mb-1.5 block text-xs text-muted" htmlFor="global-key-select">
              Reassign all agents to
            </label>
            <select
              id="global-key-select"
              value={globalKey ?? ''}
              onChange={(e) => setGlobalKey(e.target.value || null)}
              className="w-full rounded-lg border border-border bg-card-bg px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
            >
              {availableKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
              <option value="">(none)</option>
            </select>
          </div>
        )}

        {/* Agent list */}
        <div className="mb-4 max-h-48 overflow-y-auto rounded border border-border">
          {affectedAgents.map((agent) => (
            <div
              key={agent.deploymentId}
              className="flex items-center justify-between border-b border-border px-3 py-2 last:border-b-0"
            >
              <span className="text-sm text-foreground">{agent.name}</span>
              {assignIndividually && !noKeysAvailable && (
                <select
                  value={perAgentKeys[agent.deploymentId] ?? ''}
                  onChange={(e) =>
                    setPerAgentKeys((prev) => ({
                      ...prev,
                      [agent.deploymentId]: e.target.value || null,
                    }))
                  }
                  className="rounded border border-border bg-card-bg px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none"
                >
                  {availableKeys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                  <option value="">(none)</option>
                </select>
              )}
            </div>
          ))}
        </div>

        {/* Individual assignment toggle */}
        {!noKeysAvailable && (
          <button
            type="button"
            onClick={() => setAssignIndividually(!assignIndividually)}
            className="mb-4 text-xs text-accent hover:underline"
          >
            {assignIndividually ? 'Assign all at once' : 'Assign individually'}
          </button>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="flex-1 rounded-lg bg-red-900/50 px-4 py-2 text-sm text-red-200 transition-colors hover:bg-red-900/70"
          >
            {hasReplacement ? 'Remove & Reassign' : 'Remove Anyway'}
          </button>
        </div>
      </div>
    </div>
  );
}
