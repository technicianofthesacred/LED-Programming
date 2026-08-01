import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAccountPagesRequest } from '../account/[[path]].js';
import {
  LIBRARY_BACKUP_FORMAT,
  LIBRARY_BACKUP_VERSION,
} from './_shared/backup.js';
import {
  createAccountStore,
  createMemoryAccountRepository,
} from './_shared/accountStore.js';
import { createMemoryLibraryStore } from './_shared/memoryStore.js';
import { handleLibraryRequest } from './_shared/router.js';
import {
  validateMasterBackup,
  validatePortableProject,
} from './_shared/validation.js';

const MAX_BYTES = 1024 * 1024;

function createAccountFixture() {
  const repository = createMemoryAccountRepository();
  const accountStore = createAccountStore(repository, {
    passwordIterations: 1,
    now: () => '2026-08-01T00:00:00.000Z',
  });
  return { accountStore, repository };
}

async function callAccount(accountStore, path, {
  method = 'GET',
  body,
  cookie,
  contentType = body === undefined ? null : 'application/json',
  contentLength,
  origin = 'https://led.mandalacodes.com',
  rawBody,
} = {}) {
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);
  if (cookie) headers.set('cookie', cookie);
  if (contentType) headers.set('content-type', contentType);
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  const requestBody = rawBody === undefined
    ? body === undefined ? undefined : JSON.stringify(body)
    : rawBody;
  const response = await handleAccountPagesRequest({
    request: new Request(`https://led.mandalacodes.com/api/account${path}`, {
      method,
      headers,
      body: requestBody,
    }),
    env: {},
    params: {},
  }, { accountStore });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { response, payload: await response.json() };
}

function cookiePair(response) {
  return response.headers.get('set-cookie').split(';', 1)[0];
}

