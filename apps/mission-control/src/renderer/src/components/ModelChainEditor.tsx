import { Loader, RefreshCw, X } from 'lucide-react';
import type { ModelOption } from './deploy-options.js';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

function GroupedModelSelect({
  id,
  ariaLabel,
  value,
  models,
  onChange,
  className,
}: {
  id?: string;
  ariaLabel?: string;
  value: string;
  models: ModelOption[];
  onChange: (value: string) => void;
  className?: string;
}): JSX.Element {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const list = groups.get(m.provider) ?? [];
    list.push(m);
    groups.set(m.provider, list);
  }

  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      {[...groups.entries()].map(([provider, providerModels]) => (
        <optgroup key={provider} label={PROVIDER_LABELS[provider] ?? provider}>
          {providerModels.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

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
          <GroupedModelSelect
            id="primary-model"
            ariaLabel="Primary model"
            value={model}
            models={availableModels}
            onChange={handlePrimaryChange}
            className="flex-1 border border-border bg-card-bg px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
          />
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
                <GroupedModelSelect
                  value={fb}
                  models={optionsForRow}
                  onChange={(v) => handleFallbackChange(i, v)}
                  className="flex-1 border border-border bg-card-bg px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
                />
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
