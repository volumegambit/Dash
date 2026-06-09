import { Outlet, createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useProjectsStore } from '../stores/projects.js';
import { ProjectsSubnav } from './projects/-components/ProjectsSubnav.js';

function ProjectsLayout(): JSX.Element {
  const subscribe = useProjectsStore((s) => s.subscribe);
  const loadInbox = useProjectsStore((s) => s.loadInbox);

  useEffect(() => {
    const unsub = subscribe();
    loadInbox();
    return unsub;
  }, [subscribe, loadInbox]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="bg-surface px-8 pt-4">
        <span className="font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[3px] text-accent">
          Manage Work
        </span>
        <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
          Projects
        </h1>
      </div>
      <ProjectsSubnav />
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

export const Route = createFileRoute('/projects')({
  component: ProjectsLayout,
});
