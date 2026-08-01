import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { Miniflare } from 'miniflare';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from 'jose';

import {
  authenticateAccessRequest,
  isLocalAccessJwksRequest,
} from '../functions/api/library/_shared/auth.js';
import {
  createD1R2LibraryStore,
} from '../functions/api/library/_shared/store.js';
import {
  handleLibraryPagesRequest,
} from '../functions/api/library/[[path]].js';
import { handleLibraryRequest } from '../functions/api/library/_shared/router.js';

const ACCESS_ENV = {
  ACCESS_TEAM_DOMAIN: 'https://lightweaver-test.cloudflareaccess.com',
  ACCESS_AUD: 'lightweaver-test-audience',
  OWNER_EMAILS: ' owner@example.test,SECOND-owner@example.test ',
  MAX_LIBRARY_BODY_BYTES: '1048576',
};
const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER_BIN = join(PROJECT_DIR, 'node_modules', '.bin', 'wrangler');

function runWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(WRANGLER_BIN, args, {
      cwd: PROJECT_DIR,
      env: { ...process.env, CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr, stdout }));
  });
}

async function availablePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timer;
  const forced = new Promise(resolve => {
    timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 3_000);
    timer.unref();
  });
  await Promise.race([exited, forced]);
  clearTimeout(timer);
  if (child.exitCode === null) await once(child, 'exit');
}

