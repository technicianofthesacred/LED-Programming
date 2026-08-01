import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PRODUCTION_PBKDF2_ITERATIONS,
  SESSION_COOKIE_NAME,
  createSessionCredential,
  hashSessionToken,
  hashPassword,
  readSessionCookie,
  serializeSessionCookie,
  serializeSessionCookieRemoval,
  verifyPassword,
} from './accountAuth.js';
import {
  AccountStoreError,
  createAccountStore,
  createMemoryAccountRepository,
} from './accountStore.js';

const TEST_ITERATIONS = 1_000;

function createClock(start = '2026-08-01T00:00:00.000Z') {
  let value = Date.parse(start);
  return {
    advance(milliseconds) {
      value += milliseconds;
    },
    now() {
      return new Date(value).toISOString();
    },
  };
}

function setup(options = {}) {
  const clock = options.clock || createClock();
  const repository = options.repository || createMemoryAccountRepository();
  const accounts = createAccountStore(repository, {
    crypto: options.crypto,
    lockoutAttempts: 3,
    lockoutMs: 30_000,
    passwordIterations: TEST_ITERATIONS,
    sessionTtlSeconds: 7 * 24 * 60 * 60,
    now: clock.now,
  });
  return { accounts, clock, repository };
}

function createCountingCrypto() {
  let derivations = 0;
  return {
    api: {
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
      subtle: {
        deriveBits(...args) {
          derivations += 1;
          return globalThis.crypto.subtle.deriveBits(...args);
        },
        digest: globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle),
        importKey: globalThis.crypto.subtle.importKey.bind(globalThis.crypto.subtle),
      },
    },
    count() {
      return derivations;
    },
  };
}

async function rejectionDetails(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return { code: error.code, message: error.message, status: error.status };
  }
}

async function createWorker(accounts, overrides = {}) {
  return accounts.createAccount({
    username: overrides.username || 'workshop',
    displayName: overrides.displayName || 'Workshop',
    role: overrides.role || 'worker',
    temporaryPassword: overrides.temporaryPassword || 'temporary-passphrase',
  });
}

