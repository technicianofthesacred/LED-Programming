PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  normalized_username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  role TEXT NOT NULL CHECK (role IN ('owner', 'worker', 'customer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  last_failed_login_at TEXT,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS project_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_account_id TEXT NOT NULL REFERENCES accounts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  assigned_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  UNIQUE (customer_account_id, project_id)
);

ALTER TABLE projects ADD COLUMN draft_of_project_id TEXT REFERENCES projects(id);
ALTER TABLE projects ADD COLUMN draft_owner_account_id TEXT REFERENCES accounts(id);

CREATE INDEX IF NOT EXISTS accounts_role_status_idx
  ON accounts (role, status);
CREATE INDEX IF NOT EXISTS account_sessions_account_idx
  ON account_sessions (account_id, expires_at);
CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx
  ON account_sessions (expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS project_assignments_customer_idx
  ON project_assignments (customer_account_id, project_id);
CREATE INDEX IF NOT EXISTS project_assignments_project_idx
  ON project_assignments (project_id, customer_account_id);
CREATE INDEX IF NOT EXISTS projects_draft_parent_idx
  ON projects (draft_of_project_id)
  WHERE draft_of_project_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_draft_owner_idx
  ON projects (draft_owner_account_id)
  WHERE draft_owner_account_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS projects_customer_draft_unique_idx
  ON projects (draft_of_project_id, draft_owner_account_id)
  WHERE draft_of_project_id IS NOT NULL
    AND draft_owner_account_id IS NOT NULL
    AND deleted_at IS NULL;
