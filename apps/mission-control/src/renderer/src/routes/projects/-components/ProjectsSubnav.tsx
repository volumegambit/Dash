import { Link } from '@tanstack/react-router';
import { useProjectsStore } from '../../../stores/projects.js';

const TABS: { to: string; label: string }[] = [
  { to: '/projects/inbox', label: 'Inbox' },
  { to: '/projects/my-work', label: 'My work' },
  { to: '/projects/all', label: 'All tasks' },
  { to: '/projects/kanban', label: 'Kanban' },
  { to: '/projects/list', label: 'Projects' },
];

export function ProjectsSubnav(): JSX.Element {
  const inboxCount = useProjectsStore((s) => s.inbox.length);
  return (
    <div className="flex shrink-0 border-b border-border bg-surface px-8">
      {TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className="px-5 py-3.5 text-[13px] font-medium text-muted transition-colors hover:text-foreground [&.active]:border-b-2 [&.active]:border-accent [&.active]:font-semibold [&.active]:text-foreground"
        >
          {tab.label}
          {tab.to === '/projects/inbox' && inboxCount > 0 && (
            <span className="ml-1.5 bg-accent px-1.5 py-0.5 text-[10px] text-white">
              {inboxCount}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
