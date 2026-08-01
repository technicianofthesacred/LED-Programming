import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudLibraryError,
  createCloudLibraryClient,
} from './cloudLibraryClient.js';

function projectMetadata(overrides = {}) {
  return {
    id: 'remote-one',
    title: 'Cloud piece',
    archived: false,
    revision: 1,
    ...overrides,
  };
}

function nativeSession(overrides = {}) {
  return {
    username: 'studio-owner',
    displayName: 'Studio Owner',
    role: 'owner',
    mustChangePassword: false,
    ...overrides,
  };
}

function account(overrides = {}) {
  return {
    id: 'account-one',
    username: 'customer-one',
    displayName: 'Customer One',
    role: 'customer',
    status: 'active',
    mustChangePassword: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function emptyBackup() {
  return {
    format: 'lightweaver.library-backup',
    version: 1,
    exportedAt: '2026-08-01T00:00:00.000Z',
    projects: [],
    workspaceAssets: [],
  };
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

test('reads same-origin no-store JSON responses', async () => {
  const requests = [];
  const client = createCloudLibraryClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ projects: [projectMetadata({ revision: 3 })] });
    },
  });

  const projects = await client.listProjects({ state: 'archived' });

  assert.deepEqual(projects, [projectMetadata({ revision: 3 })]);
  assert.equal(requests[0].url, '/api/library/projects?state=archived');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.equal(requests[0].options.cache, 'no-store');
});

test('normalizes authentication, permission, and revision conflict responses', async t => {
  for (const [status, code, state] of [
    [401, 'unauthenticated', 'sign-in'],
    [403, 'forbidden', 'permission'],
    [409, 'revision_conflict', 'conflict'],
  ]) {
    await t.test(String(status), async () => {
      const client = createCloudLibraryClient({
        fetchImpl: async () => jsonResponse({
          error: { code, message: `Failure ${status}`, requestId: `request-${status}` },
        }, { status }),
      });

      await assert.rejects(client.getSession(), error => {
        assert.ok(error instanceof CloudLibraryError);
        assert.equal(error.code, code);
        assert.equal(error.state, state);
        assert.equal(error.status, status);
        assert.equal(error.requestId, `request-${status}`);
        return true;
      });
    });
  }
});

test('treats a no-content local session response as signed out without a failing resource', async () => {
  const client = createCloudLibraryClient({
    fetchImpl: async () => new Response(null, {
      status: 204,
      headers: { 'cache-control': 'no-store' },
    }),
  });

  await assert.rejects(client.getSession(), error => {
    assert.ok(error instanceof CloudLibraryError);
    assert.equal(error.code, 'unauthenticated');
    assert.equal(error.state, 'sign-in');
    assert.equal(error.status, 401);
    return true;
  });
});

test('mutations preserve caller idempotency keys and optimistic base revisions', async () => {
  const requests = [];
  const client = createCloudLibraryClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ project: projectMetadata({ revision: 8 }) });
    },
  });
  const project = { version: 3, id: 'portable-one' };

  await client.updateProject('remote-one', {
    baseRevision: 7,
    title: 'Revised piece',
    project,
  }, { requestId: 'retry-safe-request' });

  assert.equal(requests[0].url, '/api/library/projects/remote-one');
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.headers['content-type'], 'application/json');
  assert.equal(requests[0].options.headers['x-lightweaver-request'], 'retry-safe-request');
  assert.equal(requests[0].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    baseRevision: 7,
    title: 'Revised piece',
    project,
  });
});

test('each mutation receives an idempotency header and backup downloads stay opaque', async () => {
  const requests = [];
  const client = createCloudLibraryClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/backup')) {
        return new Response(JSON.stringify(emptyBackup()), {
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
        });
      }
      return jsonResponse({ project: projectMetadata({ id: 'created' }) }, { status: 201 });
    },
  });

  await client.createProject({ title: 'New work', project: { version: 3 } });
  const blob = await client.downloadBackup();

  assert.match(requests[0].options.headers['x-lightweaver-request'], /^[a-zA-Z0-9_-]{1,128}$/);
  assert.ok(blob instanceof Blob);
  assert.deepEqual(JSON.parse(await blob.text()), emptyBackup());
  assert.equal(Object.hasOwn(blob, 'objectKey'), false);
});

