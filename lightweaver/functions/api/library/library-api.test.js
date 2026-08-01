import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIBRARY_BACKUP_FORMAT,
  LIBRARY_BACKUP_VERSION,
} from './_shared/backup.js';
import { createMemoryLibraryStore } from './_shared/memoryStore.js';
import { handleLibraryRequest } from './_shared/router.js';
import {
  validateMasterBackup,
  validatePortableProject,
} from './_shared/validation.js';

const MAX_BYTES = 1024 * 1024;

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
  method = 'GET',
  path = '/projects',
  body,
  requestId = crypto.randomUUID(),
} = {}) {
  const hasBody = body !== undefined;
  const response = await handleLibraryRequest({
    request: new Request(`https://led.mandalacodes.com/api/library${path}`, {
      method,
      headers: hasBody
        ? { 'content-type': 'application/json', 'x-lightweaver-request': requestId }
        : { 'x-lightweaver-request': requestId },
      body: hasBody ? JSON.stringify(body) : undefined,
    }),
    identity: role ? { email, role, subject: `${role}-subject` } : null,
    store,
    maxBytes: MAX_BYTES,
  });
  const payload = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { response, payload };
}

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
    () => validateMasterBackup({ format: LIBRARY_BACKUP_FORMAT, version: 2 }, { maxBytes: MAX_BYTES }),
    error => error.code === 'invalid_backup',
  );
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
