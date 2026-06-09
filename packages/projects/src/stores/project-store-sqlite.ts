import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type { ProjectsEmitter } from '../events.js';
import type { IssueStatus, Project, ProjectStatus } from '../types.js';
import { projectId } from '../ulid.js';
import type {
  CreateProjectInput,
  ProjectStore,
  ProjectWithCounts,
  UpdateProjectInput,
} from './project-store.js';

const ALL_ISSUE_STATUSES: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
];

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  };
}

export class ProjectStoreSqlite implements ProjectStore {
  private readonly insertStmt: Statement;
  private readonly getStmt: Statement;
  private readonly getByKeyStmt: Statement;
  private readonly listAllStmt: Statement;
  private readonly listByStatusStmt: Statement;
  private readonly countsStmt: Statement;
  private readonly updateStmt: Statement;

  constructor(
    private readonly db: DatabaseType,
    private readonly emitter: ProjectsEmitter,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO project (id, key, name, description, status, created_at, updated_at, archived_at)
      VALUES (@id, @key, @name, @description, @status, @created_at, @updated_at, @archived_at)
    `);
    this.getStmt = db.prepare('SELECT * FROM project WHERE id = ?');
    this.getByKeyStmt = db.prepare('SELECT * FROM project WHERE key = ?');
    this.listAllStmt = db.prepare('SELECT * FROM project ORDER BY created_at ASC');
    this.listByStatusStmt = db.prepare(
      'SELECT * FROM project WHERE status = ? ORDER BY created_at ASC',
    );
    this.countsStmt = db.prepare(
      'SELECT status, COUNT(*) AS count FROM issue WHERE project_id = ? GROUP BY status',
    );
    this.updateStmt = db.prepare(
      `UPDATE project SET name = @name, description = @description, status = @status,
       archived_at = @archived_at, updated_at = @updated_at WHERE id = @id`,
    );
  }

  create(input: CreateProjectInput): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: projectId(),
      key: input.key,
      name: input.name,
      description: input.description ?? '',
      status: input.status ?? 'active',
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    this.insertStmt.run(project);
    this.emitter.emit('project.created', { project });
    return project;
  }

  get(id: string): Project | null {
    const row = this.getStmt.get(id) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  getByKey(key: string): Project | null {
    const row = this.getByKeyStmt.get(key) as ProjectRow | undefined;
    return row ? toProject(row) : null;
  }

  getByIdOrKey(idOrKey: string): Project | null {
    return idOrKey.startsWith('proj_') ? this.get(idOrKey) : this.getByKey(idOrKey);
  }

  getWithCounts(idOrKey: string): ProjectWithCounts | null {
    const project = this.getByIdOrKey(idOrKey);
    if (!project) return null;
    const counts = Object.fromEntries(ALL_ISSUE_STATUSES.map((s) => [s, 0])) as Record<
      IssueStatus,
      number
    >;
    const rows = this.countsStmt.all(project.id) as { status: string; count: number }[];
    for (const row of rows) {
      counts[row.status as IssueStatus] = row.count;
    }
    return { ...project, issue_counts_by_status: counts };
  }

  list(filter?: { status?: ProjectStatus }): Project[] {
    const rows = filter?.status
      ? (this.listByStatusStmt.all(filter.status) as ProjectRow[])
      : (this.listAllStmt.all() as ProjectRow[]);
    return rows.map(toProject);
  }

  update(id: string, patch: UpdateProjectInput): Project {
    const current = this.get(id);
    if (!current) throw new Error(`project not found: ${id}`);
    const next: Project = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      status: patch.status ?? current.status,
      archived_at: patch.archived_at !== undefined ? patch.archived_at : current.archived_at,
      updated_at: new Date().toISOString(),
    };
    this.updateStmt.run(next);
    this.emitter.emit('project.updated', { project: next });
    return next;
  }
}
