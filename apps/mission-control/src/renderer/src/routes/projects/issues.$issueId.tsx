import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IssueComment, IssueEvent, IssueStatus } from '../../../../shared/projects-ipc.js';
import { Markdown } from '../../components/Markdown.js';
import { useProjectsStore } from '../../stores/projects.js';
import { isAgentRunEvent, mergeTimeline } from './-lib/timeline.js';

const STATUS_OPTIONS: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
];

function eventSummary(event: IssueEvent): string {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(event.data);
  } catch {
    // ignore
  }
  switch (event.type) {
    case 'status_change':
      return `Status: ${String(data.from ?? '?')} → ${String(data.to ?? '?')}`;
    case 'sub_status_change':
      return `Sub-status → ${String(data.to ?? '?')}`;
    case 'assignee_change':
      return `Assignee → ${String(data.to ?? '?')}`;
    case 'agent_run_started':
      return 'Agent run started';
    case 'agent_run_completed':
      return `Agent ran: ${String(data.tool_calls ?? '?')} tool calls`;
    case 'session_linked':
      return `Linked session ${String(data.session_id ?? '')}`;
    case 'subtask_added':
      return `Created subtask ${String(data.key ?? '')}`;
    default:
      return event.type;
  }
}

function CommentRow({
  comment,
  onDelete,
}: {
  comment: IssueComment;
  onDelete: (id: string) => void;
}): JSX.Element {
  if (comment.deleted_at) {
    return (
      <div className="py-2 text-xs italic text-muted">Comment deleted by {comment.author_id}</div>
    );
  }
  const isHuman = comment.author_type === 'human';
  return (
    <div
      className={`my-2 border-l-2 p-3 ${
        isHuman ? 'border-accent bg-card-bg' : 'border-border bg-surface/40'
      }`}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">
          {isHuman ? '' : '🤖 '}
          {comment.author_id}
        </span>
        {isHuman && (
          <button
            type="button"
            onClick={() => onDelete(comment.id)}
            className="text-[10px] text-muted hover:text-red"
          >
            Delete
          </button>
        )}
      </div>
      <div className="text-sm text-foreground">
        <Markdown>{comment.body}</Markdown>
      </div>
    </div>
  );
}

