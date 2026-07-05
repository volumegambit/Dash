import { Loader2, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAgentsStore } from '../../../stores/agents.js';
import { useProjectsStore } from '../../../stores/projects.js';

/**
 * Compact assign-an-agent affordance for kanban cards and issue-table rows.
 * The whole card/row is a click target that opens the task, so every
 * interaction in here stops propagation. Agents load lazily on first open —
 * list pages don't otherwise need the agents store.
 */
export function AssignAgentMenu({ issueId }: { issueId: string }): JSX.Element {
  const agents = useAgentsStore((s) => s.agents);
  const loadAgents = useAgentsStore((s) => s.loadAgents);
  const assignAgent = useProjectsStore((s) => s.assignAgent);
  const [open, setOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const assignable = agents.filter((a) => a.status !== 'disabled');

  const pick = async (agent: { id: string; name: string }) => {
    if (assigning) return;
    setAssigning(true);
    try {
      await assignAgent(issueId, agent);
      setOpen(false);
    } catch {
      // Error surfaced via the projects store; keep the menu open for retry.
    } finally {
      setAssigning(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => {
          if (!open && agents.length === 0) void loadAgents();
          setOpen((v) => !v);
        }}
        title="Assign agent"
        aria-label="Assign agent"
        data-testid={`assign-menu-${issueId}`}
        className="p-1 text-muted transition-colors hover:text-accent"
      >
        {assigning ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 min-w-32 border border-border bg-card-bg py-1 shadow-lg">
          {assignable.length === 0 ? (
            <span className="block px-3 py-1 text-xs text-muted">No agents</span>
          ) : (
            assignable.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => void pick({ id: agent.id, name: agent.name })}
                disabled={assigning}
                className="block w-full truncate px-3 py-1 text-left text-xs text-foreground hover:bg-sidebar-hover hover:text-accent disabled:opacity-50"
              >
                {agent.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
