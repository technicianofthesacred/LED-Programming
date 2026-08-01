PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  embedded_project_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  current_object_key TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  current_bytes INTEGER NOT NULL CHECK (current_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  last_editor TEXT NOT NULL,
  deleted_at TEXT,
  deletion_idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS project_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  object_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  project_version INTEGER NOT NULL CHECK (project_version >= 1),
  created_at TEXT NOT NULL,
  editor TEXT NOT NULL,
  UNIQUE (project_id, revision)
);

CREATE TABLE IF NOT EXISTS asset_heads (
  asset_kind TEXT PRIMARY KEY,
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  current_object_key TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  current_bytes INTEGER NOT NULL CHECK (current_bytes >= 0),
  updated_at TEXT NOT NULL,
  last_editor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_kind TEXT NOT NULL REFERENCES asset_heads(asset_kind),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  object_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at TEXT NOT NULL,
  editor TEXT NOT NULL,
  UNIQUE (asset_kind, revision)
);

CREATE TABLE IF NOT EXISTS library_imports (
  idempotency_key TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  projects_created INTEGER NOT NULL CHECK (projects_created >= 0),
  assets_created INTEGER NOT NULL CHECK (assets_created >= 0)
);

CREATE TABLE IF NOT EXISTS library_mutations (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  mutation_kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS projects_state_updated_idx
  ON projects (archived, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_embedded_id_idx
  ON projects (embedded_project_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS project_revisions_history_idx
  ON project_revisions (project_id, revision DESC);
CREATE INDEX IF NOT EXISTS asset_revisions_history_idx
  ON asset_revisions (asset_kind, revision DESC);