async function waitForResponse(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler pages dev exited early (${child.exitCode})\n${output()}`);
    }
    try {
      return await fetch(url);
    } catch {
      await delay(100);
    }
  }
  throw new Error(`wrangler pages dev did not become ready\n${output()}`);
}

function portableProject({ id = 'lwproj-cloud', name = 'Cloud Project', brightness = 1 } = {}) {
  return {
    version: 3,
    id,
    name,
    layout: { strips: [], starterPending: false, viewBox: '0 0 640 400' },
    pattern: { activePatternId: 'aurora', masterBrightness: brightness },
    show: {},
    live: {},
    devices: {},
  };
}

async function accessFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  publicJwk.kid = 'test-access-key';
  const jwksDocument = { keys: [publicJwk] };
  const jwks = createLocalJWKSet(jwksDocument);

  async function token({
    audience = ACCESS_ENV.ACCESS_AUD,
    email = 'worker@example.test',
    expiresIn = '5m',
    issuer = ACCESS_ENV.ACCESS_TEAM_DOMAIN,
    key = privateKey,
    subject = 'access-user-1',
  } = {}) {
    return new SignJWT({ email, type: 'app' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-access-key', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(key);
  }

  return { jwks, jwksDocument, privateKey, token };
}

test('Access authentication validates signature, exact issuer/audience, expiry, and projects roles from normalized email', async () => {
  const fixture = await accessFixture();
  const request = async (jwt, spoofed = {}) => new Request('https://led.mandalacodes.com/api/library/session', {
    headers: {
      'Cf-Access-Jwt-Assertion': jwt,
      'Cf-Access-Authenticated-User-Email': spoofed.email || 'spoof@example.test',
      'x-lightweaver-role': spoofed.role || 'owner',
    },
  });

  const worker = await authenticateAccessRequest(await request(await fixture.token()), ACCESS_ENV, {
    jwks: fixture.jwks,
  });
  assert.deepEqual(worker, {
    email: 'worker@example.test',
    role: 'worker',
    subject: 'access-user-1',
  });

  const owner = await authenticateAccessRequest(
    await request(await fixture.token({ email: '  OWNER@EXAMPLE.TEST  ' })),
    ACCESS_ENV,
    { jwks: fixture.jwks },
  );
  assert.equal(owner.email, 'owner@example.test');
  assert.equal(owner.role, 'owner');

  const invalidTokens = [
    fixture.token({ issuer: `${ACCESS_ENV.ACCESS_TEAM_DOMAIN}/wrong` }),
    fixture.token({ audience: `${ACCESS_ENV.ACCESS_AUD}-wrong` }),
    fixture.token({ expiresIn: '-1s' }),
    fixture.token({ subject: '' }),
  ];
  for (const pendingToken of invalidTokens) {
    await assert.rejects(
      authenticateAccessRequest(await request(await pendingToken), ACCESS_ENV, { jwks: fixture.jwks }),
    );
  }

  const otherKeys = await generateKeyPair('RS256');
  await assert.rejects(
    authenticateAccessRequest(
      await request(await fixture.token({ key: otherKeys.privateKey })),
      ACCESS_ENV,
      { jwks: fixture.jwks },
    ),
  );
  await assert.rejects(
    authenticateAccessRequest(await request(await fixture.token()), {
      ...ACCESS_ENV,
      ACCESS_TEAM_DOMAIN: `${ACCESS_ENV.ACCESS_TEAM_DOMAIN}/not-an-origin`,
    }, { jwks: fixture.jwks }),
  );
});

test('local JWKS mode requires both the Wrangler-only flag and a loopback request URL', () => {
  const localEnv = { LIGHTWEAVER_LOCAL_AUTH: 'wrangler-pages-dev', LOCAL_ACCESS_JWKS: '{"keys":[]}' };
  assert.equal(isLocalAccessJwksRequest(
    new Request('http://127.0.0.1:8788/api/library/session'),
    localEnv,
  ), true);
  assert.equal(isLocalAccessJwksRequest(
    new Request('https://led.mandalacodes.com/api/library/session'),
    localEnv,
  ), false);
  assert.equal(isLocalAccessJwksRequest(
    new Request('http://localhost:8788/api/library/session'),
    { ...localEnv, LIGHTWEAVER_LOCAL_AUTH: '' },
  ), false);
});

test('Pages adapter returns a router no-store 503 when authenticated storage bindings are missing', async () => {
  const fixture = await accessFixture();
  const response = await handleLibraryPagesRequest({
    request: new Request('https://led.mandalacodes.com/api/library/session', {
      headers: { 'Cf-Access-Jwt-Assertion': await fixture.token() },
    }),
    env: ACCESS_ENV,
    params: { path: ['session'] },
  }, { jwks: fixture.jwks });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error.code, 'library_unavailable');
});

test('Pages adapter authenticates a signed worker for a local D1/R2 round-trip and still forbids deletion', async t => {
  const fixture = await accessFixture();
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  const jwt = await fixture.token();
  const call = async (path, { method = 'GET', body } = {}) => {
    const response = await handleLibraryPagesRequest({
      request: new Request(`https://led.mandalacodes.com/api/library${path}`, {
        method,
        headers: {
          'Cf-Access-Jwt-Assertion': jwt,
          ...(body ? {
            'content-type': 'application/json',
            'x-lightweaver-request': crypto.randomUUID(),
          } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env: { ...ACCESS_ENV, PROJECTS_DB: db, PROJECT_BLOBS: bucket },
      params: {},
    }, { jwks: fixture.jwks });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { response, payload: await response.json() };
  };

  const created = await call('/projects', {
    method: 'POST',
    body: { title: 'Adapter round-trip', project: portableProject({ id: 'adapter-round-trip' }) },
  });
  assert.equal(created.response.status, 201);
  const opened = await call(`/projects/${created.payload.project.id}`);
  assert.equal(opened.payload.project.document.id, 'adapter-round-trip');
  const denied = await call(`/projects/${created.payload.project.id}`, {
    method: 'DELETE',
    body: { baseRevision: 1, confirmation: 'DELETE' },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, 'forbidden');
});

function wrapStatement(statement, sql, prepared) {
  return {
    __statement: statement,
    bind(...values) {
      prepared.push({ sql, values });
      return wrapStatement(statement.bind(...values), sql, prepared);
    },
    first: (...args) => statement.first(...args),
    all: (...args) => statement.all(...args),
    run: (...args) => statement.run(...args),
    raw: (...args) => statement.raw(...args),
  };
}

function recordingBindings(db, bucket) {
  const events = [];
  const prepared = [];
  const PROJECTS_DB = {
    prepare(sql) {
      return wrapStatement(db.prepare(sql), sql, prepared);
    },
    async batch(statements) {
      events.push('d1:batch');
      return db.batch(statements.map(statement => statement.__statement || statement));
    },
  };
  const PROJECT_BLOBS = {
    async put(key, value, options) {
      events.push(`r2:put:${key}`);
      return bucket.put(key, value, options);
    },
    get: (...args) => bucket.get(...args),
    head: (...args) => bucket.head(...args),
    list: (...args) => bucket.list(...args),
    async delete(key) {
      events.push(`r2:delete:${Array.isArray(key) ? key.join(',') : key}`);
      return bucket.delete(key);
    },
  };
  return { env: { PROJECTS_DB, PROJECT_BLOBS }, events, prepared };
}