test('rejects non-JSON API successes as typed invalid responses', async () => {
  const client = createCloudLibraryClient({
    fetchImpl: async () => new Response('<html>proxy error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  });

  await assert.rejects(
    client.getSession(),
    error => error instanceof CloudLibraryError && error.code === 'invalid_response',
  );
});

test('backup downloads reject HTML and malformed JSON envelopes as typed invalid responses', async t => {
  for (const response of [
    new Response('<html>proxy error</html>', { headers: { 'content-type': 'text/html' } }),
    jsonResponse({ format: 'lightweaver.library-backup', version: 1 }),
  ]) {
    await t.test(response.headers.get('content-type'), async () => {
      const client = createCloudLibraryClient({ fetchImpl: async () => response.clone() });
      await assert.rejects(
        client.downloadBackup(),
        error => error instanceof CloudLibraryError && error.code === 'invalid_response',
      );
    });
  }
});

test('successful JSON response families reject malformed payloads with typed errors', async t => {
  const cases = [
    ['session', {}, client => client.getSession()],
    ['project list', { projects: {} }, client => client.listProjects()],
    ['project', { project: { id: 'remote-one', revision: 1 } }, client => client.createProject({ title: 'A', project: {} })],
    ['opened project document', { project: { ...projectMetadata(), document: {} } }, client => client.readProject('remote-one')],
    ['revision list', { revisions: [{}] }, client => client.listRevisions('remote-one')],
    ['asset', { asset: { kind: 'custom-patterns', revision: '1', value: {} } }, client => client.readAsset('custom-patterns')],
    ['delete', { deleted: 'yes' }, client => client.deleteProject('remote-one', { baseRevision: 1, confirmation: 'DELETE' })],
    ['restore summary', { summary: { projectsCreated: '1', assetsCreated: 0 } }, client => client.restoreBackup(emptyBackup())],
  ];

  for (const [name, payload, invoke] of cases) {
    await t.test(name, async () => {
      const client = createCloudLibraryClient({ fetchImpl: async () => jsonResponse(payload) });
      await assert.rejects(
        invoke(client),
        error => error instanceof CloudLibraryError && error.code === 'invalid_response',
      );
    });
  }
});

test('uses native account endpoints with same-origin credentials and validates sessions', async () => {
  const requests = [];
  const responses = [
    { session: nativeSession({ mustChangePassword: true }) },
    { session: nativeSession() },
    { session: nativeSession() },
    { loggedOut: true },
  ];
  const client = createCloudLibraryClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(responses.shift());
    },
  });

  assert.deepEqual(await client.login({ username: 'studio-owner', password: 'temporary-password' }), nativeSession({ mustChangePassword: true }));
  assert.deepEqual(await client.getAccountSession(), nativeSession());
  assert.deepEqual(await client.changePassword('a-personal-password'), nativeSession());
  assert.deepEqual(await client.logout(), { loggedOut: true });

  assert.deepEqual(requests.map(request => [request.url, request.options.method]), [
    ['/api/account/login', 'POST'],
    ['/api/account/session', 'GET'],
    ['/api/account/password', 'POST'],
    ['/api/account/logout', 'POST'],
  ]);
  assert.ok(requests.every(request => request.options.credentials === 'same-origin'));
  assert.deepEqual(JSON.parse(requests[0].options.body), { username: 'studio-owner', password: 'temporary-password' });
  assert.deepEqual(JSON.parse(requests[2].options.body), { password: 'a-personal-password' });
  assert.deepEqual(JSON.parse(requests[3].options.body), {});
});

