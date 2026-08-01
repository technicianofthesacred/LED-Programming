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
