import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type { ProjectsEmitter } from '../events.js';
import type { SessionIssueLink } from '../types.js';
import type { IssueEventStore } from './issue-event-store.js';
import type { SessionLinkStore } from './session-link-store.js';

interface SessionLinkRow {
  session_id: string;
  issue_id: string;
  agent_id: string | null;
  first_referenced_at: string;
  last_referenced_at: string;
  reference_count: number;
}

function toLink(row: SessionLinkRow): SessionIssueLink {
  return {
    session_id: row.session_id,
    issue_id: row.issue_id,
    agent_id: row.agent_id,
    first_referenced_at: row.first_referenced_at,
    last_referenced_at: row.last_referenced_at,
    reference_count: row.reference_count,
  };
}

export class SessionLinkStoreSqlite implements SessionLinkStore {
  private readonly getStmt: Statement;
  private readonly insertStmt: Statement;
  private readonly bumpStmt: Statement;
  private readonly listByIssueStmt: Statement;
  private readonly listBySessionStmt: Statement;

  constructor(
    private readonly db: DatabaseType,
    private readonly emitter: ProjectsEmitter,
    private readonly eventStore: IssueEventStore,
  ) {
    this.getStmt = db.prepare(
      'SELECT * FROM session_issue_link WHERE session_id = ? AND issue_id = ?',
    );
    this.insertStmt = db.prepare(`
      INSERT INTO session_issue_link
        (session_id, issue_id, agent_id, first_referenced_at, last_referenced_at, reference_count)
      VALUES (@session_id, @issue_id, @agent_id, @first_referenced_at, @last_referenced_at, 1)
    `);
    // COALESCE keeps an already-set agent_id and only backfills when it was
    // NULL — re-linking from a human turn (agentId undefined) never clobbers
    // an agent attribution recorded earlier.
    this.bumpStmt = db.prepare(`
      UPDATE session_issue_link
      SET reference_count = reference_count + 1,
          last_referenced_at = @last_referenced_at,
          agent_id = COALESCE(agent_id, @agent_id)
      WHERE session_id = @session_id AND issue_id = @issue_id
    `);
    this.listByIssueStmt = db.prepare(
      'SELECT * FROM session_issue_link WHERE issue_id = ? ORDER BY first_referenced_at ASC',
    );
    this.listBySessionStmt = db.prepare(
      'SELECT * FROM session_issue_link WHERE session_id = ? ORDER BY first_referenced_at ASC',
    );
  }

  link(sessionId: string, issueId: string, agentId: string | null = null): SessionIssueLink {
    const now = new Date().toISOString();
    const existing = this.getStmt.get(sessionId, issueId) as SessionLinkRow | undefined;

    if (!existing) {
      const link: SessionIssueLink = {
        session_id: sessionId,
        issue_id: issueId,
        agent_id: agentId,
        first_referenced_at: now,
        last_referenced_at: now,
        reference_count: 1,
      };
      this.insertStmt.run(link);
      this.eventStore.append({
        issue_id: issueId,
        type: 'session_linked',
        actor_type: 'system',
        actor_id: 'system',
        data: { session_id: sessionId, agent_id: agentId },
      });
      this.emitter.emit('session.linked', { issueId, sessionId, link });
      return link;
    }

    this.bumpStmt.run({
      session_id: sessionId,
      issue_id: issueId,
      agent_id: agentId,
      last_referenced_at: now,
    });
    return toLink(this.getStmt.get(sessionId, issueId) as SessionLinkRow);
  }

  listByIssue(issueId: string): SessionIssueLink[] {
    return (this.listByIssueStmt.all(issueId) as SessionLinkRow[]).map(toLink);
  }

  listBySession(sessionId: string): SessionIssueLink[] {
    return (this.listBySessionStmt.all(sessionId) as SessionLinkRow[]).map(toLink);
  }
}
