import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type { ProjectsEmitter } from '../events.js';
import type { ActorType, IssueEvent, IssueEventType } from '../types.js';
import { eventId } from '../ulid.js';
import type { AppendEventInput, IssueEventStore } from './issue-event-store.js';

interface IssueEventRow {
  id: string;
  issue_id: string;
  type: string;
  actor_type: string;
  actor_id: string;
  data: string;
  created_at: string;
}

function toEvent(row: IssueEventRow): IssueEvent {
  return {
    id: row.id,
    issue_id: row.issue_id,
    type: row.type as IssueEventType,
    actor_type: row.actor_type as ActorType,
    actor_id: row.actor_id,
    data: row.data,
    created_at: row.created_at,
  };
}

export class IssueEventStoreSqlite implements IssueEventStore {
  private readonly insertStmt: Statement;
  private readonly listStmt: Statement;

  constructor(
    db: DatabaseType,
    private readonly emitter: ProjectsEmitter,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO issue_event (id, issue_id, type, actor_type, actor_id, data, created_at)
      VALUES (@id, @issue_id, @type, @actor_type, @actor_id, @data, @created_at)
    `);
    // Secondary sort on rowid keeps insertion order stable when two
    // events share the same ISO-millisecond created_at timestamp.
    this.listStmt = db.prepare(
      'SELECT * FROM issue_event WHERE issue_id = ? ORDER BY created_at ASC, rowid ASC',
    );
  }

  append(input: AppendEventInput): IssueEvent {
    const event: IssueEvent = {
      id: eventId(),
      issue_id: input.issue_id,
      type: input.type,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      data: JSON.stringify(input.data ?? {}),
      created_at: new Date().toISOString(),
    };
    this.insertStmt.run(event);
    this.emitter.emit('issue.event.appended', { event });
    return event;
  }

  listByIssue(issueId: string): IssueEvent[] {
    const rows = this.listStmt.all(issueId) as IssueEventRow[];
    return rows.map(toEvent);
  }
}