async function localBindings() {
  const mf = new Miniflare({
    compatibilityDate: '2026-07-15',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['PROJECTS_DB'],
    r2Buckets: ['PROJECT_BLOBS'],
  });
  const db = await mf.getD1Database('PROJECTS_DB');
  const bucket = await mf.getR2Bucket('PROJECT_BLOBS');
  const migration = await readFile(new URL('../migrations/0001_cloud_project_library.sql', import.meta.url), 'utf8');
  for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
  }
  return { mf, db, bucket };
}

test('D1/R2 store writes immutable private bodies before atomic metadata and cleans the losing optimistic write', async t => {
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  const bindings = recordingBindings(db, bucket);
  const store = createD1R2LibraryStore(bindings.env, {
    maxBytes: 1024 * 1024,
    now: () => '2026-08-01T00:00:00.000Z',
  });
  const actor = { email: 'worker@example.test', role: 'worker', subject: 'worker-1' };
  const title = "Parameterized '); DROP TABLE projects; --";

  const created = await store.createProject({
    title,
    project: portableProject(),
    actor,
    idempotencyKey: 'create-once',
  });
  assert.equal(created.revision, 1);
  assert.equal(created.title, title);
  assert.equal('objectKey' in created, false);
  assert.doesNotMatch(JSON.stringify(created), /r2:|https?:\/\//);
  assert.match(bindings.events[0], /^r2:put:projects\//);
  assert.equal(bindings.events[1], 'd1:batch');
  assert.equal(bindings.prepared.some(entry => entry.sql.includes(title)), false);
  assert.equal(bindings.prepared.some(entry => entry.values.includes(title)), true);

  const contenders = await Promise.allSettled([
    store.updateProject({
      id: created.id,
      baseRevision: 1,
      project: portableProject({ brightness: 0.2 }),
      actor,
      idempotencyKey: 'update-a',
    }),
    store.updateProject({
      id: created.id,
      baseRevision: 1,
      project: portableProject({ brightness: 0.8 }),
      actor,
      idempotencyKey: 'update-b',
    }),
  ]);
  assert.deepEqual(contenders.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const rejected = contenders.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'revision_conflict');
  assert.equal(bindings.events.some(event => event.startsWith('r2:delete:projects/')), true);

  const objectsAfterRace = await bucket.list({ prefix: `projects/${created.id}/` });
  assert.equal(objectsAfterRace.objects.length, 2);
  assert.equal(objectsAfterRace.objects.every(object => !/^https?:/.test(object.key)), true);

  const head = await store.readProject({ id: created.id, identity: actor });
  assert.equal(head.revision, 2);
  assert.equal(head.document.id, 'lwproj-cloud');

  const archived = await store.setArchived({
    id: created.id,
    archived: true,
    baseRevision: 2,
    actor,
    idempotencyKey: 'archive-once',
  });
  const unarchived = await store.setArchived({
    id: created.id,
    archived: false,
    baseRevision: 3,
    actor,
    idempotencyKey: 'unarchive-once',
  });
  assert.equal(archived.archived, true);
  assert.equal(unarchived.archived, false);
  assert.deepEqual(
    (await store.listRevisions({ id: created.id, identity: actor }))
      .map(({ revision, archived: revisionArchived }) => [revision, revisionArchived]),
    [[4, false], [3, true], [2, false], [1, false]],
  );
});

test('an ambiguous commit-then-throw keeps committed R2 references readable', async t => {
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  let committedBatches = 0;
  const ambiguousDb = {
    prepare: (...args) => db.prepare(...args),
    async batch(statements) {
      const result = await db.batch(statements);
      committedBatches += 1;
      if (committedBatches === 1) throw new Error('ambiguous transport failure after commit');
      return result;
    },
  };
  const store = createD1R2LibraryStore({ PROJECTS_DB: ambiguousDb, PROJECT_BLOBS: bucket });
  const actor = { email: 'worker@example.test', role: 'worker', subject: 'worker-1' };
  const created = await store.createProject({
    title: 'Committed despite transport failure',
    project: portableProject({ id: 'committed-after-throw' }),
    actor,
    idempotencyKey: 'commit-then-throw',
  });

  assert.equal(created.revision, 1);
  assert.equal((await store.readProject({ id: created.id })).document.id, 'committed-after-throw');
  assert.equal((await bucket.list({ prefix: `projects/${created.id}/` })).objects.length, 1);
  const mutation = await db.prepare(`
    SELECT attempt_id FROM library_mutations WHERE idempotency_key = ?
  `).bind('commit-then-throw').first();
  assert.match(mutation.attempt_id, /^[0-9a-f-]{36}$/);
});

test('D1/R2 store implements assets, duplicate, restore, backup/import, deletion, and atomic idempotency', async t => {
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  const { env } = recordingBindings(db, bucket);
  const store = createD1R2LibraryStore(env, { maxBytes: 1024 * 1024 });
  const actor = { email: 'owner@example.test', role: 'owner', subject: 'owner-1' };

  const sameKey = await Promise.allSettled([
    store.createProject({
      title: 'First', project: portableProject({ id: 'same-key-a' }), actor, idempotencyKey: 'same-key',
    }),
    store.createProject({
      title: 'Second', project: portableProject({ id: 'same-key-b' }), actor, idempotencyKey: 'same-key',
    }),
  ]);
  assert.deepEqual(sameKey.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(sameKey.find(result => result.status === 'rejected').reason.code, 'idempotency_conflict');

  const original = sameKey.find(result => result.status === 'fulfilled').value;
  const duplicate = await store.duplicateProject({
    id: original.id, title: 'Independent copy', actor, idempotencyKey: 'duplicate',
  });
  assert.notEqual(duplicate.embeddedProjectId, original.embeddedProjectId);

  const restored = await store.restoreRevision({
    id: original.id, revision: 1, baseRevision: 1, actor, idempotencyKey: 'restore-head',
  });
  assert.equal(restored.revision, 2);

  const firstAsset = await store.writeAsset({
    kind: 'custom-patterns', value: { patterns: [{ id: 'wave' }] }, baseRevision: 0,
    actor, idempotencyKey: 'asset-1',
  });
  assert.equal(firstAsset.revision, 1);
  assert.deepEqual((await store.readAsset({ kind: 'custom-patterns', identity: actor })).value, {
    patterns: [{ id: 'wave' }],
  });

  const backup = await store.exportBackup({ identity: actor });
  assert.equal(backup.projects.length, 2);
  assert.equal(backup.workspaceAssets.length, 1);
  assert.doesNotMatch(JSON.stringify(backup), /owner@example\.test|object_key|projects\//);

  const imported = await store.importBackup({ backup, actor, idempotencyKey: 'import-1' });
  assert.deepEqual(imported, { projectsCreated: 2, assetsCreated: 1 });
  assert.equal((await store.listProjects({ state: 'active', identity: actor })).length, 4);

  assert.deepEqual(await store.deleteProject({
    id: duplicate.id, baseRevision: 1, actor, idempotencyKey: 'delete-copy',
  }), { deleted: true });
  await assert.rejects(store.readProject({ id: duplicate.id, identity: actor }), error => error.code === 'not_found');
  assert.equal((await bucket.list()).objects.every(object => !object.key.includes('http')), true);
});

test('permanent delete removes every project and revision row plus every immutable R2 body', async t => {
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  const store = createD1R2LibraryStore({ PROJECTS_DB: db, PROJECT_BLOBS: bucket });
  const actor = { email: 'owner@example.test', role: 'owner', subject: 'owner-1' };
  const created = await store.createProject({
    title: 'Delete completely',
    project: portableProject({ id: 'delete-completely' }),
    actor,
    idempotencyKey: 'delete-create',
  });
  await store.updateProject({
    id: created.id,
    baseRevision: 1,
    project: portableProject({ id: 'delete-completely', brightness: 0.5 }),
    actor,
    idempotencyKey: 'delete-update',
  });
  await store.restoreRevision({
    id: created.id,
    revision: 1,
    baseRevision: 2,
    actor,
    idempotencyKey: 'delete-restore',
  });
  assert.equal((await bucket.list({ prefix: `projects/${created.id}/` })).objects.length, 3);

  assert.deepEqual(await store.deleteProject({
    id: created.id,
    baseRevision: 3,
    actor,
    idempotencyKey: 'delete-final',
  }), { deleted: true });
  assert.equal(await db.prepare('SELECT id FROM projects WHERE id = ?').bind(created.id).first(), null);
  assert.equal(
    await db.prepare('SELECT COUNT(*) AS count FROM project_revisions WHERE project_id = ?')
      .bind(created.id).first('count'),
    0,
  );
  assert.equal((await bucket.list({ prefix: `projects/${created.id}/` })).objects.length, 0);
  assert.ok(await db.prepare(
    'SELECT idempotency_key FROM library_mutations WHERE idempotency_key = ?',
  ).bind('delete-final').first());
});

test('an R2 deletion failure returns a safe router failure and preserves project metadata', async t => {
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  const failingBucket = {
    get: (...args) => bucket.get(...args),
    head: (...args) => bucket.head(...args),
    list: (...args) => bucket.list(...args),
    put: (...args) => bucket.put(...args),
    async delete() {
      throw new Error('private storage failure with secret details');
    },
  };
  const store = createD1R2LibraryStore({ PROJECTS_DB: db, PROJECT_BLOBS: failingBucket });
  const identity = { email: 'owner@example.test', role: 'owner', subject: 'owner-1' };
  const created = await store.createProject({
    title: 'Delete must fail closed',
    project: portableProject({ id: 'delete-fails-closed' }),
    actor: identity,
    idempotencyKey: 'failed-delete-create',
  });
  const response = await handleLibraryRequest({
    request: new Request(`https://led.mandalacodes.com/api/library/projects/${created.id}`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-lightweaver-request': 'failed-delete-request',
      },
      body: JSON.stringify({ baseRevision: 1, confirmation: 'DELETE' }),
    }),
    identity,
    store,
  });
  const payload = await response.json();
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(payload.error.code, 'internal_error');
  assert.equal('deleted' in payload, false);
  assert.doesNotMatch(JSON.stringify(payload), /secret details|delete-fails-closed/);
  const tombstone = await db.prepare(
    'SELECT id, deleted_at, deletion_idempotency_key FROM projects WHERE id = ?',
  ).bind(created.id).first();
  assert.ok(tombstone.deleted_at);
  assert.equal(tombstone.deletion_idempotency_key, 'failed-delete-request');
  assert.equal(
    await db.prepare('SELECT COUNT(*) AS count FROM project_revisions WHERE project_id = ?')
      .bind(created.id).first('count'),
    1,
  );
  await assert.rejects(store.readProject({ id: created.id }), error => error.code === 'not_found');

  const retryStore = createD1R2LibraryStore({ PROJECTS_DB: db, PROJECT_BLOBS: bucket });
  assert.deepEqual(await retryStore.deleteProject({
    id: created.id,
    baseRevision: 1,
    actor: identity,
    idempotencyKey: 'failed-delete-request',
  }), { deleted: true });
  assert.equal(await db.prepare('SELECT id FROM projects WHERE id = ?').bind(created.id).first(), null);
});

test('a competing same-base delete that loses the tombstone CAS performs zero R2 deletes', async t => {
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  let deleteCalls = 0;
  const trackingBucket = {
    get: (...args) => bucket.get(...args),
    head: (...args) => bucket.head(...args),
    list: (...args) => bucket.list(...args),
    put: (...args) => bucket.put(...args),
    async delete(...args) {
      deleteCalls += 1;
      return bucket.delete(...args);
    },
  };
  const store = createD1R2LibraryStore({ PROJECTS_DB: db, PROJECT_BLOBS: trackingBucket });
  const actor = { email: 'owner@example.test', role: 'owner', subject: 'owner-1' };
  const created = await store.createProject({
    title: 'Delete race',
    project: portableProject({ id: 'delete-race' }),
    actor,
    idempotencyKey: 'delete-race-create',
  });

  const settled = await Promise.allSettled([
    store.deleteProject({
      id: created.id, baseRevision: 1, actor, idempotencyKey: 'delete-race-a',
    }),
    store.deleteProject({
      id: created.id, baseRevision: 1, actor, idempotencyKey: 'delete-race-b',
    }),
  ]);
  assert.deepEqual(settled.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(settled.find(result => result.status === 'rejected').reason.code, 'revision_conflict');
  assert.equal(deleteCalls, 1);
});

test('failed D1 finalization leaves an unserved tombstone that the same delete can safely finish', async t => {
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  const actor = { email: 'owner@example.test', role: 'owner', subject: 'owner-1' };
  const setupStore = createD1R2LibraryStore({ PROJECTS_DB: db, PROJECT_BLOBS: bucket });
  const created = await setupStore.createProject({
    title: 'Finalize retry',
    project: portableProject({ id: 'finalize-retry' }),
    actor,
    idempotencyKey: 'finalize-create',
  });
  let batches = 0;
  const failingDb = {
    prepare: (...args) => db.prepare(...args),
    async batch(statements) {
      batches += 1;
      if (batches === 2) throw new Error('injected final D1 failure');
      return db.batch(statements);
    },
  };
  const failingStore = createD1R2LibraryStore({ PROJECTS_DB: failingDb, PROJECT_BLOBS: bucket });
  await assert.rejects(failingStore.deleteProject({
    id: created.id,
    baseRevision: 1,
    actor,
    idempotencyKey: 'finalize-delete',
  }), /injected final D1 failure/);
  assert.equal((await bucket.list({ prefix: `projects/${created.id}/` })).objects.length, 0);
  const tombstone = await db.prepare(
    'SELECT deleted_at, deletion_idempotency_key FROM projects WHERE id = ?',
  ).bind(created.id).first();
  assert.ok(tombstone.deleted_at);
  assert.equal(tombstone.deletion_idempotency_key, 'finalize-delete');
  await assert.rejects(setupStore.readProject({ id: created.id }), error => error.code === 'not_found');

  assert.deepEqual(await setupStore.deleteProject({
    id: created.id,
    baseRevision: 1,
    actor,
    idempotencyKey: 'finalize-delete',
  }), { deleted: true });
  assert.equal(await db.prepare('SELECT id FROM projects WHERE id = ?').bind(created.id).first(), null);
});

test('a failed multi-object import best-effort removes every object written before metadata', async t => {
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  let puts = 0;
  const failingBucket = {
    get: (...args) => bucket.get(...args),
    head: (...args) => bucket.head(...args),
    list: (...args) => bucket.list(...args),
    delete: (...args) => bucket.delete(...args),
    async put(...args) {
      puts += 1;
      if (puts === 2) throw new Error('injected R2 failure');
      return bucket.put(...args);
    },
  };
  const store = createD1R2LibraryStore({ PROJECTS_DB: db, PROJECT_BLOBS: failingBucket });
  const actor = { email: 'owner@example.test', role: 'owner', subject: 'owner-1' };
  const backup = {
    format: 'lightweaver.library-backup',
    version: 1,
    exportedAt: '2026-08-01T00:00:00.000Z',
    projects: [{
      id: 'import-cleanup',
      title: 'Import cleanup',
      archived: false,
      currentRevision: 2,
      revisions: [
        { revision: 1, archived: false, document: portableProject({ id: 'import-cleanup' }) },
        { revision: 2, archived: false, document: portableProject({ id: 'import-cleanup', brightness: 0.5 }) },
      ],
    }],
    workspaceAssets: [],
  };

  await assert.rejects(
    store.importBackup({ backup, actor, idempotencyKey: 'failed-import' }),
    /injected R2 failure/,
  );
  assert.equal((await bucket.list()).objects.length, 0);
});

test('oversized full-library export rejects before reading any R2 body', async t => {
  const { mf, db, bucket } = await localBindings();
  t.after(() => mf.dispose());
  const actor = { email: 'worker@example.test', role: 'worker', subject: 'worker-1' };
  const setupStore = createD1R2LibraryStore({ PROJECTS_DB: db, PROJECT_BLOBS: bucket });
  await setupStore.createProject({
    title: 'Too large to export',
    project: portableProject({ id: 'too-large-to-export' }),
    actor,
    idempotencyKey: 'oversized-export-create',
  });
  let r2Reads = 0;
  const trackingBucket = {
    async get(...args) {
      r2Reads += 1;
      return bucket.get(...args);
    },
    head: (...args) => bucket.head(...args),
    list: (...args) => bucket.list(...args),
    put: (...args) => bucket.put(...args),
    delete: (...args) => bucket.delete(...args),
  };
  const boundedStore = createD1R2LibraryStore(
    { PROJECTS_DB: db, PROJECT_BLOBS: trackingBucket },
    { maxBackupBytes: 128 },
  );
  const response = await handleLibraryRequest({
    request: new Request('https://led.mandalacodes.com/api/library/backup'),
    identity: actor,
    store: boundedStore,
  });
  const payload = await response.json();
  assert.equal(response.status, 413);
  assert.equal(payload.error.code, 'backup_too_large');
  assert.equal(r2Reads, 0);
});

test('Wrangler applies local migrations and serves the deployed Pages catch-all without remote access', {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lightweaver-cloud-bindings-'));
  const state = join(root, 'state');
  const site = join(root, 'site');
  await mkdir(site, { recursive: true });
  const fixture = await accessFixture();
  const jwt = await fixture.token();
  let child;
  try {
    const migration = await runWrangler([
      'd1', 'migrations', 'apply', 'PROJECTS_DB', '--config', 'wrangler.local.toml',
      '--local', '--persist-to', state,
    ]);
    assert.equal(migration.code, 0, `${migration.stdout}\n${migration.stderr}`);
    assert.match(`${migration.stdout}\n${migration.stderr}`, /0001_cloud_project_library\.sql/);

    const schema = await runWrangler([
      'd1', 'execute', 'PROJECTS_DB', '--config', 'wrangler.local.toml',
      '--local', '--persist-to', state,
      '--command', "SELECT COUNT(*) AS project_tables FROM sqlite_master WHERE type='table' AND name='projects'",
      '--json',
    ]);
    assert.equal(schema.code, 0, `${schema.stdout}\n${schema.stderr}`);
    assert.equal(JSON.parse(schema.stdout)[0].results[0].project_tables, 1);

    const port = await availablePort();
    let stdout = '';
    let stderr = '';
    child = spawn(WRANGLER_BIN, [
      'pages', 'dev', site,
      '--persist-to', state,
      '--ip', '127.0.0.1',
      '--port', String(port),
      '--log-level', 'error',
      '--show-interactive-dev-session=false',
      '--d1', 'PROJECTS_DB',
      '--r2', 'PROJECT_BLOBS',
      '--binding', 'LIGHTWEAVER_LOCAL_AUTH=wrangler-pages-dev',
      '--binding', `LOCAL_ACCESS_JWKS=${JSON.stringify(fixture.jwksDocument)}`,
      '--binding', `ACCESS_TEAM_DOMAIN=${ACCESS_ENV.ACCESS_TEAM_DOMAIN}`,
      '--binding', `ACCESS_AUD=${ACCESS_ENV.ACCESS_AUD}`,
      '--binding', `OWNER_EMAILS=${ACCESS_ENV.OWNER_EMAILS}`,
    ], {
      cwd: PROJECT_DIR,
      env: { ...process.env, CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    const response = await waitForResponse(
      `http://127.0.0.1:${port}/api/library/session`,
      child,
      () => `${stdout}\n${stderr}`,
    );
    const payload = await response.json();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(payload.error.code, 'unauthenticated');
    assert.equal(child.exitCode, null);

    const authHeaders = { 'Cf-Access-Jwt-Assertion': jwt };
    const createdResponse = await fetch(`http://127.0.0.1:${port}/api/library/projects`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
        'x-lightweaver-request': 'served-create',
      },
      body: JSON.stringify({
        title: 'Served Pages project',
        project: portableProject({ id: 'served-pages-project' }),
      }),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    const projectId = created.project.id;

    const readResponse = await fetch(
      `http://127.0.0.1:${port}/api/library/projects/${projectId}`,
      { headers: authHeaders },
    );
    const opened = await readResponse.json();
    assert.equal(readResponse.status, 200);
    assert.equal(opened.project.document.id, 'served-pages-project');

    const deleteResponse = await fetch(
      `http://127.0.0.1:${port}/api/library/projects/${projectId}`,
      {
        method: 'DELETE',
        headers: {
          ...authHeaders,
          'content-type': 'application/json',
          'x-lightweaver-request': 'served-worker-delete',
        },
        body: JSON.stringify({ baseRevision: 1, confirmation: 'DELETE' }),
      },
    );
    assert.equal(deleteResponse.status, 403);
    assert.equal((await deleteResponse.json()).error.code, 'forbidden');
  } finally {
    if (child) await stopChild(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('binding config, migration, route manifest, and package scripts are local-safe and complete', async () => {
  const [routesText, migration, wrangler, localWrangler, packageText, gitignore, productionGuard] = await Promise.all([
    readFile(new URL('../public/_routes.json', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0001_cloud_project_library.sql', import.meta.url), 'utf8'),
    readFile(new URL('../wrangler.toml', import.meta.url), 'utf8'),
    readFile(new URL('../wrangler.local.toml', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../../.gitignore', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/require-cloud-library-production.mjs', import.meta.url), 'utf8'),
  ]);
  assert.deepEqual(JSON.parse(routesText), {
    version: 1,
    include: ['/api/library', '/api/library/*'],
    exclude: [],
  });

  for (const table of ['projects', 'project_revisions', 'asset_heads', 'asset_revisions', 'library_imports']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  }
  assert.match(migration, /UNIQUE\s*\(project_id,\s*revision\)/i);
  assert.match(migration, /UNIQUE\s*\(asset_kind,\s*revision\)/i);
  assert.match(migration, /archived[^,\n]*NOT NULL/i);
  assert.match(migration, /deleted_at/i);
  assert.match(migration, /deletion_idempotency_key\s+TEXT\s+UNIQUE/i);
  assert.match(migration, /attempt_id\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  assert.doesNotMatch(wrangler, /PROJECTS_DB|PROJECT_BLOBS|ACCESS_TEAM_DOMAIN|ACCESS_AUD|OWNER_EMAILS/);
  assert.match(localWrangler, /binding\s*=\s*"PROJECTS_DB"/);
  assert.match(localWrangler, /binding\s*=\s*"PROJECT_BLOBS"/);
  assert.doesNotMatch(localWrangler, /ACCESS_TEAM_DOMAIN\s*=\s*""|ACCESS_AUD\s*=\s*""|OWNER_EMAILS\s*=\s*""/);
  assert.doesNotMatch(wrangler, /LOCAL_ACCESS_JWKS|LIGHTWEAVER_LOCAL_AUTH/);
  assert.doesNotMatch(wrangler, /database_id\s*=|preview_database_id\s*=/);

  const pkg = JSON.parse(packageText);
  assert.match(pkg.scripts['test:projects'], /library-api\.test\.js/);
  assert.match(pkg.scripts['test:projects'], /cloud-bindings\.mjs/);
  assert.equal(pkg.scripts['test:cloud-bindings'], 'node tests/cloud-bindings.mjs');
  assert.match(pkg.scripts['build:functions'] || '', /^mkdir -p \.pages\/functions-build && wrangler pages functions build /);
  assert.match(pkg.scripts['build:functions'] || '', /--output-routes-path \.pages\/functions-build\/_routes\.json/);
  assert.match(pkg.scripts['deploy:pages'], /^node scripts\/require-cloud-library-production\.mjs && /);
  for (const required of [
    'LIGHTWEAVER_PRODUCTION_LIBRARY_READY',
    'PROJECTS_DB_DATABASE_ID',
    'PROJECT_BLOBS_BUCKET_NAME',
    'ACCESS_TEAM_DOMAIN',
    'ACCESS_AUD',
    'OWNER_EMAILS',
  ]) assert.match(productionGuard, new RegExp(required));
  assert.match(gitignore, /\.wrangler/);
  assert.match(gitignore, /\.dev\.vars/);
  assert.match(gitignore, /\.env/);
});

test('production deploy guard fails closed without real library configuration', async () => {
  const guard = join(PROJECT_DIR, 'scripts', 'require-cloud-library-production.mjs');
  const child = spawn(process.execPath, [guard], {
    cwd: PROJECT_DIR,
    env: {
      PATH: process.env.PATH,
      PROJECTS_DB_DATABASE_ID: '',
      PROJECT_BLOBS_BUCKET_NAME: '',
      ACCESS_TEAM_DOMAIN: '',
      ACCESS_AUD: '',
      OWNER_EMAILS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');

  assert.equal(code, 1);
  assert.match(stderr, /production deployment is blocked/i);
  assert.match(stderr, /PROJECTS_DB_DATABASE_ID/);
  assert.match(stderr, /LIGHTWEAVER_PRODUCTION_LIBRARY_READY=confirmed/);
});