test('validates every native account response family', async t => {
  const cases = [
    ['login session', { session: { ...nativeSession(), mustChangePassword: 'no' } }, client => client.login({ username: 'owner', password: 'password' })],
    ['account session', { session: { ...nativeSession(), role: 'admin' } }, client => client.getAccountSession()],
    ['password session', { session: { ...nativeSession(), displayName: '' } }, client => client.changePassword('twelve-characters')],
    ['logout', { loggedOut: 'yes' }, client => client.logout()],
    ['account list', { accounts: [{ ...account(), status: 'pending' }] }, client => client.listAccounts()],
    ['account create', { account: { ...account(), id: '' } }, client => client.createAccount({ username: 'a', displayName: 'A', role: 'worker', temporaryPassword: 'temporary-pass' })],
    ['assignment list', { assignments: [{ projectId: 'official', draftProjectId: 2 }] }, client => client.listAssignments('account-one')],
    ['assignment create', { assignment: { customerId: 'account-one', projectId: '', draftProjectId: 'draft-one', assignedAt: 'now', project: projectMetadata() } }, client => client.assignProject('account-one', 'official-one')],
    ['assignment delete', { unassigned: false }, client => client.unassignProject('account-one', 'official-one')],
    ['draft list', { drafts: [{ ...projectMetadata(), draftOfProjectId: 'official-one' }] }, client => client.listProjectDrafts('official-one')],
    ['promotion', { project: { ...projectMetadata(), revision: 0 } }, client => client.promoteDraft('draft-one', { officialBaseRevision: 2, draftBaseRevision: 3 })],
  ];

  for (const [name, payload, invoke] of cases) {
    await t.test(name, async () => {
      const client = createCloudLibraryClient({ fetchImpl: async () => jsonResponse(payload) });
      await assert.rejects(invoke(client), error => error instanceof CloudLibraryError && error.code === 'invalid_response');
    });
  }
});

test('sends account administration, assignments, and exact draft promotion payloads', async () => {
  const requests = [];
  const client = createCloudLibraryClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/library/accounts' && options.method === 'GET') return jsonResponse({ accounts: [] });
      if (url.endsWith('/assignments') && options.method === 'GET') return jsonResponse({ assignments: [] });
      if (url.endsWith('/assignments') && options.method === 'POST') return jsonResponse({ assignment: {
        customerId: 'account-one',
        projectId: 'official-one',
        draftProjectId: 'draft-one',
        assignedAt: '2026-08-01T00:00:00.000Z',
        project: projectMetadata({
          id: 'draft-one',
          draftOfProjectId: 'official-one',
          draftOwnerAccountId: 'account-one',
          officialTitle: 'Cloud piece',
        }),
      } });
      if (options.method === 'DELETE') return jsonResponse({ unassigned: true });
      if (url.endsWith('/drafts')) return jsonResponse({ drafts: [] });
      if (url.endsWith('/promote')) return jsonResponse({ project: projectMetadata({ revision: 4 }) });
      return jsonResponse({ account: account() }, { status: options.method === 'POST' ? 201 : 200 });
    },
  });

  await client.bootstrapOwner({ username: 'owner', displayName: 'Owner', temporaryPassword: 'temporary-pass' });
  await client.listAccounts();
  await client.createAccount({ username: 'customer', displayName: 'Customer', role: 'customer', temporaryPassword: 'temporary-pass' });
  await client.resetAccountPassword('account-one', 'replacement-pass');
  await client.setAccountStatus('account-one', 'disabled');
  await client.setAccountRole('account-one', 'worker');
  await client.listAssignments('account-one');
  await client.assignProject('account-one', 'official-one');
  await client.unassignProject('account-one', 'official-one');
  await client.listProjectDrafts('official-one');
  await client.promoteDraft('draft-one', { officialBaseRevision: 2, draftBaseRevision: 7 });

  assert.deepEqual(requests.map(request => [request.url, request.options.method]), [
    ['/api/library/accounts/bootstrap', 'POST'],
    ['/api/library/accounts', 'GET'],
    ['/api/library/accounts', 'POST'],
    ['/api/library/accounts/account-one/reset', 'POST'],
    ['/api/library/accounts/account-one/status', 'POST'],
    ['/api/library/accounts/account-one/role', 'POST'],
    ['/api/library/accounts/account-one/assignments', 'GET'],
    ['/api/library/accounts/account-one/assignments', 'POST'],
    ['/api/library/accounts/account-one/assignments/official-one', 'DELETE'],
    ['/api/library/projects/official-one/drafts', 'GET'],
    ['/api/library/projects/draft-one/promote', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
    officialBaseRevision: 2,
    draftBaseRevision: 7,
  });
});
