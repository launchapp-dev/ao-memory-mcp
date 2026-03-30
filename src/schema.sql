PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type   TEXT    NOT NULL,
  agent_role   TEXT    NOT NULL,
  project      TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  task_id      TEXT,
  pr_number    INTEGER,
  run_id       TEXT,
  status       TEXT    NOT NULL DEFAULT 'active',
  tags         TEXT    NOT NULL DEFAULT '[]',
  metadata     TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL,
  occurred_at  TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  content_hash TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_summaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_role    TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  entry_type    TEXT,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  entry_count   INTEGER NOT NULL,
  date_from     TEXT    NOT NULL,
  date_to       TEXT    NOT NULL,
  entry_ids     TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_patterns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type     TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL,
  projects         TEXT    NOT NULL DEFAULT '[]',
  agent_roles      TEXT    NOT NULL DEFAULT '[]',
  entry_ids        TEXT    NOT NULL DEFAULT '[]',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL DEFAULT 'active',
  first_seen       TEXT    NOT NULL,
  last_seen        TEXT    NOT NULL,
  resolved_at      TEXT,
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL
);

-- Indexes for memory_entries
CREATE INDEX IF NOT EXISTS idx_me_entry_type   ON memory_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_me_agent_role   ON memory_entries(agent_role);
CREATE INDEX IF NOT EXISTS idx_me_project      ON memory_entries(project);
CREATE INDEX IF NOT EXISTS idx_me_status       ON memory_entries(status);
CREATE INDEX IF NOT EXISTS idx_me_task_id      ON memory_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_me_occurred_at  ON memory_entries(occurred_at);
CREATE INDEX IF NOT EXISTS idx_me_content_hash ON memory_entries(content_hash);
CREATE INDEX IF NOT EXISTS idx_me_role_project ON memory_entries(agent_role, project);
CREATE INDEX IF NOT EXISTS idx_me_proj_type    ON memory_entries(project, entry_type);
CREATE INDEX IF NOT EXISTS idx_me_proj_date    ON memory_entries(project, occurred_at);

-- Indexes for memory_summaries
CREATE INDEX IF NOT EXISTS idx_ms_role_project ON memory_summaries(agent_role, project);

-- Indexes for memory_patterns
CREATE INDEX IF NOT EXISTS idx_mp_status       ON memory_patterns(status);
CREATE INDEX IF NOT EXISTS idx_mp_pattern_type ON memory_patterns(pattern_type);

-- FTS5 for memory_entries
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title,
  body,
  content=memory_entries,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO memory_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;

-- FTS5 for memory_summaries
CREATE VIRTUAL TABLE IF NOT EXISTS memory_summaries_fts USING fts5(
  title,
  body,
  content=memory_summaries,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS ms_fts_insert AFTER INSERT ON memory_summaries BEGIN
  INSERT INTO memory_summaries_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS ms_fts_update AFTER UPDATE ON memory_summaries BEGIN
  INSERT INTO memory_summaries_fts(memory_summaries_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO memory_summaries_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS ms_fts_delete AFTER DELETE ON memory_summaries BEGIN
  INSERT INTO memory_summaries_fts(memory_summaries_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