test('account login verifies credentials and issues a strict host-only session cookie', async () => {
  const { accountStore } = createAccountFixture();
  await accountStore.createAccount({
    username: 'workshop',
    displayName: 'Workshop',
    role: 'worker',
    temporaryPassword: 'temporary-passphrase',
  });

  const { response, payload } = await callAccount(accountStore, '/login', {
    method: 'POST',
    body: { username: 'workshop', password: 'temporary-passphrase' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(payload.session, {
    username: 'workshop',
    displayName: 'Workshop',
    role: 'worker',
    mustChangePassword: true,
  });
  assert.match(
    response.headers.get('set-cookie'),
    /^__Host-lightweaver_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800$/,
  );
});

test('account login keeps credential failures generic and requires exact same-origin JSON', async () => {
  const { accountStore } = createAccountFixture();
  await accountStore.createAccount({
    username: 'workshop',
    displayName: 'Workshop',
    role: 'worker',
    temporaryPassword: 'temporary-passphrase',
  });

  const unknown = await callAccount(accountStore, '/login', {
    method: 'POST',
    body: { username: 'missing', password: 'wrong-passphrase' },
  });
  const incorrect = await callAccount(accountStore, '/login', {
    method: 'POST',
    body: { username: 'workshop', password: 'wrong-passphrase' },
  });
  assert.equal(unknown.response.status, 401);
  assert.deepEqual(unknown.payload, incorrect.payload);

  for (const origin of [null, 'https://evil.example', 'https://led.mandalacodes.com:443']) {
    const denied = await callAccount(accountStore, '/login', {
      method: 'POST',
      body: { username: 'workshop', password: 'temporary-passphrase' },
      origin,
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.payload.error.code, 'invalid_origin');
  }

  const wrongType = await callAccount(accountStore, '/login', {
    method: 'POST',
    body: { username: 'workshop', password: 'temporary-passphrase' },
    contentType: 'text/plain',
  });
  assert.equal(wrongType.response.status, 415);
  assert.equal(wrongType.payload.error.code, 'invalid_request');
});

test('account login rejects declared and actual oversized JSON before credential work', async () => {
  let loginCalls = 0;
  const accountStore = {
    async verifyLogin() {
      loginCalls += 1;
      throw new Error('credential work must not run');
    },
  };
  const declared = await callAccount(accountStore, '/login', {
    method: 'POST',
    body: { username: 'workshop', password: 'temporary-passphrase' },
    contentLength: 8 * 1024 + 1,
  });
  assert.equal(declared.response.status, 413);
  assert.equal(declared.payload.error.code, 'payload_too_large');

  const actual = await callAccount(accountStore, '/login', {
    method: 'POST',
    rawBody: JSON.stringify({
      username: 'workshop',
      password: 'x'.repeat(8 * 1024),
    }),
    contentType: 'application/json',
  });
  assert.equal(actual.response.status, 413);
  assert.equal(actual.payload.error.code, 'payload_too_large');
  assert.equal(loginCalls, 0);
});

test('account login rejects overlong credentials before credential work', async () => {
  let loginCalls = 0;
  const accountStore = {
    async verifyLogin() {
      loginCalls += 1;
      throw new Error('credential work must not run');
    },
  };

  for (const body of [
    { username: 'u'.repeat(65), password: 'temporary-passphrase' },
    { username: 'workshop', password: 'p'.repeat(257) },
  ]) {
    const denied = await callAccount(accountStore, '/login', { method: 'POST', body });
    assert.equal(denied.response.status, 400);
    assert.equal(denied.payload.error.code, 'invalid_request');
  }
  assert.equal(loginCalls, 0);
});

test('account session, password change, and logout rotate then revoke the cookie session', async () => {
  const { accountStore } = createAccountFixture();
  await accountStore.createAccount({
    username: 'workshop',
    displayName: 'Workshop',
    role: 'worker',
    temporaryPassword: 'temporary-passphrase',
  });
  const login = await callAccount(accountStore, '/login', {
    method: 'POST',
    body: { username: 'workshop', password: 'temporary-passphrase' },
  });
  const initialCookie = cookiePair(login.response);

  for (const path of ['/password', '/logout']) {
    const denied = await callAccount(accountStore, path, {
      method: 'POST',
      cookie: initialCookie,
      body: path === '/password' ? { password: 'personal-passphrase-456' } : {},
      origin: null,
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.payload.error.code, 'invalid_origin');
  }

  const forced = await callAccount(accountStore, '/session', { cookie: initialCookie });
  assert.equal(forced.response.status, 200);
  assert.deepEqual(forced.payload.session, {
    username: 'workshop',
    displayName: 'Workshop',
    role: 'worker',
    mustChangePassword: true,
  });

  const changed = await callAccount(accountStore, '/password', {
    method: 'POST',
    cookie: initialCookie,
    body: { password: 'personal-passphrase-456' },
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.payload.session.mustChangePassword, false);
  const replacementCookie = cookiePair(changed.response);
  assert.notEqual(replacementCookie, initialCookie);
  assert.equal((await callAccount(accountStore, '/session', {
    cookie: initialCookie,
  })).response.status, 401);
  assert.equal((await callAccount(accountStore, '/session', {
    cookie: replacementCookie,
  })).payload.session.mustChangePassword, false);

  const loggedOut = await callAccount(accountStore, '/logout', {
    method: 'POST',
    cookie: replacementCookie,
    body: {},
  });
  assert.equal(loggedOut.response.status, 200);
  assert.deepEqual(loggedOut.payload, { loggedOut: true });
  assert.equal(
    loggedOut.response.headers.get('set-cookie'),
    '__Host-lightweaver_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0',
  );
  assert.equal((await callAccount(accountStore, '/session', {
    cookie: replacementCookie,
  })).response.status, 401);
});

test('account password route does not replace an owner reset raced after session authentication', async () => {
  const { accountStore, repository } = createAccountFixture();
  const worker = await accountStore.createAccount({
    username: 'workshop',
    displayName: 'Workshop',
    role: 'worker',
    temporaryPassword: 'temporary-passphrase',
  });
  const login = await callAccount(accountStore, '/login', {
    method: 'POST',
    body: { username: worker.username, password: 'temporary-passphrase' },
  });
  const initialCookie = cookiePair(login.response);
  let resetInjected = false;
  const racingStore = {
    ...accountStore,
    async changePassword(values) {
      if (!resetInjected) {
        resetInjected = true;
        await accountStore.resetPassword({
          id: worker.id,
          temporaryPassword: 'replacement-passphrase',
        });
      }
      return accountStore.changePassword(values);
    },
  };

  const raced = await callAccount(racingStore, '/password', {
    method: 'POST',
    cookie: initialCookie,
    body: { password: 'personal-passphrase-456' },
  });
  assert.equal(raced.response.status, 409);
  assert.equal(raced.payload.error.code, 'session_state_changed');
  assert.equal(raced.response.headers.get('set-cookie'), null);
  assert.equal((await accountStore.verifyLogin({
    username: worker.username,
    password: 'replacement-passphrase',
  })).identity.accountId, worker.id);
  await assert.rejects(accountStore.verifyLogin({
    username: worker.username,
    password: 'personal-passphrase-456',
  }), { code: 'invalid_credentials' });
  assert.equal(repository.snapshot().sessions.some(row => !row.revoked_at), false);
});

function portableProject({ id = 'lwproj-contract', name = 'Contract Project', brightness = 1 } = {}) {
  return {
    version: 3,
    id,
    name,
    layout: {
      strips: [],
      starterPending: false,
      viewBox: '0 0 640 400',
    },
    pattern: {
      activePatternId: 'aurora',
      masterBrightness: brightness,
    },
    show: {},
    live: {},
    devices: {},
  };
}

async function call(store, {
  role = 'worker',
  email = 'worker@example.test',
  identity,
  method = 'GET',
  path = '/projects',
  body,
  origin = 'https://led.mandalacodes.com',
  requestId = crypto.randomUUID(),
  maxBytes = MAX_BYTES,
  maxBackupBytes,
  accountStore,
} = {}) {
  const hasBody = body !== undefined;
  const headers = new Headers({ 'x-lightweaver-request': requestId });
  if (hasBody) headers.set('content-type', 'application/json');
  if (origin !== null) headers.set('origin', origin);
  const response = await handleLibraryRequest({
    request: new Request(`https://led.mandalacodes.com/api/library${path}`, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body) : undefined,
    }),
    identity: identity === undefined
      ? role ? { email, role, subject: `${role}-subject` } : null
      : identity,
    store,
    accountStore,
    maxBytes,
    maxBackupBytes,
  });
  const payload = (response.headers.get('content-type') || '').startsWith('application/json')
    ? await response.json()
    : null;
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { response, payload };
}

async function activeNativeIdentity(accountStore, account, password) {
  const authenticated = await accountStore.verifyLogin({
    username: account.username,
    password: 'temporary-passphrase',
  });
  const changed = await accountStore.changePassword({
    accountId: account.id,
    newPassword: password,
    expectedGeneration: authenticated.observedGeneration,
  });
  return {
    accountId: changed.account.id,
    username: changed.account.username,
    displayName: changed.account.displayName,
    role: changed.account.role,
    mustChangePassword: changed.account.mustChangePassword,
    subject: `account:${changed.account.id}`,
  };
}

test('forced-change native sessions can inspect session but cannot use the library', async () => {
  const { accountStore } = createAccountFixture();
  const owner = await accountStore.createAccount({
    username: 'owner',
    displayName: 'Studio Owner',
    role: 'owner',
    temporaryPassword: 'temporary-passphrase',
  });
  const identity = {
    accountId: owner.id,
    username: owner.username,
    displayName: owner.displayName,
    role: owner.role,
    mustChangePassword: true,
    subject: `account:${owner.id}`,
  };

  const session = await call(createMemoryLibraryStore(), {
    identity,
    path: '/session',
    accountStore,
  });
  assert.equal(session.response.status, 200);
  assert.deepEqual(session.payload.session, {
    username: 'owner',
    displayName: 'Studio Owner',
    role: 'owner',
    mustChangePassword: true,
  });

  for (const path of ['/login', '/projects', '/accounts']) {
    const denied = await call(createMemoryLibraryStore(), { identity, path, accountStore });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.payload.error.code, 'password_change_required');
  }
});

test('native library mutations use the display name and username as the audit label', async () => {
  const { accountStore } = createAccountFixture();
  const workerAccount = await accountStore.createAccount({
    username: 'workshop',
    displayName: 'Workshop Team',
    role: 'worker',
    temporaryPassword: 'temporary-passphrase',
  });
  const worker = await activeNativeIdentity(
    accountStore,
    workerAccount,
    'personal-passphrase-456',
  );
  const created = await call(createMemoryLibraryStore(), {
    identity: worker,
    accountStore,
    method: 'POST',
    path: '/projects',
    body: { title: 'Native audit', project: portableProject({ id: 'native-audit' }) },
  });

  assert.equal(created.response.status, 201);
  assert.equal(created.payload.project.createdBy, 'Workshop Team (workshop)');
});

test('owner account administration creates, lists, resets, disables, and changes roles without secrets', async () => {
  const { accountStore, repository } = createAccountFixture();
  const ownerAccount = await accountStore.createAccount({
    username: 'owner',
    displayName: 'Studio Owner',
    role: 'owner',
    temporaryPassword: 'temporary-passphrase',
  });
  const owner = await activeNativeIdentity(accountStore, ownerAccount, 'owner-passphrase-456');

  const wrongOrigin = await call(null, {
    identity: owner,
    accountStore,
    method: 'POST',
    path: '/accounts',
    origin: 'https://evil.example',
    body: {
      username: 'blocked',
      displayName: 'Blocked',
      role: 'worker',
      temporaryPassword: 'temporary-passphrase',
    },
  });
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.payload.error.code, 'invalid_origin');

  const created = await call(null, {
    identity: owner,
    accountStore,
    method: 'POST',
    path: '/accounts',
    body: {
      username: 'workshop',
      displayName: 'Workshop',
      role: 'worker',
      temporaryPassword: 'temporary-passphrase',
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.account.mustChangePassword, true);
  assert.doesNotMatch(JSON.stringify(created.payload), /temporary-passphrase|password_hash|passwordHash/i);
  const workerId = created.payload.account.id;

  const workerLogin = await accountStore.verifyLogin({
    username: 'workshop',
    password: 'temporary-passphrase',
  });
  const workerSession = await accountStore.createSession(workerId, {
    expectedGeneration: workerLogin.observedGeneration,
  });

  const roleChanged = await call(null, {
    identity: owner,
    accountStore,
    method: 'POST',
    path: `/accounts/${workerId}/role`,
    body: { role: 'customer' },
  });
  assert.equal(roleChanged.response.status, 200);
  assert.equal(roleChanged.payload.account.role, 'customer');
  assert.equal(await accountStore.authenticateSession(workerSession.token), null);

  const reset = await call(null, {
    identity: owner,
    accountStore,
    method: 'POST',
    path: `/accounts/${workerId}/reset`,
    body: { temporaryPassword: 'replacement-passphrase' },
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.payload.account.mustChangePassword, true);

  const disabled = await call(null, {
    identity: owner,
    accountStore,
    method: 'POST',
    path: `/accounts/${workerId}/status`,
    body: { status: 'disabled' },
  });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.payload.account.status, 'disabled');

  const listed = await call(null, {
    identity: owner,
    accountStore,
    path: '/accounts',
  });
  assert.equal(listed.response.status, 200);
  assert.deepEqual(
    listed.payload.accounts.map(account => account.username).sort(),
    ['owner', 'workshop'],
  );
  for (const account of listed.payload.accounts) {
    assert.deepEqual(Object.keys(account).sort(), [
      'createdAt',
      'displayName',
      'id',
      'mustChangePassword',
      'role',
      'status',
      'updatedAt',
      'username',
    ]);
  }
  assert.equal(repository.snapshot().accounts.length, 2);
});

test('workers and customers receive forbidden for every owner account administration route', async () => {
  const { accountStore } = createAccountFixture();
  const identities = ['worker', 'customer'].map(role => ({
    accountId: `${role}-id`,
    username: role,
    displayName: role === 'worker' ? 'Workshop' : 'Customer',
    role,
    mustChangePassword: false,
    subject: `account:${role}-id`,
  }));
  const routes = [
    ['GET', '/accounts', undefined],
    ['POST', '/accounts', {
      username: 'someone', displayName: 'Someone', role: 'worker', temporaryPassword: 'temporary-passphrase',
    }],
    ['POST', '/accounts/account-id/reset', { temporaryPassword: 'replacement-passphrase' }],
    ['POST', '/accounts/account-id/status', { status: 'disabled' }],
    ['POST', '/accounts/account-id/role', { role: 'owner' }],
  ];

  for (const identity of identities) {
    for (const [method, path, body] of routes) {
      const denied = await call(null, { identity, accountStore, method, path, body });
      assert.equal(denied.response.status, 403, `${identity.role} ${method} ${path}`);
      assert.equal(denied.payload.error.code, 'forbidden');
    }
  }
});

test('bootstrap creates exactly one first owner from verified Access owner identity', async () => {
  const accessOwner = {
    email: 'owner@example.test',
    role: 'owner',
    subject: 'access-owner',
  };
  const body = {
    username: 'owner',
    displayName: 'Studio Owner',
    temporaryPassword: 'temporary-passphrase',
  };
  const firstFixture = createAccountFixture();
  const created = await call(null, {
    identity: accessOwner,
    accountStore: firstFixture.accountStore,
    method: 'POST',
    path: '/accounts/bootstrap',
    body,
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.account.role, 'owner');
  assert.equal(created.payload.account.mustChangePassword, true);

  const repeated = await call(null, {
    identity: accessOwner,
    accountStore: firstFixture.accountStore,
    method: 'POST',
    path: '/accounts/bootstrap',
    body: { ...body, username: 'other-owner' },
  });
  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.payload.error.code, 'bootstrap_already_completed');
  assert.equal(firstFixture.repository.snapshot().accounts.length, 1);

  const deniedIdentities = [
    null,
    { email: 'worker@example.test', role: 'worker', subject: 'access-worker' },
    {
      accountId: 'native-owner',
      username: 'native-owner',
      displayName: 'Native Owner',
      role: 'owner',
      mustChangePassword: false,
      subject: 'account:native-owner',
    },
  ];
  for (const identity of deniedIdentities) {
    const fixture = createAccountFixture();
    const denied = await call(null, {
      identity,
      role: null,
      accountStore: fixture.accountStore,
      method: 'POST',
      path: '/accounts/bootstrap',
      body,
    });
    assert.equal(denied.response.status, identity ? 403 : 401);
    assert.equal(fixture.repository.snapshot().accounts.length, 0);
  }
});

async function createRemoteProject(store, overrides = {}) {
  const result = await call(store, {
    method: 'POST',
    path: '/projects',
    body: {
      title: overrides.title || 'Cloud Mandala',
      project: overrides.project || portableProject(),
    },
  });
  assert.equal(result.response.status, 201);
  return result.payload.project;
}

test('rejects unauthenticated requests with a bounded content-free error', async () => {
  const { response, payload } = await call(createMemoryLibraryStore(), {
    role: null,
    path: '/projects/not-secret',
  });

  assert.equal(response.status, 401);
  assert.deepEqual(Object.keys(payload), ['error']);
  assert.equal(payload.error.code, 'unauthenticated');
  assert.equal(typeof payload.error.requestId, 'string');
  assert.doesNotMatch(JSON.stringify(payload), /not-secret|layout|pattern/i);
});

test('returns the authenticated owner or worker session', async () => {
  const worker = await call(createMemoryLibraryStore(), { path: '/session' });
  const owner = await call(createMemoryLibraryStore(), {
    role: 'owner',
    email: 'owner@example.test',
    path: '/session',
  });

  assert.equal(worker.response.status, 200);
  assert.deepEqual(worker.payload.session, {
    email: 'worker@example.test',
    role: 'worker',
  });
  assert.deepEqual(owner.payload.session, {
    email: 'owner@example.test',
    role: 'owner',
  });
});

test('protected login returns a no-store same-origin redirect to a sanitized Studio path', async () => {
  const safe = await call(null, {
    path: '/login?returnTo=%2F%3Fmode%3Dedit%23screen%3Dcard%26section%3Dpreferences',
  });

  assert.equal(safe.response.status, 302);
  assert.equal(safe.response.headers.get('location'), '/?mode=edit#screen=card&section=preferences');
  assert.equal(safe.payload, null);

  for (const returnTo of [
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example/steal',
    '/%0d%0aLocation:%20https://evil.example',
    'preferences',
  ]) {
    const result = await call(null, {
      path: `/login?returnTo=${encodeURIComponent(returnTo)}`,
    });
    assert.equal(result.response.status, 302, returnTo);
    assert.equal(result.response.headers.get('location'), '/', returnTo);
  }
});

test('login remains Access-protected and rejects non-GET requests', async () => {
  const unauthenticated = await call(null, { role: null, path: '/login?returnTo=%2Fprivate' });
  const wrongMethod = await call(null, { method: 'POST', path: '/login', body: {} });

  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.payload.error.code, 'unauthenticated');
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.payload.error.code, 'method_not_allowed');
});

test('worker can create, list, open, and update a portable project', async () => {
  const store = createMemoryLibraryStore();
  const created = await createRemoteProject(store);

  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.title, 'Cloud Mandala');
  assert.equal(created.revision, 1);
  assert.equal(created.embeddedProjectId, 'lwproj-contract');

  const listed = await call(store, { path: '/projects?state=active' });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.payload.projects.length, 1);
  assert.equal(listed.payload.projects[0].id, created.id);
  assert.equal('document' in listed.payload.projects[0], false);

  const opened = await call(store, { path: `/projects/${created.id}` });
  assert.equal(opened.response.status, 200);
  assert.equal(opened.payload.project.document.id, 'lwproj-contract');

  const changed = portableProject({ brightness: 0.42 });
  const updated = await call(store, {
    method: 'PUT',
    path: `/projects/${created.id}`,
    body: { baseRevision: 1, title: 'Cloud Mandala Edited', project: changed },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.project.revision, 2);
  assert.equal(updated.payload.project.title, 'Cloud Mandala Edited');

  const reopened = await call(store, { path: `/projects/${created.id}` });
  assert.equal(reopened.payload.project.document.pattern.masterBrightness, 0.42);
});

test('owner has the same create, list, open, and update access', async () => {
  const store = createMemoryLibraryStore();
  const created = await call(store, {
    role: 'owner',
    email: 'owner@example.test',
    method: 'POST',
    path: '/projects',
    body: { title: 'Owner Work', project: portableProject({ id: 'owner-work' }) },
  });
  const id = created.payload.project.id;

  assert.equal(created.response.status, 201);
  assert.equal((await call(store, { role: 'owner', path: '/projects' })).payload.projects.length, 1);
  assert.equal((await call(store, { role: 'owner', path: `/projects/${id}` })).response.status, 200);
  assert.equal((await call(store, {
    role: 'owner',
    method: 'PUT',
    path: `/projects/${id}`,
    body: { baseRevision: 1, project: portableProject({ id: 'owner-work', brightness: 0.7 }) },
  })).payload.project.revision, 2);
});

test('updates require the current base revision and stale writes reveal no content', async () => {
  const store = createMemoryLibraryStore();
  const created = await createRemoteProject(store);

  const missing = await call(store, {
    method: 'PUT',
    path: `/projects/${created.id}`,
    body: { project: portableProject({ brightness: 0.5 }) },
  });
  assert.equal(missing.response.status, 400);
  assert.equal(missing.payload.error.code, 'invalid_request');

  const accepted = await call(store, {
    method: 'PUT',
    path: `/projects/${created.id}`,
    body: { baseRevision: 1, project: portableProject({ brightness: 0.5 }) },
  });
  assert.equal(accepted.response.status, 200);

  const stale = await call(store, {
    method: 'PUT',
    path: `/projects/${created.id}`,
    body: { baseRevision: 1, project: portableProject({ name: 'secret stale body' }) },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.error.code, 'revision_conflict');
  assert.doesNotMatch(JSON.stringify(stale.payload), /secret stale body|layout|pattern/i);
});

test('accepted changes append immutable history and restore creates a new head', async () => {
  const store = createMemoryLibraryStore();
  const created = await createRemoteProject(store);
  await call(store, {
    method: 'PUT',
    path: `/projects/${created.id}`,
    body: { baseRevision: 1, project: portableProject({ brightness: 0.25 }) },
  });

  const historyBefore = await call(store, { path: `/projects/${created.id}/revisions` });
  assert.deepEqual(historyBefore.payload.revisions.map(({ revision }) => revision), [2, 1]);
  assert.equal(historyBefore.payload.revisions.some(item => 'document' in item), false);

  const restored = await call(store, {
    method: 'POST',
    path: `/projects/${created.id}/revisions/1/restore`,
    body: { baseRevision: 2 },
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.project.revision, 3);

  const opened = await call(store, { path: `/projects/${created.id}` });
  assert.equal(opened.payload.project.document.pattern.masterBrightness, 1);
  const historyAfter = await call(store, { path: `/projects/${created.id}/revisions` });
  assert.deepEqual(historyAfter.payload.revisions.map(({ revision }) => revision), [3, 2, 1]);
  assert.equal(new Set(historyAfter.payload.revisions.map(item => item.hash)).size, 2);
});

test('workers can duplicate and archive projects, and active/archived lists stay separate', async () => {
  const store = createMemoryLibraryStore();
  const created = await createRemoteProject(store);

  const duplicate = await call(store, {
    method: 'POST',
    path: `/projects/${created.id}/duplicate`,
    body: { title: 'Cloud Mandala Copy' },
  });
  assert.equal(duplicate.response.status, 201);
  assert.notEqual(duplicate.payload.project.id, created.id);
  assert.notEqual(duplicate.payload.project.embeddedProjectId, created.embeddedProjectId);
  assert.equal(duplicate.payload.project.revision, 1);

  const archived = await call(store, {
    method: 'POST',
    path: `/projects/${created.id}/archive`,
    body: { baseRevision: 1 },
  });
  assert.equal(archived.response.status, 200);
  assert.equal(archived.payload.project.archived, true);
  assert.equal(archived.payload.project.revision, 2);
  assert.deepEqual((await call(store, { path: '/projects?state=active' })).payload.projects.map(p => p.id), [duplicate.payload.project.id]);
  assert.deepEqual((await call(store, { path: '/projects?state=archived' })).payload.projects.map(p => p.id), [created.id]);

  const unarchived = await call(store, {
    method: 'POST',
    path: `/projects/${created.id}/unarchive`,
    body: { baseRevision: 2 },
  });
  assert.equal(unarchived.payload.project.archived, false);
  assert.equal(unarchived.payload.project.revision, 3);

  const history = await call(store, { path: `/projects/${created.id}/revisions` });
  assert.deepEqual(
    history.payload.revisions.map(({ revision, archived }) => ({ revision, archived })),
    [
      { revision: 3, archived: false },
      { revision: 2, archived: true },
      { revision: 1, archived: false },
    ],
  );
  assert.equal(new Set(history.payload.revisions.map(item => item.hash)).size, 1);
});

test('router forbids worker permanent deletion and permits confirmed owner deletion', async () => {
  const store = createMemoryLibraryStore();
  const created = await createRemoteProject(store);

  const workerDelete = await call(store, {
    method: 'DELETE',
    path: `/projects/${created.id}`,
    body: { baseRevision: 1, confirmation: 'DELETE' },
  });
  assert.equal(workerDelete.response.status, 403);
  assert.equal(workerDelete.payload.error.code, 'forbidden');
  assert.equal((await call(store, { path: `/projects/${created.id}` })).response.status, 200);

  const ownerDelete = await call(store, {
    role: 'owner',
    email: 'owner@example.test',
    method: 'DELETE',
    path: `/projects/${created.id}`,
    body: { baseRevision: 1, confirmation: 'DELETE' },
  });
  assert.equal(ownerDelete.response.status, 200);
  assert.deepEqual(ownerDelete.payload, { deleted: true });
  assert.equal((await call(store, { path: `/projects/${created.id}` })).response.status, 404);
});

test('workspace assets use optimistic revisions and preserve their history in backup', async () => {
  const store = createMemoryLibraryStore();
  const value = { patterns: [{ id: 'custom-wave', source: 'return [255, 0, 0]' }] };

  const written = await call(store, {
    method: 'PUT',
    path: '/assets/custom-patterns',
    body: { baseRevision: 0, value },
  });
  assert.equal(written.response.status, 200);
  assert.equal(written.payload.asset.revision, 1);

  const read = await call(store, { path: '/assets/custom-patterns' });
  assert.deepEqual(read.payload.asset.value, value);

  const stale = await call(store, {
    method: 'PUT',
    path: '/assets/custom-patterns',
    body: { baseRevision: 0, value: { patterns: [] } },
  });
  assert.equal(stale.response.status, 409);
});

test('master backup round-trips additively with collision-safe identities', async () => {
  const source = createMemoryLibraryStore();
  const created = await createRemoteProject(source);
  await call(source, {
    method: 'PUT',
    path: `/projects/${created.id}`,
    body: { baseRevision: 1, project: portableProject({ brightness: 0.33 }) },
  });
  await call(source, {
    method: 'PUT',
    path: '/assets/pattern-lab-drafts',
    body: { baseRevision: 0, value: { drafts: [{ id: 'draft-1', code: 'return 1' }] } },
  });

  const exported = await call(source, { path: '/backup' });
  assert.equal(exported.response.status, 200);
  assert.equal(exported.payload.format, LIBRARY_BACKUP_FORMAT);
  assert.equal(exported.payload.version, LIBRARY_BACKUP_VERSION);
  assert.equal(typeof exported.payload.exportedAt, 'string');
  assert.equal(exported.payload.projects[0].revisions.length, 2);
  assert.equal(exported.payload.workspaceAssets[0].revisions.length, 1);
  assert.doesNotMatch(JSON.stringify(exported.payload), /worker@example\.test|worker-subject/);

  const target = createMemoryLibraryStore();
  await createRemoteProject(target);
  const imported = await call(target, {
    method: 'POST',
    path: '/restore',
    body: exported.payload,
  });
  assert.equal(imported.response.status, 200);
  assert.deepEqual(imported.payload.summary, { projectsCreated: 1, assetsCreated: 1 });

  const projects = (await call(target, { path: '/projects' })).payload.projects;
  assert.equal(projects.length, 2);
  assert.equal(new Set(projects.map(item => item.id)).size, 2);
  assert.equal(new Set(projects.map(item => item.embeddedProjectId)).size, 2);
  assert.match(projects.find(item => item.embeddedProjectId !== 'lwproj-contract')?.title || '', /restored/i);

  const restoredAsset = await call(target, { path: '/assets/pattern-lab-drafts' });
  assert.equal(restoredAsset.payload.asset.value.drafts[0].id, 'draft-1');
});

test('validation rejects future projects, malformed backup envelopes, and oversized content', () => {
  assert.throws(
    () => validatePortableProject({ ...portableProject(), version: 999 }, { maxBytes: MAX_BYTES }),
    error => error.code === 'invalid_project',
  );
  assert.throws(
    () => validatePortableProject(portableProject({ name: 'x'.repeat(4096) }), { maxBytes: 100 }),
    error => error.code === 'payload_too_large',
  );
  assert.throws(
    () => validateMasterBackup(
      { format: LIBRARY_BACKUP_FORMAT, version: 2 },
      { maxBackupBytes: MAX_BYTES, maxEntryBytes: MAX_BYTES },
    ),
    error => error.code === 'invalid_backup',
  );
});

test('master restore rejects duplicate workspace asset kinds without counting or overwriting them', async () => {
  const store = createMemoryLibraryStore();
  const duplicateAsset = {
    kind: 'custom-patterns',
    currentRevision: 1,
    revisions: [{ revision: 1, value: { patterns: [] } }],
  };
  const backup = {
    format: LIBRARY_BACKUP_FORMAT,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt: '2026-08-01T00:00:00.000Z',
    projects: [],
    workspaceAssets: [duplicateAsset, structuredClone(duplicateAsset)],
  };

  const restored = await call(store, { method: 'POST', path: '/restore', body: backup });
  assert.equal(restored.response.status, 400);
  assert.equal(restored.payload.error.code, 'invalid_backup');
  assert.equal((await call(store, { path: '/assets/custom-patterns' })).response.status, 404);
});

test('master backup enforces the normal per-revision limit separately from its whole-file limit', () => {
  const backup = {
    format: LIBRARY_BACKUP_FORMAT,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt: '2026-08-01T00:00:00.000Z',
    projects: [],
    workspaceAssets: [{
      kind: 'custom-patterns',
      currentRevision: 1,
      revisions: [{ revision: 1, value: { source: 'x'.repeat(600) } }],
    }],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(backup)) < 4096);

  assert.throws(
    () => validateMasterBackup(backup, { maxBackupBytes: 4096, maxEntryBytes: 256 }),
    error => error.code === 'payload_too_large' && error.status === 413,
  );
});

test('router rejects master backups over the default 8 MiB cap before calling the store', async () => {
  let importCalls = 0;
  const store = {
    importBackup: async () => {
      importCalls += 1;
      return { projectsCreated: 0, assetsCreated: 0 };
    },
  };
  const largeProject = portableProject();
  largeProject.padding = 'x'.repeat(1_700_000);
  const backup = {
    format: LIBRARY_BACKUP_FORMAT,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt: '2026-08-01T00:00:00.000Z',
    projects: [{
      id: 'large-backup',
      title: 'Large backup',
      archived: false,
      currentRevision: 5,
      revisions: Array.from({ length: 5 }, (_, index) => ({
        revision: index + 1,
        document: largeProject,
      })),
    }],
    workspaceAssets: [],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(backup)) > 8 * 1024 * 1024);

  const restored = await call(store, {
    method: 'POST',
    path: '/restore',
    body: backup,
    maxBytes: 2 * 1024 * 1024,
  });
  assert.equal(restored.response.status, 413);
  assert.equal(restored.payload.error.code, 'payload_too_large');
  assert.equal(importCalls, 0);
});

test('reusing an accepted idempotency key is rejected without a second mutation', async () => {
  const store = createMemoryLibraryStore();
  const requestId = crypto.randomUUID();
  const first = await call(store, {
    method: 'POST',
    path: '/projects',
    requestId,
    body: { title: 'Once', project: portableProject() },
  });
  const second = await call(store, {
    method: 'POST',
    path: '/projects',
    requestId,
    body: { title: 'Twice', project: portableProject({ id: 'lwproj-twice' }) },
  });

  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 409);
  assert.equal(second.payload.error.code, 'idempotency_conflict');
  assert.equal((await call(store, { path: '/projects' })).payload.projects.length, 1);
});

