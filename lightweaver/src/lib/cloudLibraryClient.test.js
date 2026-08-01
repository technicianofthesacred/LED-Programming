import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudLibraryError,
  createCloudLibraryClient,
} from './cloudLibraryClient.js';

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
      return jsonResponse({ projects: [{ id: 'remote-one', revision: 3 }] });
    },
  });

  const projects = await client.listProjects({ state: 'archived' });

  assert.deepEqual(projects, [{ id: 'remote-one', revision: 3 }]);
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

test('mutations preserve caller idempotency keys and optimistic base revisions', async () => {
  const requests = [];
  const client = createCloudLibraryClient({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse({ project: { id: 'remote-one', revision: 8 } });
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
        return new Response('{"format":"lightweaver.library-backup"}', {
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
        });
      }
      return jsonResponse({ project: { id: 'created', revision: 1 } }, { status: 201 });
    },
  });

  await client.createProject({ title: 'New work', project: { version: 3 } });
  const blob = await client.downloadBackup();

  assert.match(requests[0].options.headers['x-lightweaver-request'], /^[a-zA-Z0-9_-]{1,128}$/);
  assert.ok(blob instanceof Blob);
  assert.equal(await blob.text(), '{"format":"lightweaver.library-backup"}');
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
