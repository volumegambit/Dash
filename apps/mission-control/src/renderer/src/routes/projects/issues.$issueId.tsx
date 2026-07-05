import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, ChevronRight, ExternalLink, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { IssueComment, IssueEvent, IssueStatus } from '../../../../shared/projects-ipc.js';
import { Markdown } from '../../components/Markdown.js';
import { useAgentsStore } from '../../stores/agents.js';
import { useChatStore } from '../../stores/chat.js';
import { useProjectsStore } from '../../stores/projects.js';
import { SessionPanel } from './-components/SessionPanel.js';
import { SubStatusPill } from './-components/StatusPill.js';
import { relativeTime } from './-lib/format.js';
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
        <span className="flex items-center gap-2">
          <span className="text-[10px] text-muted opacity-60">
            {relativeTime(comment.created_at)}
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
        </span>
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

export function TaskDetail(): JSX.Element {
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
  const deleteIssue = useProjectsStore((s) => s.deleteIssue);
  const assignAgent = useProjectsStore((s) => s.assignAgent);
  const agents = useAgentsStore((s) => s.agents);
  const loadAgents = useAgentsStore((s) => s.loadAgents);
  const conversations = useChatStore((s) => s.conversations);
  const loadConversations = useChatStore((s) => s.loadConversations);
  const chatSending = useChatStore((s) => s.sending);
  const sendChatMessage = useChatStore((s) => s.sendMessage);

  const [draft, setDraft] = useState('');
  const [subtaskTitle, setSubtaskTitle] = useState('');
  const [savingSubtask, setSavingSubtask] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [assignAgentId, setAssignAgentId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // 'task' or an MC session id — which tab fills the main column.
  const [activeTab, setActiveTab] = useState<'task' | string>('task');

  useEffect(() => {
    loadProjects();
    loadIssueDetail(issueId);
    // Agents feed the assign picker; conversations decide which linked-session
    // tabs can show in the main column.
    loadAgents();
    loadConversations();
    // A session picked on one task must not leak onto the next.
    setSelectedSessionId(null);
    setActiveTab('task');
  }, [loadIssueDetail, loadProjects, loadAgents, loadConversations, issueId]);

  if (!detail) {
    return <div className="p-8 text-muted">Loading task…</div>;
  }

  const project = detail.project_id ? projectsById[detail.project_id] : null;
  // Hide comment_* bookkeeping events — the comments themselves are already
  // interleaved in the timeline (deleted ones as placeholders).
  const timeline = mergeTimeline(detail.events, detail.comments).filter(
    (item) => item.kind !== 'event' || !item.event.type.startsWith('comment_'),
  );

  // Sessions that exist as MC chat conversations can render in the embedded
  // panel; the most recently referenced one is shown until a chip is picked.
  const mcSessions = detail.linked_sessions.filter((l) =>
    conversations.some((c) => c.id === l.session_id),
  );
  const latestMcSession = mcSessions.reduce<(typeof mcSessions)[number] | null>(
    (best, l) => (!best || l.last_referenced_at > best.last_referenced_at ? l : best),
    null,
  );
  const activeSessionId =
    selectedSessionId && mcSessions.some((l) => l.session_id === selectedSessionId)
      ? selectedSessionId
      : (latestMcSession?.session_id ?? null);

  // Tabs are newest-first; duplicate agent labels get a short id suffix.
  const orderedMcSessions = [...mcSessions].sort((a, b) =>
    b.last_referenced_at.localeCompare(a.last_referenced_at),
  );
  const agentLabelCounts = new Map<string, number>();
  for (const l of orderedMcSessions) {
    const key = l.agent_id ?? 'Agent';
    agentLabelCounts.set(key, (agentLabelCounts.get(key) ?? 0) + 1);
  }
  const sessionTabLabel = (l: (typeof orderedMcSessions)[number]): string => {
    const name = l.agent_id ?? 'Agent';
    return (agentLabelCounts.get(name) ?? 0) > 1
      ? `🤖 ${name} · ${l.session_id.slice(0, 4)}`
      : `🤖 ${name}`;
  };
  // A selected session tab whose conversation vanished falls back to Task.
  const activeSessionTab =
    activeTab !== 'task' && mcSessions.some((l) => l.session_id === activeTab) ? activeTab : null;

  // session_linked events carry a raw session id; show the agent behind it.
  const sessionLinkedLabel = (event: IssueEvent): string => {
    let sessionId = '';
    try {
      sessionId = String((JSON.parse(event.data) as { session_id?: string }).session_id ?? '');
    } catch {
      // ignore
    }
    const agent = detail.linked_sessions.find((l) => l.session_id === sessionId)?.agent_id;
    return `🤖 ${agent ?? 'Agent'} session linked`;
  };

  const activeSessionBusy = activeSessionId ? (chatSending[activeSessionId] ?? false) : false;

  const submitComment = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    await addComment(issueId, body);
    // Feed the comment into the session shown in the pane so the agent reacts
    // without a manual nudge. Skipped while the agent is mid-run — the chat
    // service rejects concurrent streams, and the kickoff instructions already
    // tell agents to re-read task comments.
    if (activeSessionId && !activeSessionBusy) {
      try {
        await sendChatMessage(activeSessionId, `New comment on ${detail.key}:\n\n${body}`);
      } catch {
        // Best-effort: the comment is already on the task record.
      }
    }
  };

  const startAssign = async () => {
    const agent = agents.find((a) => a.id === assignAgentId);
    if (!agent || assigning) return;
    setAssigning(true);
    const before = new Set(detail.linked_sessions.map((l) => l.session_id));
    try {
      await assignAgent(issueId, { id: agent.id, name: agent.name });
      // Assign just created a NEW chat conversation; without a reload the
      // mount-time conversations snapshot excludes it, the mcSessions filter
      // drops the link, and the session tab never shows until a remount.
      await loadConversations();
      setAssignAgentId('');
      // Jump to the freshly created session's tab — that's where the kickoff streams.
      const after = useProjectsStore.getState().detailById[issueId]?.linked_sessions ?? [];
      const fresh = after.find((l) => !before.has(l.session_id)) ?? after[0];
      if (fresh) {
        setActiveTab(fresh.session_id);
        setSelectedSessionId(fresh.session_id);
      }
    } catch {
      // Error surfaced via the store; keep the picker state for retry.
    } finally {
      setAssigning(false);
    }
  };

  const confirmDeleteTask = async () => {
    if (deleting) return;
    setDeleting(true);
    // Capture before the delete drops `detail` from the store.
    const parentId = detail.parent_issue_id;
    try {
      await deleteIssue(issueId);
    } catch {
      // Store keeps the error; leave the page in place.
      setDeleting(false);
      setConfirmDelete(false);
      return;
    }
    if (parentId) {
      navigate({ to: '/projects/issues/$issueId', params: { issueId: parentId } });
    } else {
      navigate({ to: '/projects/all' });
    }
  };

  const submitSubtask = async () => {
    const title = subtaskTitle.trim();
    // Guard against double-submit: a fast second Enter while a create is
    // in flight would otherwise spawn a duplicate subtask.
    if (!title || savingSubtask) return;
    setSavingSubtask(true);
    setSubtaskTitle('');
    try {
      await createIssue({ title, parent_issue_id: issueId, project_id: detail.project_id });
      // Explicit refetch is intentional belt-and-suspenders: the WS
      // subtask_added → issue.event.appended broadcast also refreshes detail,
      // but this awaited reload guarantees the new subtask shows immediately.
      await loadIssueDetail(issueId);
    } finally {
      setSavingSubtask(false);
    }
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
        {confirmDelete ? (
          <div className="flex items-center gap-1 text-xs">
            <span className="text-red">Delete?</span>
            <button
              type="button"
              onClick={confirmDeleteTask}
              disabled={deleting}
              className="px-1.5 py-0.5 text-red hover:bg-red-900/30 disabled:opacity-50"
              data-testid="task-confirm-delete"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="px-1.5 py-0.5 text-muted hover:text-foreground"
            >
              No
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="p-1 text-muted transition-colors hover:text-red"
            title="Delete task"
            aria-label="Delete task"
            data-testid="task-delete"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Main column — Task tab (description/timeline/composer) or a session tab */}
        <div className="flex min-w-0 flex-1 flex-col overflow-auto border-r border-border px-8 py-4">
          {orderedMcSessions.length > 0 && (
            <div role="tablist" className="mb-4 flex shrink-0 gap-1 border-b border-border">
              <button
                type="button"
                role="tab"
                aria-selected={!activeSessionTab}
                data-testid="tab-task"
                onClick={() => setActiveTab('task')}
                className={`px-3 py-1.5 text-xs ${
                  !activeSessionTab
                    ? 'border-b-2 border-accent text-accent'
                    : 'text-muted hover:text-foreground'
                }`}
              >
                Task
              </button>
              {orderedMcSessions.map((link) => (
                <button
                  key={link.session_id}
                  type="button"
                  role="tab"
                  aria-selected={activeSessionTab === link.session_id}
                  data-testid={`tab-session-${link.session_id}`}
                  onClick={() => {
                    setActiveTab(link.session_id);
                    setSelectedSessionId(link.session_id);
                  }}
                  className={`flex items-center gap-1.5 truncate px-3 py-1.5 text-xs ${
                    activeSessionTab === link.session_id
                      ? 'border-b-2 border-accent text-accent'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  {sessionTabLabel(link)}
                  {chatSending[link.session_id] && (
                    <span
                      data-testid={`tab-dot-${link.session_id}`}
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    />
                  )}
                </button>
              ))}
            </div>
          )}

          {activeSessionTab ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center justify-end">
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      to: '/chat',
                      search: { agentId: '', conversationId: activeSessionTab },
                    })
                  }
                  title="Open in Chat"
                  aria-label="Open in Chat"
                  data-testid="session-open-chat"
                  className="p-1 text-muted transition-colors hover:text-accent"
                >
                  <ExternalLink size={12} />
                </button>
              </div>
              {/* Keyed so draft/answered state resets when switching sessions. */}
              <SessionPanel key={activeSessionTab} conversationId={activeSessionTab} />
            </div>
          ) : (
            <>
              <p className="mb-2 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
                Description
              </p>
              {detail.description ? (
                <div className="mb-4 text-sm text-foreground">
                  <Markdown>{detail.description}</Markdown>
                </div>
              ) : (
                <p className="mb-4 text-sm italic text-muted">No description</p>
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
                    <div
                      key={item.event.id}
                      className="flex items-center justify-between py-1 text-xs text-muted"
                    >
                      <span>
                        {item.event.type === 'session_linked'
                          ? sessionLinkedLabel(item.event)
                          : eventSummary(item.event)}
                      </span>
                      <span className="shrink-0 pl-2 text-[10px] opacity-60">
                        {relativeTime(item.event.created_at)}
                      </span>
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
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-[10px] text-muted">
                    {activeSessionId
                      ? activeSessionBusy
                        ? 'Agent is mid-run — comment stays on the task'
                        : 'Also sent to the agent session'
                      : ''}
                  </span>
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
            </>
          )}
        </div>

        {/* Right pane */}
        <div className="w-72 shrink-0 overflow-auto px-5 py-4">
          <Field label="Assignee" value={detail.assignee_user_id} />
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-muted">Sub-status</span>
            {detail.sub_status ? (
              <SubStatusPill subStatus={detail.sub_status} />
            ) : (
              <span className="text-foreground">—</span>
            )}
          </div>
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
            Assign agent
          </p>
          <div className="flex gap-1">
            <select
              value={assignAgentId}
              onChange={(e) => setAssignAgentId(e.target.value)}
              disabled={assigning}
              data-testid="task-assign-agent"
              className="min-w-0 flex-1 border border-border bg-card-bg px-2 py-1 text-xs text-foreground focus:border-accent focus:outline-none disabled:opacity-50"
            >
              <option value="">Select agent…</option>
              {agents
                .filter((a) => a.status !== 'disabled')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={startAssign}
              disabled={!assignAgentId || assigning}
              data-testid="task-assign-start"
              className="bg-accent px-2 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50"
            >
              {assigning ? 'Assigning…' : 'Assign'}
            </button>
          </div>

          <p className="mb-1 mt-4 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
            Linked sessions ({detail.linked_sessions.length})
          </p>
          {/* MC-session chips select the embedded panel (open-in-Chat lives in
              the panel header); sessions from other channels stay inert. */}
          {detail.linked_sessions.map((link) => {
            const label = `${link.agent_id ? `🤖 ${link.agent_id} · ` : ''}${link.session_id}`;
            const isActive = link.session_id === activeSessionId;
            return conversations.some((c) => c.id === link.session_id) ? (
              <button
                key={link.session_id}
                type="button"
                onClick={() => setSelectedSessionId(link.session_id)}
                data-testid={`session-chip-${link.session_id}`}
                title="Show session"
                className={`mb-1 block w-full truncate bg-sidebar-hover px-2 py-1 text-left text-xs hover:text-accent ${
                  isActive ? 'border-l-2 border-accent text-accent' : 'text-foreground'
                }`}
              >
                {label}
              </button>
            ) : (
              <span
                key={link.session_id}
                className="mb-1 block w-full truncate bg-sidebar-hover px-2 py-1 text-left text-xs text-muted"
                title="Session from another channel"
              >
                {label}
              </span>
            );
          })}

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
                  disabled={savingSubtask}
                  placeholder="+ Subtask"
                  className="flex-1 border border-border bg-card-bg px-2 py-1 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
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
