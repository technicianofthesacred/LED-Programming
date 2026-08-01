import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Miniflare } from 'miniflare';

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
  createD1AccountStore,
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

function createInitialSession(accounts, account, options = {}) {
  return accounts.createSession(account.id, {
    ...options,
    expectedGeneration: 0,
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

test('rejects overlong passwords before PBKDF2 work', async () => {
  const countingCrypto = createCountingCrypto();

  await assert.rejects(
    hashPassword('p'.repeat(257), {
      crypto: countingCrypto.api,
      iterations: TEST_ITERATIONS,
    }),
    /at most 256 characters/i,
  );
  assert.equal(countingCrypto.count(), 0);
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

test('validates account names before password derivation', async () => {
  const countingCrypto = createCountingCrypto();
  const { accounts } = setup({ crypto: countingCrypto.api });

  await assert.rejects(createWorker(accounts, {
    username: 'u'.repeat(65),
  }), { code: 'invalid_username', status: 400 });
  await assert.rejects(createWorker(accounts, {
    username: 'valid-worker',
    displayName: 'd'.repeat(81),
  }), { code: 'invalid_display_name', status: 400 });
  assert.equal(countingCrypto.count(), 0);
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
  const authenticated = await accounts.verifyLogin({
    username: ' WORKSHOP ',
    password: 'temporary-passphrase',
  });
  assert.equal(authenticated.identity.role, 'worker');
  assert.equal(authenticated.identity.mustChangePassword, true);
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
  })).identity.role, 'worker');
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
  const session = await createInitialSession(accounts, worker);
  const storedSessions = repository.snapshot().sessions;

  assert.deepEqual(Object.keys(session).sort(), ['expiresAt', 'token']);
  assert.equal(storedSessions.length, 1);
  assert.equal(storedSessions[0].token_hash, await hashSessionToken(session.token));
  assert.equal(JSON.stringify(storedSessions).includes(session.token), false);
  assert.equal((await accounts.authenticateSession(session.token)).role, 'worker');

  await accounts.revokeSession(session.token);
  assert.equal(await accounts.authenticateSession(session.token), null);
});

test('session authentication can return the generation proof for a sensitive mutation', async () => {
  const { accounts } = setup();
  const worker = await createWorker(accounts);
  const session = await createInitialSession(accounts, worker);

  const authenticated = await accounts.authenticateSession(session.token, {
    includeGeneration: true,
  });
  assert.deepEqual(authenticated, {
    identity: {
      accountId: worker.id,
      username: 'workshop',
      displayName: 'Workshop',
      role: 'worker',
      mustChangePassword: true,
      subject: `account:${worker.id}`,
    },
    observedGeneration: 0,
  });
});

test('session inserts cannot race past account security mutations', async t => {
  const mutations = [
    ['password reset', (accounts, id) => accounts.resetPassword({
      id,
      temporaryPassword: 'replacement-passphrase',
    })],
    ['status change', (accounts, id) => accounts.setAccountStatus({
      id,
      status: 'disabled',
    })],
    ['role change', (accounts, id) => accounts.setAccountRole({
      id,
      role: 'customer',
    })],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const baseRepository = createMemoryAccountRepository();
      let releaseInsert;
      let signalInsertStarted;
      const insertStarted = new Promise(resolve => { signalInsertStarted = resolve; });
      const insertReleased = new Promise(resolve => { releaseInsert = resolve; });
      const repository = {
        ...baseRepository,
        async insertSessionForCurrentGeneration(row, generation) {
          signalInsertStarted();
          await insertReleased;
          return baseRepository.insertSessionForCurrentGeneration(row, generation);
        },
      };
      const { accounts } = setup({ repository });
      const worker = await createWorker(accounts);

      const pendingSession = createInitialSession(accounts, worker);
      await insertStarted;
      await mutate(accounts, worker.id);
      releaseInsert();

      await assert.rejects(pendingSession, { code: 'session_state_changed' });
    });
  }
});

