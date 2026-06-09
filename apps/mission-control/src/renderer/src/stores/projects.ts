import { create } from 'zustand';
import type {
  CreateIssueInput,
  CreateProjectInput,
  InboxItem,
  Issue,
  IssueDetail,
  IssueFilters,
  KanbanViewMode,
  Project,
  ProjectWithCounts,
  ProjectsEvent,
} from '../../../shared/projects-ipc.js';

const VIEW_MODE_KEY = 'dash.projects.kanbanViewMode';

function loadViewMode(): KanbanViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if (v === 'flat' || v === 'swimlane' || v === 'sub_status') return v;
  } catch {
    // ignore
  }
  return 'sub_status';
}

interface ProjectsState {
  projectsById: Record<string, Project>;
  issuesById: Record<string, Issue>;
  detailById: Record<string, IssueDetail>;
  inbox: InboxItem[];
  kanbanViewMode: KanbanViewMode;
  loading: boolean;
  error: string | null;
  subscribed: boolean;

  setKanbanViewMode(mode: KanbanViewMode): void;

  loadProjects(): Promise<void>;
  loadIssues(filters?: IssueFilters): Promise<void>;
  loadInbox(): Promise<void>;
  loadIssueDetail(id: string): Promise<void>;
  getProject(id: string): Promise<ProjectWithCounts>;

  createProject(input: CreateProjectInput): Promise<Project>;
  createIssue(input: CreateIssueInput): Promise<Issue>;
  patchIssue(id: string, patch: Partial<Issue>): Promise<void>;
  patchProject(id: string, patch: Partial<Project>): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  editComment(issueId: string, commentId: string, body: string): Promise<void>;
  deleteComment(issueId: string, commentId: string): Promise<void>;
  markInboxRead(issueId: string): Promise<void>;

  applyEvent(event: ProjectsEvent): void;
  subscribe(): () => void;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projectsById: {},
  issuesById: {},
  detailById: {},
  inbox: [],
  kanbanViewMode: loadViewMode(),
  loading: false,
  error: null,
  subscribed: false,

  setKanbanViewMode(mode) {
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // ignore
    }
    set({ kanbanViewMode: mode });
  },

  async loadProjects() {
    set({ loading: true, error: null });
    try {
      const projects = await window.api.projectsListProjects();
      set((s) => ({
        loading: false,
        projectsById: {
          ...s.projectsById,
          ...Object.fromEntries(projects.map((p) => [p.id, p])),
        },
      }));
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async loadIssues(filters) {
    set({ loading: true, error: null });
    try {
      const issues = await window.api.projectsListIssues(filters);
      set((s) => ({
        loading: false,
        issuesById: { ...s.issuesById, ...Object.fromEntries(issues.map((i) => [i.id, i])) },
      }));
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async loadInbox() {
    set({ loading: true, error: null });
    try {
      const inbox = await window.api.projectsListInbox();
      set({ inbox, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async loadIssueDetail(id) {
    try {
      const detail = await window.api.projectsGetIssue(id);
      set((s) => ({
        detailById: { ...s.detailById, [id]: detail },
        issuesById: { ...s.issuesById, [id]: detail },
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async getProject(id) {
    return window.api.projectsGetProject(id);
  },

  async createProject(input) {
    const project = await window.api.projectsCreateProject(input);
    set((s) => ({ projectsById: { ...s.projectsById, [project.id]: project } }));
    return project;
  },

  async createIssue(input) {
    const issue = await window.api.projectsCreateIssue(input);
    set((s) => ({ issuesById: { ...s.issuesById, [issue.id]: issue } }));
    return issue;
  },

  async patchIssue(id, patch) {
    const updated = await window.api.projectsPatchIssue(id, patch);
    set((s) => ({ issuesById: { ...s.issuesById, [id]: updated } }));
    // Detail (if cached) is refreshed by the WS event.appended broadcast.
  },

  async patchProject(id, patch) {
    const updated = await window.api.projectsPatchProject(id, patch);
    set((s) => ({ projectsById: { ...s.projectsById, [id]: updated } }));
  },

  async addComment(issueId, body) {
    await window.api.projectsAddComment(issueId, body);
    // Detail refresh is driven by the WS comment.added broadcast.
  },

  async editComment(issueId, commentId, body) {
    await window.api.projectsEditComment(issueId, commentId, body);
    // Detail refresh is driven by the WS comment.edited broadcast.
  },

  async deleteComment(issueId, commentId) {
    await window.api.projectsDeleteComment(issueId, commentId);
    // Detail refresh is driven by the WS comment.deleted broadcast.
  },

  async markInboxRead(issueId) {
    // Optimistically remove the item so the UI updates immediately.
    set((s) => ({ inbox: s.inbox.filter((it) => it.issue.id !== issueId) }));
    try {
      await window.api.projectsMarkInboxRead(issueId);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  // The `onProjectsEvent` frames are already normalized by the gateway
  // broadcaster: `payload` is a BARE entity (`Issue` for `issue.*`,
  // `Project` for `project.*`), and `{ issue_id }` for `comment.*` /
  // `issue.event.appended` / `session.linked`. Do NOT read `payload.issue`
  // / `payload.project` / `payload.data` — they don't exist on the wire.
  applyEvent(event) {
    const { topic, payload } = event;
    switch (topic) {
      case 'issue.created':
      case 'issue.updated': {
        const issue = payload as unknown as Issue;
        if (!issue?.id) return;
        set((s) => ({ issuesById: { ...s.issuesById, [issue.id]: issue } }));
        return;
      }
      case 'project.created':
      case 'project.updated': {
        const project = payload as unknown as Project;
        if (!project?.id) return;
        set((s) => ({ projectsById: { ...s.projectsById, [project.id]: project } }));
        return;
      }
      case 'issue.event.appended':
      case 'comment.added':
      case 'comment.edited':
      case 'comment.deleted':
      case 'session.linked': {
        // These mutate a single issue's detail. If we have it cached and
        // open, refetch the pre-merged detail so the timeline stays correct.
        const issueId = (payload as { issue_id?: string }).issue_id;
        if (issueId && get().detailById[issueId]) {
          void get().loadIssueDetail(issueId);
        }
        return;
      }
      default:
        return;
    }
  },

  subscribe() {
    if (get().subscribed) return () => {};
    const unsub = window.api.onProjectsEvent((event) => {
      get().applyEvent(event);
    });
    set({ subscribed: true });
    return () => {
      set({ subscribed: false });
      unsub();
    };
  },
}));