test('concurrent same-base updates atomically accept one revision and reject one stale write', async () => {
  const store = createMemoryLibraryStore();
  const created = await createRemoteProject(store);

  const settled = await Promise.allSettled([
    call(store, {
      method: 'PUT',
      path: `/projects/${created.id}`,
      body: { baseRevision: 1, project: portableProject({ brightness: 0.2 }) },
    }),
    call(store, {
      method: 'PUT',
      path: `/projects/${created.id}`,
      body: { baseRevision: 1, project: portableProject({ brightness: 0.8 }) },
    }),
  ]);

  assert.deepEqual(settled.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(
    settled.map(result => result.value.response.status).sort((left, right) => left - right),
    [200, 409],
  );
  const history = await call(store, { path: `/projects/${created.id}/revisions` });
  assert.deepEqual(history.payload.revisions.map(item => item.revision), [2, 1]);
});

test('concurrent creates atomically reserve an idempotency key for exactly one mutation', async () => {
  const store = createMemoryLibraryStore();
  const requestId = crypto.randomUUID();

  const settled = await Promise.allSettled([
    call(store, {
      method: 'POST',
      path: '/projects',
      requestId,
      body: { title: 'First contender', project: portableProject({ id: 'first-contender' }) },
    }),
    call(store, {
      method: 'POST',
      path: '/projects',
      requestId,
      body: { title: 'Second contender', project: portableProject({ id: 'second-contender' }) },
    }),
  ]);

  assert.deepEqual(settled.map(result => result.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(
    settled.map(result => result.value.response.status).sort((left, right) => left - right),
    [201, 409],
  );
  assert.equal(
    settled.find(result => result.value.response.status === 409).value.payload.error.code,
    'idempotency_conflict',
  );
  assert.equal((await call(store, { path: '/projects' })).payload.projects.length, 1);
});

test('router preserves safe errors from any store implementation without leaking its message', async () => {
  const store = createMemoryLibraryStore();
  store.updateProject = async () => {
    throw Object.assign(new Error('secret project content'), {
      code: 'revision_conflict',
      status: 409,
    });
  };
  const result = await call(store, {
    method: 'PUT',
    path: '/projects/production-store-id',
    body: { baseRevision: 1, project: portableProject() },
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error.code, 'revision_conflict');
  assert.doesNotMatch(JSON.stringify(result.payload), /secret project content/i);
});
