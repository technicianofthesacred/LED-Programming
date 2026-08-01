import {
  PRODUCTION_PBKDF2_ITERATIONS,
  SESSION_MAX_AGE_SECONDS,
  createPasswordVerificationPlaceholder,
  createSessionCredential,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from './accountAuth.js';

const ROLES = new Set(['owner', 'worker', 'customer']);
const STATUSES = new Set(['active', 'disabled']);
const DEFAULT_LOCKOUT_ATTEMPTS = 5;
const DEFAULT_LOCKOUT_MS = 60_000;
const INVALID_CREDENTIALS = Object.freeze({
  code: 'invalid_credentials',
  message: 'Invalid username or password.',
  status: 401,
});

export class AccountStoreError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'AccountStoreError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new AccountStoreError(code, message, status);
}

function invalidCredentials() {
  fail(INVALID_CREDENTIALS.code, INVALID_CREDENTIALS.message, INVALID_CREDENTIALS.status);
}

export function normalizeUsername(username) {
  if (typeof username !== 'string') fail('invalid_username', 'A username is required.', 400);
  const normalized = username.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) {
    fail(
      'invalid_username',
      'Username must be 3–64 characters using letters, numbers, dots, dashes, or underscores.',
      400,
    );
  }
  return normalized;
}

function cleanDisplayName(displayName) {
  const value = typeof displayName === 'string' ? displayName.trim() : '';
  if (!value || [...value].length > 80) {
    fail('invalid_display_name', 'Display name must be 1–80 characters.', 400);
  }
  return value;
}

function cleanRole(role) {
  if (!ROLES.has(role)) fail('invalid_role', 'Role must be owner, worker, or customer.', 400);
  return role;
}

function cleanStatus(status) {
  if (!STATUSES.has(status)) fail('invalid_status', 'Status must be active or disabled.', 400);
  return status;
}

