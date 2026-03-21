import { Loader, RefreshCw, X } from 'lucide-react';
import type { ModelOption } from './deploy-options.js';

interface ModelChainEditorProps {
  model: string;
  fallbackModels: string[];
  availableModels: ModelOption[];
  onChange: (model: string, fallbackModels: string[]) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function ModelChainEditor({
  model,
  fallbackModels,
  availableModels,
  onChange,
  onRefresh,
  refreshing,
}: ModelChainEditorProps): JSX.Element {
  if (availableModels.length === 0) {
    return (
      <p className="text-sm text-muted">
        No models available. Add API keys in Settings to get started.
      </p>
    );
  }

  const usedModels = new Set([model, ...fallbackModels]);

  const handlePrimaryChange = (value: string): void => {
    onChange(value, fallbackModels);
  };

  const handleFallbackChange = (index: number, value: string): void => {
    const updated = [...fallbackModels];
    updated[index] = value;
    onChange(model, updated);
  };

  const handleRemoveFallback = (index: number): void => {
    onChange(
      model,
      fallbackModels.filter((_, i) => i !== index),
    );
  };

  const handleAddFallback = (): void => {
    const next = availableModels.find((m) => !usedModels.has(m.value));
    if (next) onChange(model, [...fallbackModels, next.value]);
  };

  const canAddFallback = availableModels.some((m) => !usedModels.has(m.value));

  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="primary-model"
          className="mb-1 block font-[family-name:var(--font-mono)] text-xs text-muted"
        >
          Primary model
        </label>
        <div className="flex items-center gap-2">
          <select
            id="primary-model"
            aria-label="Primary model"
            value={model}
            onChange={(e) => handlePrimaryChange(e.target.value)}
            className="flex-1 rounded-lg border border-border bg-card-bg px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
          >
            {availableModels.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          {onRefresh && (
            <button
              type="button"
              aria-label="Refresh models"
              onClick={onRefresh}
              disabled={refreshing}
              className="shrink-0 rounded-lg border border-border p-2 text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:opacity-50"
              title="Refresh model list"
            >
              {refreshing ? <Loader size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            </button>
          )}
        </div>
      </div>

      {fallbackModels.length > 0 && (
        <div className="space-y-2">
          <p className="font-[family-name:var(--font-mono)] text-xs text-muted">
            Fallback models (in order)
          </p>
          {fallbackModels.map((fb, i) => {
            const optionsForRow = availableModels.filter(
              (m) =>
                m.value === fb || !usedModels.has(m.value) || fallbackModels.indexOf(m.value) === i,
            );
            return (
              <div key={fb} className="flex items-center gap-2">
                <span className="font-[family-name:var(--font-mono)] text-xs text-muted w-4">
                  {i + 1}.
                </span>
                <select
                  value={fb}
                  onChange={(e) => handleFallbackChange(i, e.target.value)}
                  className="flex-1 rounded-lg border border-border bg-card-bg px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                >
                  {optionsForRow.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="Remove fallback"
                  onClick={() => handleRemoveFallback(i)}
                  className="rounded p-1 text-red hover:text-red/80"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {canAddFallback && (
        <button
          type="button"
          onClick={handleAddFallback}
          className="text-xs text-accent hover:text-accent/80"
        >
          + Add fallback
        </button>
      )}
    </div>
  );
}
