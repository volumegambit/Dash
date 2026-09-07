/**
 * Inline workspace (working directory) picker for the chat strip header.
 *
 * Click the current workspace label → a dark popover opens with actions:
 * - **Change directory…** opens a native folder picker and commits the choice.
 * - **Open in Finder** reveals the current directory in the OS file browser.
 * - **Reset to auto-generated** clears the override (only shown when a custom
 *   directory is set).
 *
 * The parent persists via `onChange(dir)` — passing `''` resets to the
 * gateway's auto-generated per-agent workspace. When no workspace is set the
 * trigger reads "Set directory…" so the affordance is discoverable even before
 * a first message.
 *
 * Design notes mirror {@link ChatModelPicker}: custom popover (not native),
 * outside-click + Escape close, `disabled` short-circuits opening.
 */

import { ChevronDown, FolderOpen, FolderPlus, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ChatWorkspacePickerProps {
  /** Current workspace path, or undefined when auto-generated. */
  value: string | undefined;
  /** Persist a new directory. Pass `''` to reset to auto-generated. */
  onChange: (dir: string) => void | Promise<void>;
  /** Open a native folder picker; resolves to the chosen path or null. */
  onBrowse: () => Promise<string | null>;
  /** Reveal the current directory in the OS file browser. */
  onOpen: (dir: string) => void | Promise<void>;
  disabled?: boolean;
}

export function ChatWorkspacePicker({
  value,
  onChange,
  onBrowse,
  onOpen,
  disabled,
}: ChatWorkspacePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasWorkspace = Boolean(value);
  const label = value ?? 'Set directory…';

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

  const handleBrowse = useCallback(async (): Promise<void> => {
    setOpen(false);
    setPending(true);
    try {
      const selected = await onBrowse();
      if (selected) await onChange(selected);
    } finally {
      setPending(false);
    }
  }, [onBrowse, onChange]);

  const handleReset = useCallback(async (): Promise<void> => {
    setOpen(false);
    setPending(true);
    try {
      await onChange('');
    } finally {
      setPending(false);
    }
  }, [onChange]);

  const handleOpen = useCallback(async (): Promise<void> => {
    setOpen(false);
    if (value) await onOpen(value);
  }, [onOpen, value]);

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        data-testid="chat-workspace-picker-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-50"
        title={hasWorkspace ? `Working Directory: ${value}` : 'Set working directory'}
      >
        <FolderOpen size={12} className="shrink-0" />
        <span className="max-w-[260px] truncate">{label}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          data-testid="chat-workspace-picker-menu"
          className="absolute left-0 top-full z-30 mt-1 min-w-[200px] border border-border bg-[#141414] py-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            data-testid="chat-workspace-picker-browse"
            onClick={handleBrowse}
            disabled={pending}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-sidebar-hover disabled:opacity-50"
          >
            <FolderPlus size={12} className="shrink-0" />
            <span>Change directory…</span>
          </button>
          {hasWorkspace && (
            <button
              type="button"
              role="menuitem"
              data-testid="chat-workspace-picker-open"
              onClick={handleOpen}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-sidebar-hover"
            >
              <FolderOpen size={12} className="shrink-0" />
              <span>Open in Finder</span>
            </button>
          )}
          {hasWorkspace && (
            <button
              type="button"
              role="menuitem"
              data-testid="chat-workspace-picker-reset"
              onClick={handleReset}
              disabled={pending}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted transition-colors hover:bg-sidebar-hover hover:text-foreground disabled:opacity-50"
            >
              <RotateCcw size={12} className="shrink-0" />
              <span>Reset to auto-generated</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
