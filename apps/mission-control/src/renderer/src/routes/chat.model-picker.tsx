/**
 * Inline model picker for the chat strip header.
 *
 * Click the current model label → a dark popover opens with every available
 * model grouped by provider. Clicking a model *commits immediately* — no
 * Save button. The parent component persists via `updateAgent(id, { model })`
 * and receives an updated `activeModel` on the next render.
 *
 * Design notes:
 * - A custom popover (not a native `<select>`) so it matches the chat
 *   aesthetic and lets us handle the "click the currently-selected item to
 *   re-commit" edge case cleanly (native selects swallow that click).
 * - Outside-click + Escape close the menu. `disabled` prop short-circuits
 *   opening altogether — useful during in-flight streaming if callers want
 *   to freeze the picker.
 * - The trigger uses the model's human label (`ModelOption.label`) rather
 *   than its raw id, falling back to the id if the list hasn't loaded yet.
 */

import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelOption } from '../components/deploy-options.js';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/** Group models by provider while preserving the incoming order per group. */
export function groupModelsByProvider(models: ModelOption[]): Array<[string, ModelOption[]]> {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const list = groups.get(m.provider) ?? [];
    list.push(m);
    groups.set(m.provider, list);
  }
  return [...groups.entries()];
}

export interface ChatModelPickerProps {
  value: string;
  models: ModelOption[];
  onChange: (model: string) => void | Promise<void>;
  disabled?: boolean;
}

export function ChatModelPicker({
  value,
  models,
  onChange,
  disabled,
}: ChatModelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const current = models.find((m) => m.value === value);
  const label = current?.label ?? value ?? 'model';

  // Close on outside click. Scoped to the container so clicks on trigger
  // and menu items don't trip the handler.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (!containerRef.current) return;
      if (e.target instanceof Node && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const handleSelect = useCallback(
    async (selected: string): Promise<void> => {
      // Close immediately — optimistic UX. Pending is tracked separately so
      // the check mark can show a spinner if the caller returns a promise.
      setOpen(false);
      if (selected === value) return;
      setPending(selected);
      try {
        await onChange(selected);
      } finally {
        setPending(null);
      }
    },
    [onChange, value],
  );

  const groups = groupModelsByProvider(models);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        data-testid="chat-model-picker-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled || models.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-50"
        title={pending ? `Switching to ${pending}…` : 'Change model'}
      >
        <span>{label}</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div
          role="listbox"
          data-testid="chat-model-picker-menu"
          className="absolute left-0 top-full z-30 mt-1 max-h-[60vh] min-w-[220px] overflow-y-auto border border-border bg-[#141414] py-1 shadow-xl"
        >
          {groups.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">No models available</div>
          ) : (
            groups.map(([provider, providerModels]) => (
              <div key={provider} className="py-1">
                <div className="px-3 pb-0.5 pt-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-muted">
                  {PROVIDER_LABELS[provider] ?? provider}
                </div>
                {providerModels.map((m) => {
                  const isSelected = m.value === value;
                  const isPending = pending === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-testid={`chat-model-picker-option-${m.value}`}
                      onClick={() => handleSelect(m.value)}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors hover:bg-sidebar-hover ${
                        isSelected ? 'text-accent' : 'text-foreground'
                      }`}
                    >
                      <span className="truncate">{m.label}</span>
                      {(isSelected || isPending) && <Check size={12} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
