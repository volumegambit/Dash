import { X } from 'lucide-react';
import type { ModelOption } from './deploy-options.js';

interface ModelChainEditorProps {
  model: string;
  fallbackModels: string[];
  availableModels: ModelOption[];
  onChange: (model: string, fallbackModels: string[]) => void;
}

export function ModelChainEditor({
  model,
  fallbackModels,
  availableModels,
  onChange,
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
        <label className="mb-1 block text-xs font-medium text-muted">Primary model</label>
        <select
          aria-label="Primary model"
          value={model}
          onChange={(e) => handlePrimaryChange(e.target.value)}
          className="w-full rounded-lg border border-border bg-sidebar-bg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
        >
          {availableModels.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {fallbackModels.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">Fallback models (in order)</p>
          {fallbackModels.map((fb, i) => {
            const optionsForRow = availableModels.filter(
              (m) =>
                m.value === fb || !usedModels.has(m.value) || fallbackModels.indexOf(m.value) === i,
            );
            return (
              <div key={`${fb}-${i}`} className="flex items-center gap-2">
                <span className="text-xs text-muted w-4">{i + 1}.</span>
                <select
                  value={fb}
                  onChange={(e) => handleFallbackChange(i, e.target.value)}
                  className="flex-1 rounded-lg border border-border bg-sidebar-bg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
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
                  className="rounded p-1 text-muted hover:text-foreground"
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
          className="text-xs text-primary hover:underline"
        >
          + Add fallback
        </button>
      )}
    </div>
  );
}