test('authentication rejects a session captured from an older account generation', async () => {
  const baseRepository = createMemoryAccountRepository();
  let returnStaleGeneration = false;
  const repository = {
    ...baseRepository,
    async findSessionWithAccount(tokenHash) {
      const result = await baseRepository.findSessionWithAccount(tokenHash);
      if (returnStaleGeneration && result) result.account.session_generation += 1;
      return result;
    },
  };
  const { accounts } = setup({ repository });
  const worker = await createWorker(accounts);
  const session = await createInitialSession(accounts, worker);

  returnStaleGeneration = true;
  assert.equal(await accounts.authenticateSession(session.token), null);
});

test('session creation binds to the generation whose password was verified', async () => {
  const { accounts, repository } = setup();
  const worker = await createWorker(accounts);
  const authenticated = await accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  });

  assert.equal(typeof authenticated.observedGeneration, 'number');
  assert.equal('observedGeneration' in authenticated.identity, false);
  await accounts.resetPassword({
    id: worker.id,
    temporaryPassword: 'replacement-passphrase',
  });

  await assert.rejects(accounts.createSession(authenticated.identity.accountId, {
    expectedGeneration: authenticated.observedGeneration,
  }), { code: 'session_state_changed' });
  assert.equal(repository.snapshot().sessions.length, 0);
});

test('denies expired or disabled sessions and revokes sessions on role changes', async () => {
  const { accounts, clock } = setup();
  const worker = await createWorker(accounts);

  const expired = await createInitialSession(accounts, worker, { ttlSeconds: 1 });
  clock.advance(1_001);
  assert.equal(await accounts.authenticateSession(expired.token), null);

  const disabled = await createInitialSession(accounts, worker);
  const disabledAccount = await accounts.setAccountStatus({ id: worker.id, status: 'disabled' });
  assert.equal(disabledAccount.status, 'disabled');
  assert.equal(await accounts.authenticateSession(disabled.token), null);
  await assert.rejects(accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  }), { code: 'invalid_credentials' });

  await accounts.setAccountStatus({ id: worker.id, status: 'active' });
  const activeLogin = await accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  });
  const changedRole = await accounts.createSession(worker.id, {
    expectedGeneration: activeLogin.observedGeneration,
  });
  const customer = await accounts.setAccountRole({ id: worker.id, role: 'customer' });
  assert.equal(customer.role, 'customer');
  assert.equal(await accounts.authenticateSession(changedRole.token), null);
});

test('the sole active owner cannot be disabled or demoted', async () => {
  const { accounts } = setup();
  const owner = await createWorker(accounts, {
    username: 'owner',
    displayName: 'Owner',
    role: 'owner',
  });
  const session = await createInitialSession(accounts, owner);

  await assert.rejects(accounts.setAccountStatus({
    id: owner.id,
    status: 'disabled',
  }), { code: 'last_owner_required', status: 409 });
  await assert.rejects(accounts.setAccountRole({
    id: owner.id,
    role: 'worker',
  }), { code: 'last_owner_required', status: 409 });
  assert.deepEqual((await accounts.listAccounts()).map(account => ({
    role: account.role,
    status: account.status,
  })), [{ role: 'owner', status: 'active' }]);
  assert.equal((await accounts.authenticateSession(session.token)).accountId, owner.id);
});

test('one of two active owners may be disabled or demoted', async t => {
  for (const [name, mutate] of [
    ['disable', (accounts, id) => accounts.setAccountStatus({ id, status: 'disabled' })],
    ['demote', (accounts, id) => accounts.setAccountRole({ id, role: 'worker' })],
  ]) {
    await t.test(name, async () => {
      const { accounts } = setup();
      const first = await createWorker(accounts, {
        username: `${name}-owner-a`,
        displayName: 'Owner A',
        role: 'owner',
      });
      await createWorker(accounts, {
        username: `${name}-owner-b`,
        displayName: 'Owner B',
        role: 'owner',
      });

      await mutate(accounts, first.id);
      const activeOwners = (await accounts.listAccounts())
        .filter(account => account.role === 'owner' && account.status === 'active');
      assert.equal(activeOwners.length, 1);
    });
  }
});

