PRAGMA foreign_keys = ON;

ALTER TABLE accounts
  ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 0
  CHECK (session_generation >= 0);

ALTER TABLE account_sessions
  ADD COLUMN account_generation INTEGER NOT NULL DEFAULT 0
  CHECK (account_generation >= 0);
