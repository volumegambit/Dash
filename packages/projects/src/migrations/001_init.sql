CREATE TABLE project (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
);

CREATE TABLE issue (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES project(id) ON DELETE SET NULL,
  parent_issue_id TEXT REFERENCES issue(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, sub_status TEXT,
  assignee_user_id TEXT NOT NULL,
  created_by TEXT NOT NULL, created_by_agent_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX issue_by_project ON issue(project_id, status);
CREATE INDEX issue_by_assignee_status ON issue(assignee_user_id, status, sub_status);
CREATE INDEX issue_by_parent ON issue(parent_issue_id);

CREATE TABLE issue_comment (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL, author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX comment_by_issue_time ON issue_comment(issue_id, created_at);

CREATE TABLE issue_event (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX event_by_issue_time ON issue_event(issue_id, created_at);

CREATE TABLE session_issue_link (
  session_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  agent_id TEXT,
  first_referenced_at TEXT NOT NULL, last_referenced_at TEXT NOT NULL,
  reference_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, issue_id)
);
CREATE INDEX session_link_by_issue ON session_issue_link(issue_id);
CREATE INDEX session_link_by_agent ON session_issue_link(agent_id);

CREATE TABLE project_issue_seq (project_id TEXT PRIMARY KEY, next_num INTEGER NOT NULL);
CREATE TABLE inbox_read (issue_id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL);
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