test('concurrent owner mutations leave at least one active owner', async () => {
  const { accounts } = setup();
  const first = await createWorker(accounts, {
    username: 'owner-a',
    displayName: 'Owner A',
    role: 'owner',
  });
  const second = await createWorker(accounts, {
    username: 'owner-b',
    displayName: 'Owner B',
    role: 'owner',
  });

  const settled = await Promise.allSettled([
    accounts.setAccountStatus({ id: first.id, status: 'disabled' }),
    accounts.setAccountRole({ id: second.id, role: 'worker' }),
  ]);
  assert.deepEqual(settled.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(
    settled.find(result => result.status === 'rejected').reason.code,
    'last_owner_required',
  );
  const activeOwners = (await accounts.listAccounts())
    .filter(account => account.role === 'owner' && account.status === 'active');
  assert.equal(activeOwners.length, 1);
});

test('password reset revokes sessions and password change clears forced-change state', async () => {
  const { accounts } = setup();
  const worker = await createWorker(accounts);
  const beforeReset = await createInitialSession(accounts, worker);

  const reset = await accounts.resetPassword({
    id: worker.id,
    temporaryPassword: 'reset-passphrase-123',
  });
  assert.equal(reset.mustChangePassword, true);
  assert.equal(await accounts.authenticateSession(beforeReset.token), null);
  const resetLogin = await accounts.verifyLogin({
    username: worker.username,
    password: 'reset-passphrase-123',
  });
  assert.equal(resetLogin.identity.accountId, worker.id);

  const beforeChange = await accounts.createSession(worker.id, {
    expectedGeneration: resetLogin.observedGeneration,
  });
  const changed = await accounts.changePassword({
    accountId: worker.id,
    newPassword: 'personal-passphrase-456',
    expectedGeneration: resetLogin.observedGeneration,
  });
  assert.ok(changed.account, 'password change returns the updated account with its new generation');
  assert.equal(changed.account.mustChangePassword, false);
  assert.equal(changed.observedGeneration, resetLogin.observedGeneration + 1);
  assert.equal(await accounts.authenticateSession(beforeChange.token), null);
  const replacement = await accounts.createSession(worker.id, {
    expectedGeneration: changed.observedGeneration,
  });
  assert.equal((await accounts.authenticateSession(replacement.token)).accountId, worker.id);
  assert.equal((await accounts.verifyLogin({
    username: worker.username,
    password: 'personal-passphrase-456',
  })).identity.accountId, worker.id);
});

test('password change cannot overwrite a reset that invalidated its authenticated session', async () => {
  const { accounts, repository } = setup();
  const worker = await createWorker(accounts);
  const login = await accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  });
  const session = await accounts.createSession(worker.id, {
    expectedGeneration: login.observedGeneration,
  });
  const authenticated = await accounts.authenticateSession(session.token);
  assert.equal(authenticated.accountId, worker.id);

  await accounts.resetPassword({
    id: worker.id,
    temporaryPassword: 'replacement-passphrase',
  });
  await assert.rejects(accounts.changePassword({
    accountId: authenticated.accountId,
    newPassword: 'personal-passphrase-456',
    expectedGeneration: login.observedGeneration,
  }), { code: 'session_state_changed', status: 409 });

  assert.equal((await accounts.verifyLogin({
    username: worker.username,
    password: 'replacement-passphrase',
  })).identity.accountId, worker.id);
  await assert.rejects(accounts.verifyLogin({
    username: worker.username,
    password: 'personal-passphrase-456',
  }), { code: 'invalid_credentials' });
  assert.equal(repository.snapshot().sessions.some(row => !row.revoked_at), false);
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
  const session = await createInitialSession(accounts, worker);

  await assert.rejects(accounts.resetPassword({
    id: worker.id,
    temporaryPassword: 'replacement-passphrase',
  }), /injected atomic reset failure/);
  assert.equal((await accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  })).identity.accountId, worker.id);
  assert.equal((await accounts.authenticateSession(session.token)).accountId, worker.id);
});

