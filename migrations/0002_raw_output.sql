-- =============================================================================
-- Migration 0002: Add raw_output column + 'annotation' entry type
-- Apply local:  wrangler d1 migrations apply edge-context-db --local
-- Apply remote: wrangler d1 migrations apply edge-context-db --remote
--
-- SQLite cannot modify CHECK constraints via ALTER TABLE, so we recreate
-- context_entries with both changes in one migration:
--   1. raw_output TEXT column (nullable — pre-migration entries stay NULL)
--   2. 'annotation' added to the type CHECK constraint (for ctx_annotate)
-- FTS5 table and triggers are rebuilt from scratch to stay in sync.
-- =============================================================================

PRAGMA foreign_keys = OFF;

-- Step 1: new table with updated schema
CREATE TABLE context_entries_v2 (
  id          TEXT    NOT NULL PRIMARY KEY,
  session_id  TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  type        TEXT    NOT NULL CHECK (type IN ('tool_output', 'prompt', 'decision', 'event', 'annotation')),
  intent      TEXT,
  summary     TEXT    NOT NULL,
  raw_size    INTEGER NOT NULL DEFAULT 0,
  raw_output  TEXT,                           -- full command stdout or annotation text
  vector_id   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at  INTEGER NOT NULL,

  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Step 2: copy existing rows (raw_output defaults to NULL for old entries)
INSERT INTO context_entries_v2 (id, session_id, actor, type, intent, summary, raw_size, vector_id, created_at, expires_at)
  SELECT id, session_id, actor, type, intent, summary, raw_size, vector_id, created_at, expires_at
  FROM context_entries;

-- Step 3: drop FTS triggers before dropping the source table
DROP TRIGGER IF EXISTS fts_insert;
DROP TRIGGER IF EXISTS fts_delete;
DROP TRIGGER IF EXISTS fts_update;

-- Step 4: swap tables
DROP TABLE context_entries;
ALTER TABLE context_entries_v2 RENAME TO context_entries;

-- Step 5: recreate indexes
CREATE INDEX IF NOT EXISTS idx_entries_session
  ON context_entries (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_expiry
  ON context_entries (expires_at);

-- Step 6: rebuild FTS5 virtual table
DROP TABLE IF EXISTS context_fts;

CREATE VIRTUAL TABLE context_fts USING fts5(
  id         UNINDEXED,
  session_id UNINDEXED,
  intent,
  summary,
  content    = context_entries,
  content_rowid = rowid
);

-- Step 7: repopulate FTS from existing entries
INSERT INTO context_fts (rowid, id, session_id, intent, summary)
  SELECT rowid, id, session_id, intent, summary FROM context_entries;

-- Step 8: recreate triggers
CREATE TRIGGER fts_insert
  AFTER INSERT ON context_entries BEGIN
    INSERT INTO context_fts (rowid, id, session_id, intent, summary)
    VALUES (new.rowid, new.id, new.session_id, new.intent, new.summary);
  END;

CREATE TRIGGER fts_delete
  AFTER DELETE ON context_entries BEGIN
    INSERT INTO context_fts (context_fts, rowid, id, session_id, intent, summary)
    VALUES ('delete', old.rowid, old.id, old.session_id, old.intent, old.summary);
  END;

CREATE TRIGGER fts_update
  AFTER UPDATE ON context_entries BEGIN
    INSERT INTO context_fts (context_fts, rowid, id, session_id, intent, summary)
    VALUES ('delete', old.rowid, old.id, old.session_id, old.intent, old.summary);
    INSERT INTO context_fts (rowid, id, session_id, intent, summary)
    VALUES (new.rowid, new.id, new.session_id, new.intent, new.summary);
  END;

PRAGMA foreign_keys = ON;