test('creates and verifies a versioned password hash without storing plaintext', async () => {
  assert.ok(PRODUCTION_PBKDF2_ITERATIONS >= 100_000);
  const encoded = await hashPassword('temporary-passphrase', { iterations: TEST_ITERATIONS });

  assert.match(encoded, /^pbkdf2-sha256\$v1\$1000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(encoded.includes('temporary-passphrase'), false);
  assert.equal(await verifyPassword('temporary-passphrase', encoded), true);
  assert.equal(await verifyPassword('wrong-passphrase', encoded), false);
  assert.equal(await verifyPassword('temporary-passphrase', 'not-a-password-hash'), false);
  await assert.rejects(
    hashPassword('too-short', { iterations: TEST_ITERATIONS }),
    /at least 12 characters/i,
  );
});

test('generates opaque session credentials and strict host-only cookie headers', async () => {
  const credential = await createSessionCredential();

  assert.match(credential.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(credential.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(credential.token, credential.digest);
  assert.equal(
    serializeSessionCookie(credential.token),
    '__Host-lightweaver_session=' + credential.token
      + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800',
  );
  assert.equal(
    serializeSessionCookieRemoval(),
    '__Host-lightweaver_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0',
  );
  assert.equal(SESSION_COOKIE_NAME, '__Host-lightweaver_session');
  assert.equal(readSessionCookie(new Headers({
    cookie: `theme=dark; ${SESSION_COOKIE_NAME}=${credential.token}; compact=true`,
  })), credential.token);
  assert.equal(readSessionCookie(new Headers()), null);
});

test('normalizes unique usernames, fixes roles, and never lists credential fields', async () => {
  const { accounts } = setup();
  const created = await createWorker(accounts, { username: '  WorkShop  ' });

  assert.equal(created.username, 'workshop');
  assert.equal(created.role, 'worker');
  assert.equal(created.status, 'active');
  assert.equal(created.mustChangePassword, true);
  assert.equal('passwordHash' in created, false);
  assert.equal('failedLoginAttempts' in created, false);
  assert.deepEqual(await accounts.listAccounts(), [created]);

  await assert.rejects(
    createWorker(accounts, { username: 'WORKSHOP' }),
    error => error instanceof AccountStoreError && error.code === 'username_taken',
  );
  await assert.rejects(
    createWorker(accounts, { username: 'different', role: 'administrator' }),
    error => error instanceof AccountStoreError && error.code === 'invalid_role',
  );
});

test('returns one generic login error for unknown and incorrect credentials', async () => {
  const { accounts } = setup();
  await createWorker(accounts);

  const missing = await rejectionDetails(() => accounts.verifyLogin({
    username: 'missing',
    password: 'wrong-passphrase',
  }));
  const incorrect = await rejectionDetails(() => accounts.verifyLogin({
    username: 'workshop',
    password: 'wrong-passphrase',
  }));

  assert.deepEqual(missing, incorrect);
  assert.deepEqual(missing, {
    code: 'invalid_credentials',
    message: 'Invalid username or password.',
    status: 401,
  });
});

test('applies a short failed-login lockout and clears failures after success', async () => {
  const { accounts, clock } = setup();
  await createWorker(accounts);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(accounts.verifyLogin({
      username: 'workshop',
      password: 'wrong-passphrase',
    }), { code: 'invalid_credentials' });
  }
  await assert.rejects(accounts.verifyLogin({
    username: 'workshop',
    password: 'temporary-passphrase',
  }), { code: 'invalid_credentials' });

  clock.advance(30_001);
  const identity = await accounts.verifyLogin({
    username: ' WORKSHOP ',
    password: 'temporary-passphrase',
  });
  assert.equal(identity.role, 'worker');
  assert.equal(identity.mustChangePassword, true);
});

test('atomically counts concurrent failed logins toward the lockout', async () => {
  const { accounts, clock } = setup();
  await createWorker(accounts);

  await Promise.all(Array.from({ length: 20 }, () => assert.rejects(accounts.verifyLogin({
    username: 'workshop',
    password: 'wrong-passphrase',
  }), { code: 'invalid_credentials' })));
  await assert.rejects(accounts.verifyLogin({
    username: 'workshop',
    password: 'temporary-passphrase',
  }), { code: 'invalid_credentials' });

  clock.advance(30_001);
  assert.equal((await accounts.verifyLogin({
    username: 'workshop',
    password: 'temporary-passphrase',
  })).role, 'worker');
});

test('does one comparable password derivation for every rejected login state', async () => {
  const countingCrypto = createCountingCrypto();
  const { accounts } = setup({ crypto: countingCrypto.api });
  const worker = await createWorker(accounts);
  await accounts.setAccountStatus({ id: worker.id, status: 'disabled' });

  const beforeUnknown = countingCrypto.count();
  await assert.rejects(accounts.verifyLogin({
    username: 'missing',
    password: 'wrong-passphrase',
  }), { code: 'invalid_credentials' });
  const unknownDerivations = countingCrypto.count() - beforeUnknown;

  const beforeDisabled = countingCrypto.count();
  await assert.rejects(accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  }), { code: 'invalid_credentials' });
  const disabledDerivations = countingCrypto.count() - beforeDisabled;

  assert.equal(unknownDerivations, 1);
  assert.equal(disabledDerivations, 1);
});

test('a cold account store does only one derivation for an unknown login', async () => {
  const countingCrypto = createCountingCrypto();
  const { accounts } = setup({ crypto: countingCrypto.api });
  const beforeLogin = countingCrypto.count();

  await assert.rejects(accounts.verifyLogin({
    username: 'missing',
    password: 'wrong-passphrase',
  }), { code: 'invalid_credentials' });

  assert.equal(countingCrypto.count() - beforeLogin, 1);
});

test('persists only a session digest and authenticates active unexpired sessions', async () => {
  const { accounts, repository } = setup();
  const worker = await createWorker(accounts);
  const session = await accounts.createSession(worker.id);
  const storedSessions = repository.snapshot().sessions;

  assert.deepEqual(Object.keys(session).sort(), ['expiresAt', 'token']);
  assert.equal(storedSessions.length, 1);
  assert.equal(storedSessions[0].token_hash, await hashSessionToken(session.token));
  assert.equal(JSON.stringify(storedSessions).includes(session.token), false);
  assert.equal((await accounts.authenticateSession(session.token)).role, 'worker');

  await accounts.revokeSession(session.token);
  assert.equal(await accounts.authenticateSession(session.token), null);
});