test('migration adds constrained accounts, hashed sessions, assignments, and draft markers', async () => {
  const migration = (await Promise.all([
    '0002_account_access.sql',
    '0003_account_session_generation.sql',
  ].map(name => readFile(
    new URL(`../../../../migrations/${name}`, import.meta.url),
    'utf8',
  )))).join('\n');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS accounts/i);
  assert.match(migration, /normalized_username TEXT NOT NULL UNIQUE/i);
  assert.match(migration, /role TEXT NOT NULL CHECK \(role IN \('owner', 'worker', 'customer'\)\)/i);
  assert.match(migration, /status TEXT NOT NULL[^;]*CHECK \(status IN \('active', 'disabled'\)\)/is);
  assert.match(migration, /must_change_password INTEGER NOT NULL/i);
  assert.match(migration, /failed_login_attempts INTEGER NOT NULL/i);
  assert.match(migration, /session_generation INTEGER NOT NULL/i);
  assert.match(migration, /locked_until TEXT/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS account_sessions/i);
  assert.match(migration, /token_hash TEXT PRIMARY KEY/i);
  assert.doesNotMatch(migration, /(?:^|\s)token TEXT/i);
  assert.match(migration, /expires_at TEXT NOT NULL/i);
  assert.match(migration, /revoked_at TEXT/i);
  assert.match(migration, /account_generation INTEGER NOT NULL/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS project_assignments/i);
  assert.match(migration, /UNIQUE \(customer_account_id, project_id\)/i);
  assert.match(migration, /ADD COLUMN draft_of_project_id TEXT/i);
  assert.match(migration, /ADD COLUMN draft_owner_account_id TEXT/i);
  assert.match(migration, /CREATE (?:UNIQUE )?INDEX[^;]*draft_of_project_id/is);
  assert.match(migration, /CREATE (?:UNIQUE )?INDEX[^;]*draft_owner_account_id/is);
});

test('D1 applies account migrations and preserves atomic lockout and reset behavior', async t => {
  const miniflare = new Miniflare({
    compatibilityDate: '2026-07-15',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['PROJECTS_DB'],
  });
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database('PROJECTS_DB');
  for (const migrationName of [
    '0001_cloud_project_library.sql',
    '0002_account_access.sql',
    '0003_account_session_generation.sql',
  ]) {
    const migration = await readFile(
      new URL(`../../../../migrations/${migrationName}`, import.meta.url),
      'utf8',
    );
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  const accountColumns = (await db.prepare('PRAGMA table_info(accounts)').all()).results;
  const sessionColumns = (await db.prepare('PRAGMA table_info(account_sessions)').all()).results;
  assert.equal(accountColumns.some(column => column.name === 'session_generation'), true);
  assert.equal(sessionColumns.some(column => column.name === 'account_generation'), true);

  const clock = createClock();
  const accounts = createD1AccountStore({ PROJECTS_DB: db }, {
    lockoutAttempts: 3,
    lockoutMs: 30_000,
    now: clock.now,
    passwordIterations: TEST_ITERATIONS,
  });
  const worker = await createWorker(accounts);
  await Promise.all(Array.from({ length: 10 }, () => assert.rejects(accounts.verifyLogin({
    username: worker.username,
    password: 'wrong-passphrase',
  }), { code: 'invalid_credentials' })));
  const locked = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(worker.id).first();
  assert.ok(locked.failed_login_attempts >= 3);
  assert.equal(typeof locked.locked_until, 'string');

  clock.advance(30_001);
  const login = await accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  });
  const session = await accounts.createSession(worker.id, {
    expectedGeneration: login.observedGeneration,
  });
  await db.prepare(`
    CREATE TRIGGER fail_session_revocation
    BEFORE UPDATE OF revoked_at ON account_sessions
    BEGIN SELECT RAISE(FAIL, 'injected revocation failure'); END
  `).run();
  await assert.rejects(accounts.resetPassword({
    id: worker.id,
    temporaryPassword: 'replacement-passphrase',
  }), /injected revocation failure/);
  assert.equal((await accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  })).identity.accountId, worker.id);
  assert.equal((await accounts.authenticateSession(session.token)).accountId, worker.id);
});

