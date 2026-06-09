import type { IssueSubStatus } from '../../../../../shared/projects-ipc.js';

const OPTIONS: { value: Exclude<IssueSubStatus, null>; label: string }[] = [
  { value: 'waiting_on_human', label: 'Waiting on human' },
  { value: 'agent_working', label: 'Agent working' },
  { value: 'blocked', label: 'Blocked' },
];

export function SubStatusPicker({
  open,
  onPick,
  onCancel,
}: {
  open: boolean;
  onPick: (sub: Exclude<IssueSubStatus, null>) => void;
  onCancel: () => void;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click to close */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-sm border border-border bg-surface p-6 shadow-2xl">
        <p className="mb-4 font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
          Set sub-status
        </p>
        <div className="flex flex-col gap-2">
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onPick(opt.value)}
              className="border border-border px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-sidebar-hover"
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
