PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- MEMORIES — unified store for semantic, episodic, procedural
-- ============================================================
CREATE TABLE IF NOT EXISTS memories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_type     TEXT    NOT NULL,  -- semantic | episodic | procedural
  scope           TEXT    NOT NULL DEFAULT 'project',  -- global | user | project | session
  namespace       TEXT,              -- project name, user id, session id, etc.
  agent_role      TEXT,              -- planner, reviewer, qa-tester, or any custom role
  title           TEXT    NOT NULL,
  content         TEXT    NOT NULL,
  -- references
  task_id         TEXT,
  pr_number       INTEGER,
  run_id          TEXT,
  -- lifecycle
  status          TEXT    NOT NULL DEFAULT 'active',  -- active | summarized | archived
  confidence      REAL    NOT NULL DEFAULT 1.0,       -- 0.0-1.0, decays over time
  superseded_by   INTEGER REFERENCES memories(id),
  -- temporal
  tags            TEXT    NOT NULL DEFAULT '[]',
  metadata        TEXT    NOT NULL DEFAULT '{}',
  created_at      TEXT    NOT NULL,
  occurred_at     TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  last_accessed_at TEXT,
  access_count    INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mem_type       ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_mem_scope      ON memories(scope, namespace);
CREATE INDEX IF NOT EXISTS idx_mem_role       ON memories(agent_role);
CREATE INDEX IF NOT EXISTS idx_mem_status     ON memories(status);
CREATE INDEX IF NOT EXISTS idx_mem_task       ON memories(task_id);
CREATE INDEX IF NOT EXISTS idx_mem_occurred   ON memories(occurred_at);
CREATE INDEX IF NOT EXISTS idx_mem_hash       ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_mem_ns_type    ON memories(namespace, memory_type);
CREATE INDEX IF NOT EXISTS idx_mem_ns_role    ON memories(namespace, agent_role);
CREATE INDEX IF NOT EXISTS idx_mem_confidence ON memories(confidence);
CREATE INDEX IF NOT EXISTS idx_mem_accessed   ON memories(last_accessed_at);

-- FTS5 for memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, content,
  content=memories, content_rowid=id
);
CREATE TRIGGER IF NOT EXISTS mem_fts_i AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS mem_fts_u AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
  INSERT INTO memories_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS mem_fts_d AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
END;

-- ============================================================
-- DOCUMENTS — source documents ingested for RAG
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace   TEXT,
  title       TEXT    NOT NULL,
  source      TEXT,              -- file path, URL, or identifier
  mime_type   TEXT    DEFAULT 'text/plain',
  content     TEXT    NOT NULL,  -- full original content
  metadata    TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doc_ns ON documents(namespace);

-- CHUNKS — document chunks with embeddings
CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  content      TEXT    NOT NULL,
  char_offset  INTEGER NOT NULL DEFAULT 0,
  char_length  INTEGER NOT NULL DEFAULT 0,
  metadata     TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunk_doc ON chunks(document_id);

-- FTS5 for chunks
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content=chunks, content_rowid=id
);
CREATE TRIGGER IF NOT EXISTS chunk_fts_i AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunk_fts_u AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunk_fts_d AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- ============================================================
-- KNOWLEDGE GRAPH — entities and relations
-- ============================================================
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  entity_type TEXT    NOT NULL,  -- project, person, technology, concept, file, etc.
  namespace   TEXT,
  description TEXT,
  metadata    TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  UNIQUE(name, entity_type, namespace)
);

CREATE INDEX IF NOT EXISTS idx_ent_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_ent_ns   ON entities(namespace);

CREATE TABLE IF NOT EXISTS relations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type    TEXT    NOT NULL,  -- uses, depends_on, created_by, part_of, related_to, etc.
  target_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  weight           REAL    NOT NULL DEFAULT 1.0,
  memory_id        INTEGER REFERENCES memories(id),  -- evidence link
  metadata         TEXT    NOT NULL DEFAULT '{}',
  created_at       TEXT    NOT NULL,
  UNIQUE(source_entity_id, relation_type, target_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_rel_source ON relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relations(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_rel_type   ON relations(relation_type);

-- ============================================================
-- EPISODES — conversation/run history
-- ============================================================
CREATE TABLE IF NOT EXISTS episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  namespace   TEXT,
  agent_role  TEXT,
  role        TEXT    NOT NULL,  -- user | assistant | system
  content     TEXT    NOT NULL,
  summary     TEXT,
  metadata    TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ep_session ON episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_ep_ns      ON episodes(namespace);

-- FTS5 for episodes
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  content, summary,
  content=episodes, content_rowid=id
);
CREATE TRIGGER IF NOT EXISTS ep_fts_i AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, content, summary) VALUES (new.id, new.content, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS ep_fts_u AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, summary) VALUES ('delete', old.id, old.content, old.summary);
  INSERT INTO episodes_fts(rowid, content, summary) VALUES (new.id, new.content, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS ep_fts_d AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content, summary) VALUES ('delete', old.id, old.content, old.content);
END;

-- ============================================================
-- SUMMARIES — rolled-up digests
-- ============================================================
CREATE TABLE IF NOT EXISTS summaries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT    NOT NULL,
  namespace   TEXT,
  agent_role  TEXT,
  title       TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  entry_count INTEGER NOT NULL,
  date_from   TEXT    NOT NULL,
  date_to     TEXT    NOT NULL,
  entry_ids   TEXT    NOT NULL,  -- JSON array
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sum_ns ON summaries(namespace, agent_role);