test('D1 rejects a password change authenticated before a concurrent owner reset', async t => {
  const miniflare = new Miniflare({
    compatibilityDate: '2026-07-15',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['PROJECTS_DB'],
  });
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database('PROJECTS_DB');
  for (const migrationName of [
    '0001_cloud_project_library.sql',
    '0002_account_access.sql',
    '0003_account_session_generation.sql',
  ]) {
    const migration = await readFile(
      new URL(`../../../../migrations/${migrationName}`, import.meta.url),
      'utf8',
    );
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  const accounts = createD1AccountStore({ PROJECTS_DB: db }, {
    now: () => '2026-08-01T00:00:00.000Z',
    passwordIterations: TEST_ITERATIONS,
  });
  const worker = await createWorker(accounts);
  const login = await accounts.verifyLogin({
    username: worker.username,
    password: 'temporary-passphrase',
  });
  const session = await accounts.createSession(worker.id, {
    expectedGeneration: login.observedGeneration,
  });
  const authenticated = await accounts.authenticateSession(session.token);

  await accounts.resetPassword({
    id: worker.id,
    temporaryPassword: 'replacement-passphrase',
  });
  await assert.rejects(accounts.changePassword({
    accountId: authenticated.accountId,
    newPassword: 'personal-passphrase-456',
    expectedGeneration: login.observedGeneration,
  }), { code: 'session_state_changed', status: 409 });

  assert.equal((await accounts.verifyLogin({
    username: worker.username,
    password: 'replacement-passphrase',
  })).identity.accountId, worker.id);
  await assert.rejects(accounts.verifyLogin({
    username: worker.username,
    password: 'personal-passphrase-456',
  }), { code: 'invalid_credentials' });
  const activeSessions = await db.prepare(`
    SELECT COUNT(*) AS count FROM account_sessions WHERE revoked_at IS NULL
  `).first();
  assert.equal(activeSessions.count, 0);
});

test('D1 serializes concurrent owner mutations around the final active owner', async t => {
  const miniflare = new Miniflare({
    compatibilityDate: '2026-07-15',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['PROJECTS_DB'],
  });
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database('PROJECTS_DB');
  for (const migrationName of [
    '0001_cloud_project_library.sql',
    '0002_account_access.sql',
    '0003_account_session_generation.sql',
  ]) {
    const migration = await readFile(
      new URL(`../../../../migrations/${migrationName}`, import.meta.url),
      'utf8',
    );
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }

  const accounts = createD1AccountStore({ PROJECTS_DB: db }, {
    now: () => '2026-08-01T00:00:00.000Z',
    passwordIterations: TEST_ITERATIONS,
  });
  const first = await createWorker(accounts, {
    username: 'owner-a',
    displayName: 'Owner A',
    role: 'owner',
  });
  const second = await createWorker(accounts, {
    username: 'owner-b',
    displayName: 'Owner B',
    role: 'owner',
  });

  const settled = await Promise.allSettled([
    accounts.setAccountStatus({ id: first.id, status: 'disabled' }),
    accounts.setAccountRole({ id: second.id, role: 'worker' }),
  ]);
  assert.deepEqual(settled.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(
    settled.find(result => result.status === 'rejected').reason.code,
    'last_owner_required',
  );
  const result = await db.prepare(`
    SELECT COUNT(*) AS count FROM accounts WHERE role = 'owner' AND status = 'active'
  `).first();
  assert.equal(result.count, 1);
});