function publicAccount(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function accountIdentity(row) {
  return {
    accountId: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    subject: `account:${row.id}`,
  };
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('The account clock returned an invalid date.');
  return date.toISOString();
}

function positiveInteger(value, fallback, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return result;
}

function repositoryConflict(error) {
  return error?.code === 'username_taken'
    || /unique constraint failed:\s*accounts\.normalized_username/i.test(error?.message || '');
}

export function createAccountStore(repository, options = {}) {
  if (!repository) throw new TypeError('An account repository is required.');
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const passwordIterations = positiveInteger(
    options.passwordIterations,
    PRODUCTION_PBKDF2_ITERATIONS,
    'Password iterations',
  );
  const sessionTtlSeconds = positiveInteger(
    options.sessionTtlSeconds,
    SESSION_MAX_AGE_SECONDS,
    'Session TTL',
  );
  const lockoutAttempts = positiveInteger(
    options.lockoutAttempts,
    DEFAULT_LOCKOUT_ATTEMPTS,
    'Lockout attempts',
  );
  const lockoutMs = positiveInteger(options.lockoutMs, DEFAULT_LOCKOUT_MS, 'Lockout duration');

  function timestamp() {
    return isoTimestamp(now());
  }

  async function passwordHash(password) {
    try {
      return await hashPassword(password, {
        crypto: options.crypto,
        iterations: passwordIterations,
      });
    } catch (error) {
      if (/at least 12 characters/i.test(error?.message || '')) {
        fail('invalid_password', error.message, 400);
      }
      throw error;
    }
  }

  const dummyPasswordHash = createPasswordVerificationPlaceholder({
    iterations: passwordIterations,
  });

  async function requireAccount(id) {
    const account = typeof id === 'string' && id
      ? await repository.findAccountById(id)
      : null;
    if (!account) fail('account_not_found', 'The requested account was not found.', 404);
    return account;
  }

  async function createAccount({ username, displayName, role, temporaryPassword }) {
    const normalizedUsername = normalizeUsername(username);
    const createdAt = timestamp();
    const row = {
      id: crypto.randomUUID(),
      username: normalizedUsername,
      normalized_username: normalizedUsername,
      display_name: cleanDisplayName(displayName),
      role: cleanRole(role),
      status: 'active',
      password_hash: await passwordHash(temporaryPassword),
      must_change_password: 1,
      failed_login_attempts: 0,
      last_failed_login_at: null,
      locked_until: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    try {
      await repository.insertAccount(row);
    } catch (error) {
      if (repositoryConflict(error)) {
        fail('username_taken', 'That username is already in use.', 409);
      }
      throw error;
    }
    return publicAccount(row);
  }

  async function listAccounts() {
    return (await repository.listAccounts()).map(publicAccount);
  }

  async function resetPassword({ id, temporaryPassword }) {
    const account = await requireAccount(id);
    const updatedAt = timestamp();
    await repository.resetPasswordAndRevokeSessions(account.id, {
      password_hash: await passwordHash(temporaryPassword),
      must_change_password: 1,
      failed_login_attempts: 0,
      last_failed_login_at: null,
      locked_until: null,
      updated_at: updatedAt,
    }, updatedAt);
    return publicAccount(await requireAccount(account.id));
  }

  async function setAccountStatus({ id, status }) {
    const account = await requireAccount(id);
    const nextStatus = cleanStatus(status);
    const updatedAt = timestamp();
    await repository.updateStatusAndRevokeSessions(
      account.id,
      nextStatus,
      updatedAt,
      nextStatus === 'disabled',
    );
    return publicAccount(await requireAccount(account.id));
  }

  async function setAccountRole({ id, role }) {
    const account = await requireAccount(id);
    const nextRole = cleanRole(role);
    const updatedAt = timestamp();
    await repository.updateRoleAndRevokeSessions(
      account.id,
      nextRole,
      updatedAt,
      nextRole !== account.role,
    );
    return publicAccount(await requireAccount(account.id));
  }

  async function verifyLogin({ username, password }) {
    let normalizedUsername;
    try {
      normalizedUsername = normalizeUsername(username);
    } catch {
      normalizedUsername = '';
    }
    const account = normalizedUsername
      ? await repository.findAccountByNormalizedUsername(normalizedUsername)
      : null;

    const accepted = await verifyPassword(
      typeof password === 'string' ? password : '',
      account?.password_hash || dummyPasswordHash,
      { crypto: options.crypto },
    );
    if (!account) invalidCredentials();

    const current = timestamp();
    const currentMs = Date.parse(current);
    if (account.status !== 'active'
      || (account.locked_until && Date.parse(account.locked_until) > currentMs)) {
      invalidCredentials();
    }

    if (!accepted) {
      await repository.recordLoginFailure(account.id, {
        current,
        lockoutAttempts,
        lockedUntil: new Date(currentMs + lockoutMs).toISOString(),
        updated_at: current,
      });
      invalidCredentials();
    }

    if (account.failed_login_attempts || account.last_failed_login_at || account.locked_until) {
      await repository.updateLoginState(account.id, {
        failed_login_attempts: 0,
        last_failed_login_at: null,
        locked_until: null,
        updated_at: current,
      });
    }
    return accountIdentity(await requireAccount(account.id));
  }

  async function createSession(accountId, sessionOptions = {}) {
    const account = await requireAccount(accountId);
    if (account.status !== 'active') fail('account_disabled', 'The account is disabled.', 403);
    const ttlSeconds = positiveInteger(
      sessionOptions.ttlSeconds,
      sessionTtlSeconds,
      'Session TTL',
    );
    const createdAt = timestamp();
    const expiresAt = new Date(Date.parse(createdAt) + ttlSeconds * 1000).toISOString();
    const credential = await createSessionCredential({ crypto: options.crypto });
    await repository.insertSession({
      token_hash: credential.digest,
      account_id: account.id,
      created_at: createdAt,
      expires_at: expiresAt,
      revoked_at: null,
    });
    return { token: credential.token, expiresAt };
  }

  async function authenticateSession(token) {
    if (typeof token !== 'string' || !token) return null;
    const tokenHash = await hashSessionToken(token, { crypto: options.crypto });
    const result = await repository.findSessionWithAccount(tokenHash);
    if (!result?.session || !result?.account) return null;
    const currentMs = Date.parse(timestamp());
    if (result.session.revoked_at
      || Date.parse(result.session.expires_at) <= currentMs
      || result.account.status !== 'active') {
      return null;
    }
    return accountIdentity(result.account);
  }

  async function revokeSession(token) {
    if (typeof token !== 'string' || !token) return { revoked: false };
    const tokenHash = await hashSessionToken(token, { crypto: options.crypto });
    const revoked = await repository.revokeSession(tokenHash, timestamp());
    return { revoked: Boolean(revoked) };
  }

  async function changePassword({ accountId, newPassword }) {
    const account = await requireAccount(accountId);
    if (account.status !== 'active') fail('account_disabled', 'The account is disabled.', 403);
    const updatedAt = timestamp();
    await repository.updatePassword(account.id, {
      password_hash: await passwordHash(newPassword),
      must_change_password: 0,
      failed_login_attempts: 0,
      last_failed_login_at: null,
      locked_until: null,
      updated_at: updatedAt,
    });
    return publicAccount(await requireAccount(account.id));
  }

  return {
    authenticateSession,
    changePassword,
    createAccount,
    createSession,
    listAccounts,
    resetPassword,
    revokeSession,
    setAccountRole,
    setAccountStatus,
    verifyLogin,
  };
}

export function createD1AccountRepository(db) {
  return {
    async insertAccount(row) {
      await db.prepare(`
        INSERT INTO accounts (
          id, username, normalized_username, display_name, role, status, password_hash,
          must_change_password, failed_login_attempts, last_failed_login_at, locked_until,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        row.id,
        row.username,
        row.normalized_username,
        row.display_name,
        row.role,
        row.status,
        row.password_hash,
        row.must_change_password,
        row.failed_login_attempts,
        row.last_failed_login_at,
        row.locked_until,
        row.created_at,
        row.updated_at,
      ).run();
    },
    async listAccounts() {
      const { results } = await db.prepare(
        'SELECT * FROM accounts ORDER BY created_at ASC, id ASC',
      ).all();
      return results;
    },
    findAccountById(id) {
      return db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
    },
    findAccountByNormalizedUsername(username) {
      return db.prepare(
        'SELECT * FROM accounts WHERE normalized_username = ?',
      ).bind(username).first();
    },
    async updatePassword(id, values) {
      await db.prepare(`
        UPDATE accounts SET password_hash = ?, must_change_password = ?,
          failed_login_attempts = ?, last_failed_login_at = ?, locked_until = ?, updated_at = ?
        WHERE id = ?
      `).bind(
        values.password_hash,
        values.must_change_password,
        values.failed_login_attempts,
        values.last_failed_login_at,
        values.locked_until,
        values.updated_at,
        id,
      ).run();
    },
    async resetPasswordAndRevokeSessions(id, values, revokedAt) {
      await db.batch([
        db.prepare(`
          UPDATE accounts SET password_hash = ?, must_change_password = ?,
            failed_login_attempts = ?, last_failed_login_at = ?, locked_until = ?, updated_at = ?
          WHERE id = ?
        `).bind(
          values.password_hash,
          values.must_change_password,
          values.failed_login_attempts,
          values.last_failed_login_at,
          values.locked_until,
          values.updated_at,
          id,
        ),
        db.prepare(`
          UPDATE account_sessions SET revoked_at = ?
          WHERE account_id = ? AND revoked_at IS NULL
        `).bind(revokedAt, id),
      ]);
    },
    async updateStatusAndRevokeSessions(id, status, updatedAt, revokeSessions) {
      const statements = [
        db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?')
          .bind(status, updatedAt, id),
      ];
      if (revokeSessions) {
        statements.push(db.prepare(`
          UPDATE account_sessions SET revoked_at = ?
          WHERE account_id = ? AND revoked_at IS NULL
        `).bind(updatedAt, id));
      }
      await db.batch(statements);
    },
    async updateRoleAndRevokeSessions(id, role, updatedAt, revokeSessions) {
      const statements = [
        db.prepare('UPDATE accounts SET role = ?, updated_at = ? WHERE id = ?')
          .bind(role, updatedAt, id),
      ];
      if (revokeSessions) {
        statements.push(db.prepare(`
          UPDATE account_sessions SET revoked_at = ?
          WHERE account_id = ? AND revoked_at IS NULL
        `).bind(updatedAt, id));
      }
      await db.batch(statements);
    },
    async updateLoginState(id, values) {
      await db.prepare(`
        UPDATE accounts SET failed_login_attempts = ?, last_failed_login_at = ?,
          locked_until = ?, updated_at = ? WHERE id = ?
      `).bind(
        values.failed_login_attempts,
        values.last_failed_login_at,
        values.locked_until,
        values.updated_at,
        id,
      ).run();
    },
    async recordLoginFailure(id, values) {
      await db.prepare(`
        UPDATE accounts SET
          locked_until = CASE
            WHEN (
              CASE WHEN locked_until IS NOT NULL AND locked_until <= ?
                THEN 1 ELSE failed_login_attempts + 1 END
            ) >= ? THEN ?
            ELSE NULL
          END,
          failed_login_attempts = CASE
            WHEN locked_until IS NOT NULL AND locked_until <= ?
              THEN 1 ELSE failed_login_attempts + 1
          END,
          last_failed_login_at = ?,
          updated_at = ?
        WHERE id = ?
      `).bind(
        values.current,
        values.lockoutAttempts,
        values.lockedUntil,
        values.current,
        values.current,
        values.updated_at,
        id,
      ).run();
    },
    async insertSession(row) {
      await db.prepare(`
        INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        row.token_hash,
        row.account_id,
        row.created_at,
        row.expires_at,
        row.revoked_at,
      ).run();
    },
    async findSessionWithAccount(tokenHash) {
      const row = await db.prepare(`
        SELECT
          s.token_hash AS session_token_hash,
          s.account_id AS session_account_id,
          s.created_at AS session_created_at,
          s.expires_at AS session_expires_at,
          s.revoked_at AS session_revoked_at,
          a.*
        FROM account_sessions s
        JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = ?
      `).bind(tokenHash).first();
      if (!row) return null;
      return {
        session: {
          token_hash: row.session_token_hash,
          account_id: row.session_account_id,
          created_at: row.session_created_at,
          expires_at: row.session_expires_at,
          revoked_at: row.session_revoked_at,
        },
        account: row,
      };
    },
    async revokeSession(tokenHash, revokedAt) {
      const result = await db.prepare(`
        UPDATE account_sessions SET revoked_at = ?
        WHERE token_hash = ? AND revoked_at IS NULL
      `).bind(revokedAt, tokenHash).run();
      return (result?.meta?.changes || 0) > 0;
    },
    async revokeSessionsForAccount(accountId, revokedAt) {
      await db.prepare(`
        UPDATE account_sessions SET revoked_at = ?
        WHERE account_id = ? AND revoked_at IS NULL
      `).bind(revokedAt, accountId).run();
    },
  };
}

export function createD1AccountStore(env, options = {}) {
  if (!env?.PROJECTS_DB) return null;
  return createAccountStore(createD1AccountRepository(env.PROJECTS_DB), options);
}

export function createMemoryAccountRepository(seed = {}) {
  const accounts = new Map((seed.accounts || []).map(row => [row.id, structuredClone(row)]));
  const sessions = new Map((seed.sessions || []).map(row => [row.token_hash, structuredClone(row)]));

  function account(id) {
    return accounts.get(id) || null;
  }

  function revokeAccountSessions(accountId, revokedAt) {
    for (const session of sessions.values()) {
      if (session.account_id === accountId && !session.revoked_at) session.revoked_at = revokedAt;
    }
  }

  return {
    async insertAccount(row) {
      if ([...accounts.values()].some(value => value.normalized_username === row.normalized_username)) {
        const error = new Error('UNIQUE constraint failed: accounts.normalized_username');
        error.code = 'username_taken';
        throw error;
      }
      accounts.set(row.id, structuredClone(row));
    },
    async listAccounts() {
      return [...accounts.values()]
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .map(row => structuredClone(row));
    },
    async findAccountById(id) {
      return account(id) ? structuredClone(account(id)) : null;
    },
    async findAccountByNormalizedUsername(username) {
      const row = [...accounts.values()].find(value => value.normalized_username === username);
      return row ? structuredClone(row) : null;
    },
    async updatePassword(id, values) {
      Object.assign(account(id), structuredClone(values));
    },
    async resetPasswordAndRevokeSessions(id, values, revokedAt) {
      Object.assign(account(id), structuredClone(values));
      revokeAccountSessions(id, revokedAt);
    },
    async updateStatusAndRevokeSessions(id, status, updatedAt, revokeSessions) {
      Object.assign(account(id), { status, updated_at: updatedAt });
      if (revokeSessions) revokeAccountSessions(id, updatedAt);
    },
    async updateRoleAndRevokeSessions(id, role, updatedAt, revokeSessions) {
      Object.assign(account(id), { role, updated_at: updatedAt });
      if (revokeSessions) revokeAccountSessions(id, updatedAt);
    },
    async updateLoginState(id, values) {
      Object.assign(account(id), structuredClone(values));
    },
    async recordLoginFailure(id, values) {
      const row = account(id);
      const previousFailures = row.locked_until && row.locked_until <= values.current
        ? 0
        : row.failed_login_attempts;
      row.failed_login_attempts = previousFailures + 1;
      row.last_failed_login_at = values.current;
      row.locked_until = row.failed_login_attempts >= values.lockoutAttempts
        ? values.lockedUntil
        : null;
      row.updated_at = values.updated_at;
    },
    async insertSession(row) {
      sessions.set(row.token_hash, structuredClone(row));
    },
    async findSessionWithAccount(tokenHash) {
      const session = sessions.get(tokenHash);
      const owner = session ? account(session.account_id) : null;
      return session && owner
        ? { session: structuredClone(session), account: structuredClone(owner) }
        : null;
    },
    async revokeSession(tokenHash, revokedAt) {
      const session = sessions.get(tokenHash);
      if (!session || session.revoked_at) return false;
      session.revoked_at = revokedAt;
      return true;
    },
    async revokeSessionsForAccount(accountId, revokedAt) {
      revokeAccountSessions(accountId, revokedAt);
    },
    snapshot() {
      return {
        accounts: structuredClone([...accounts.values()]),
        sessions: structuredClone([...sessions.values()]),
      };
    },
  };
}
