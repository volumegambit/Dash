import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Inbox } from 'lucide-react';
import { useEffect } from 'react';
import { useProjectsStore } from '../../stores/projects.js';
import { StatusPill, SubStatusPill } from './-components/StatusPill.js';
import { groupInbox } from './-lib/inbox.js';

function InboxView(): JSX.Element {
  const navigate = useNavigate();
  const inbox = useProjectsStore((s) => s.inbox);
  const loading = useProjectsStore((s) => s.loading);
  const loadInbox = useProjectsStore((s) => s.loadInbox);
  const markInboxRead = useProjectsStore((s) => s.markInboxRead);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  const { waitingOnYou, newActivity } = groupInbox(inbox);

  const open = (issueId: string) => {
    markInboxRead(issueId);
    navigate({ to: '/projects/issues/$issueId', params: { issueId } });
  };

  const section = (title: string, items: typeof inbox) =>
    items.length > 0 && (
      <div className="mb-6">
        <h2 className="mb-2 font-[family-name:var(--font-mono)] text-[10px] font-semibold uppercase tracking-[2px] text-accent">
          {title}
        </h2>
        <div className="border border-border">
          {items.map((it) => (
            <button
              key={it.issue.id}
              type="button"
              onClick={() => open(it.issue.id)}
              className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-sidebar-hover"
            >
              <StatusPill status={it.issue.status} />
              <span className="font-[family-name:var(--font-mono)] text-xs text-muted">
                {it.issue.key}
              </span>
              <span className="flex-1 text-sm text-foreground">{it.issue.title}</span>
              {it.project && <span className="text-xs text-muted">{it.project.name}</span>}
              <SubStatusPill subStatus={it.issue.sub_status} />
            </button>
          ))}
        </div>
      </div>
    );

  return (
    <div className="h-full overflow-auto px-8 py-6">
      {!loading && inbox.length === 0 ? (
        <div className="border border-dashed border-border p-8 text-center text-muted">
          <Inbox size={32} className="mx-auto mb-2 opacity-50" />
          <p>Inbox zero. Nothing needs you right now.</p>
        </div>
      ) : (
        <>
          {section('Waiting on you', waitingOnYou)}
          {section('New activity', newActivity)}
        </>
      )}
    </div>
  );
}

export const Route = createFileRoute('/projects/inbox')({
  component: InboxView,
});
