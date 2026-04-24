-- =============================================================================
-- Edge Context Mode — D1 Initial Schema
-- Apply local:  wrangler d1 migrations apply edge-context-db --local
-- Apply remote: wrangler d1 migrations apply edge-context-db --remote
-- =============================================================================

-- Sessions: one row per agent/developer session.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT    NOT NULL PRIMARY KEY,
  actor       TEXT    NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_seen   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Context entries: tool outputs, prompts, decisions, events.
-- raw output is NEVER stored here — only the summary.
CREATE TABLE IF NOT EXISTS context_entries (
  id          TEXT    NOT NULL PRIMARY KEY,  -- nanoid, used as [ctx:id] token
  session_id  TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK (type IN ('tool_output', 'prompt', 'decision', 'event')),
  intent      TEXT,
  summary     TEXT    NOT NULL,
  raw_size    INTEGER NOT NULL DEFAULT 0,
  vector_id   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at  INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entries_session
  ON context_entries (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_expiry
  ON context_entries (expires_at);

-- FTS5 virtual table for BM25 search over intent + summary.
CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
  id         UNINDEXED,
  session_id UNINDEXED,
  intent,
  summary,
  content    = context_entries,
  content_rowid = rowid
);

-- Keep FTS in sync with context_entries via triggers.
CREATE TRIGGER IF NOT EXISTS fts_insert
  AFTER INSERT ON context_entries BEGIN
    INSERT INTO context_fts (rowid, id, session_id, intent, summary)
    VALUES (new.rowid, new.id, new.session_id, new.intent, new.summary);
  END;

CREATE TRIGGER IF NOT EXISTS fts_delete
  AFTER DELETE ON context_entries BEGIN
    INSERT INTO context_fts (context_fts, rowid, id, session_id, intent, summary)
    VALUES ('delete', old.rowid, old.id, old.session_id, old.intent, old.summary);
  END;

CREATE TRIGGER IF NOT EXISTS fts_update
  AFTER UPDATE ON context_entries BEGIN
    INSERT INTO context_fts (context_fts, rowid, id, session_id, intent, summary)
    VALUES ('delete', old.rowid, old.id, old.session_id, old.intent, old.summary);
    INSERT INTO context_fts (rowid, id, session_id, intent, summary)
    VALUES (new.rowid, new.id, new.session_id, new.intent, new.summary);
  END;