function AgentRunRow({ event }: { event: IssueEvent }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(event.data);
  } catch {
    // ignore
  }
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}🤖 {eventSummary(event)}
      </button>
      {expanded && (
        <pre className="ml-4 mt-1 overflow-x-auto bg-[#161b22] p-2 text-[10px] text-muted">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between text-xs">
      <span className="text-muted">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function TaskDetail(): JSX.Element {
  const { issueId } = Route.useParams();
  const navigate = useNavigate();
  const detail = useProjectsStore((s) => s.detailById[issueId]);
  const projectsById = useProjectsStore((s) => s.projectsById);
  const loadIssueDetail = useProjectsStore((s) => s.loadIssueDetail);
  const loadProjects = useProjectsStore((s) => s.loadProjects);
  const patchIssue = useProjectsStore((s) => s.patchIssue);
  const addComment = useProjectsStore((s) => s.addComment);
  const deleteComment = useProjectsStore((s) => s.deleteComment);
  const createIssue = useProjectsStore((s) => s.createIssue);

  const [draft, setDraft] = useState('');
  const [subtaskTitle, setSubtaskTitle] = useState('');

  useEffect(() => {
    loadProjects();
    loadIssueDetail(issueId);
  }, [loadIssueDetail, loadProjects, issueId]);

  if (!detail) {
    return <div className="p-8 text-muted">Loading task…</div>;
  }

  const project = detail.project_id ? projectsById[detail.project_id] : null;
  const timeline = mergeTimeline(detail.events, detail.comments);

  const submitComment = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    await addComment(issueId, body);
  };

  const submitSubtask = async () => {
    const title = subtaskTitle.trim();
    if (!title) return;
    setSubtaskTitle('');
    await createIssue({ title, parent_issue_id: issueId, project_id: detail.project_id });
    await loadIssueDetail(issueId);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 px-8 py-3">
        <ArrowLeft
          size={18}
          className="cursor-pointer text-muted hover:text-foreground"
          onClick={() => navigate({ to: '/projects/all' })}
        />
        <span className="font-[family-name:var(--font-mono)] text-xs text-muted">
          {project ? `${project.key} › ` : ''}
          {detail.key}
        </span>
        <h2 className="flex-1 text-lg font-semibold text-foreground">{detail.title}</h2>
        <select
          value={detail.status}
          onChange={(e) =>
            patchIssue(issueId, {
              status: e.target.value as IssueStatus,
              sub_status: e.target.value === 'in_progress' ? detail.sub_status : null,
            })
          }
          className="border border-border bg-card-bg px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left pane */}
        <div className="flex min-w-0 flex-1 flex-col overflow-auto border-r border-border px-8 py-4">
          {detail.description && (
            <div className="mb-4 text-sm text-foreground">
              <Markdown>{detail.description}</Markdown>
            </div>
          )}

          <p className="mb-2 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
            Timeline
          </p>
          <div className="flex-1">
            {timeline.map((item) =>
              item.kind === 'comment' ? (
                <CommentRow
                  key={item.comment.id}
                  comment={item.comment}
                  onDelete={(id) => deleteComment(issueId, id)}
                />
              ) : isAgentRunEvent(item.event) ? (
                <AgentRunRow key={item.event.id} event={item.event} />
              ) : (
                <div key={item.event.id} className="py-1 text-xs text-muted">
                  {eventSummary(item.event)}
                </div>
              ),
            )}
          </div>

          {/* Composer */}
          <div className="mt-4">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a comment…"
              rows={3}
              className="w-full border border-border bg-background p-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                onClick={submitComment}
                disabled={!draft.trim()}
                className="bg-accent px-3 py-1 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                Comment
              </button>
            </div>
          </div>
        </div>

        {/* Right pane */}
        <div className="w-72 shrink-0 overflow-auto px-5 py-4">
          <Field label="Assignee" value={detail.assignee_user_id} />
          <Field label="Sub-status" value={detail.sub_status ?? '—'} />
          <Field label="Project" value={project?.key ?? '—'} />
          <Field label="Parent" value={detail.parent_issue_id ?? '—'} />
          <Field
            label="Created by"
            value={
              detail.created_by === 'agent'
                ? `🤖 ${detail.created_by_agent_id ?? 'agent'}`
                : 'human'
            }
          />

          <p className="mb-1 mt-4 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
            Linked sessions ({detail.linked_sessions.length})
          </p>
          {/* Display-only in v1: MC's chat route deep-links by agentId,
              not by session id, so these chips are not navigable yet. */}
          {detail.linked_sessions.map((link) => (
            <span
              key={link.session_id}
              className="mb-1 block w-full truncate bg-sidebar-hover px-2 py-1 text-left text-xs text-muted"
              title="Open-in-chat coming soon"
            >
              {link.session_id}
            </span>
          ))}

          {/* Subtasks — hidden when this issue itself has a parent (one-level depth). */}
          {!detail.parent_issue_id && (
            <>
              <p className="mb-1 mt-4 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
                Subtasks ({detail.subtasks.length})
              </p>
              {detail.subtasks.map((st) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() =>
                    navigate({ to: '/projects/issues/$issueId', params: { issueId: st.id } })
                  }
                  className="mb-1 block w-full truncate text-left text-xs text-foreground hover:text-accent"
                >
                  <span className="font-[family-name:var(--font-mono)] text-muted">{st.key}</span>{' '}
                  {st.title}
                </button>
              ))}
              <div className="mt-1 flex gap-1">
                <input
                  type="text"
                  value={subtaskTitle}
                  onChange={(e) => setSubtaskTitle(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitSubtask()}
                  placeholder="+ Subtask"
                  className="flex-1 border border-border bg-card-bg px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/projects/issues/$issueId')({
  component: TaskDetail,
});