test('denies expired or disabled sessions and revokes sessions on role changes', async () => {
  const { accounts, clock } = setup();
  const worker = await createWorker(accounts);

  const expired = await accounts.createSession(worker.id, { ttlSeconds: 1 });
  clock.advance(1_001);
  assert.equal(await accounts.authenticateSession(expired.token), null);

  const disabled = await accounts.createSession(worker.id);
  const disabledAccount = await accounts.setAccountStatus({ id: worker.id, status: 'disabled' });
  assert.equal(disabledAccount.status, 'disabled');
  assert.equal(await accounts.authenticateSession(disabled.token), null);
  await assert.rejects(accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  }), { code: 'invalid_credentials' });

  await accounts.setAccountStatus({ id: worker.id, status: 'active' });
  const changedRole = await accounts.createSession(worker.id);
  const customer = await accounts.setAccountRole({ id: worker.id, role: 'customer' });
  assert.equal(customer.role, 'customer');
  assert.equal(await accounts.authenticateSession(changedRole.token), null);
});

test('password reset revokes sessions and password change clears forced-change state', async () => {
  const { accounts } = setup();
  const worker = await createWorker(accounts);
  const beforeReset = await accounts.createSession(worker.id);

  const reset = await accounts.resetPassword({
    id: worker.id,
    temporaryPassword: 'reset-passphrase-123',
  });
  assert.equal(reset.mustChangePassword, true);
  assert.equal(await accounts.authenticateSession(beforeReset.token), null);
  assert.equal((await accounts.verifyLogin({
    username: worker.username,
    password: 'reset-passphrase-123',
  })).accountId, worker.id);

  const beforeChange = await accounts.createSession(worker.id);
  const changed = await accounts.changePassword({
    accountId: worker.id,
    newPassword: 'personal-passphrase-456',
  });
  assert.equal(changed.mustChangePassword, false);
  assert.equal((await accounts.authenticateSession(beforeChange.token)).accountId, worker.id);
  assert.equal((await accounts.verifyLogin({
    username: worker.username,
    password: 'personal-passphrase-456',
  })).accountId, worker.id);
});

test('a failed atomic reset leaves both the old password and sessions intact', async () => {
  const repository = createMemoryAccountRepository();
  const accounts = setup({
    repository: {
      ...repository,
      async resetPasswordAndRevokeSessions() {
        throw new Error('injected atomic reset failure');
      },
    },
  }).accounts;
  const worker = await createWorker(accounts);
  const session = await accounts.createSession(worker.id);

  await assert.rejects(accounts.resetPassword({
    id: worker.id,
    temporaryPassword: 'replacement-passphrase',
  }), /injected atomic reset failure/);
  assert.equal((await accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  })).accountId, worker.id);
  assert.equal((await accounts.authenticateSession(session.token)).accountId, worker.id);
});

test('migration adds constrained accounts, hashed sessions, assignments, and draft markers', async () => {
  const migration = await readFile(
    new URL('../../../../migrations/0002_account_access.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS accounts/i);
  assert.match(migration, /normalized_username TEXT NOT NULL UNIQUE/i);
  assert.match(migration, /role TEXT NOT NULL CHECK \(role IN \('owner', 'worker', 'customer'\)\)/i);
  assert.match(migration, /status TEXT NOT NULL[^;]*CHECK \(status IN \('active', 'disabled'\)\)/is);
  assert.match(migration, /must_change_password INTEGER NOT NULL/i);
  assert.match(migration, /failed_login_attempts INTEGER NOT NULL/i);
  assert.match(migration, /locked_until TEXT/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS account_sessions/i);
  assert.match(migration, /token_hash TEXT PRIMARY KEY/i);
  assert.doesNotMatch(migration, /(?:^|\s)token TEXT/i);
  assert.match(migration, /expires_at TEXT NOT NULL/i);
  assert.match(migration, /revoked_at TEXT/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS project_assignments/i);
  assert.match(migration, /UNIQUE \(customer_account_id, project_id\)/i);
  assert.match(migration, /ADD COLUMN draft_of_project_id TEXT/i);
  assert.match(migration, /ADD COLUMN draft_owner_account_id TEXT/i);
  assert.match(migration, /CREATE (?:UNIQUE )?INDEX[^;]*draft_of_project_id/is);
  assert.match(migration, /CREATE (?:UNIQUE )?INDEX[^;]*draft_owner_account_id/is);
});
