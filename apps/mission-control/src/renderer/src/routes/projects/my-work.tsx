import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { useProjectsStore } from '../../stores/projects.js';
import { IssueRow } from './-components/IssueRow.js';

const LOCAL_USER = 'me';

function MyWork(): JSX.Element {
  const navigate = useNavigate();
  const issuesById = useProjectsStore((s) => s.issuesById);
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadIssues = useProjectsStore((s) => s.loadIssues);
  const loadProjects = useProjectsStore((s) => s.loadProjects);

  useEffect(() => {
    loadProjects();
    loadIssues({ assignee_user_id: LOCAL_USER });
  }, [loadIssues, loadProjects]);

  const rows = useMemo(
    () =>
      Object.values(issuesById)
        .filter((i) => i.assignee_user_id === LOCAL_USER)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [issuesById],
  );

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Project</th>
            <th className="px-3 py-2 font-medium">Sub-status</th>
            <th className="px-3 py-2 font-medium">Assignee</th>
            <th className="px-3 py-2 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              project={issue.project_id ? projectsById[issue.project_id] : null}
              onOpen={(id) =>
                navigate({ to: '/projects/issues/$issueId', params: { issueId: id } })
              }
            />
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="mt-8 text-center text-sm text-muted">No tasks assigned to you.</p>
      )}
    </div>
  );
}

export const Route = createFileRoute('/projects/my-work')({
  component: MyWork,
});
