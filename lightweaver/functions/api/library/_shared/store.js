import { createLibraryBackup } from './backup.js';
import {
  DEFAULT_MAX_BACKUP_BYTES,
  validateBaseRevision,
  validateMasterBackup,
  validatePortableProject,
  validateProjectTitle,
  validateWorkspaceAsset,
} from './validation.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BACKUP_REVISIONS = 10_000;

export class LibraryStoreError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'LibraryStoreError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new LibraryStoreError(code, message, status);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function contentDetails(value) {
  const text = canonicalJson(value);
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { hash, bytes: encoded.byteLength, text };
}

function publicProject(row) {
  const project = {
    id: row.id,
    embeddedProjectId: row.embedded_project_id,
    title: row.title,
    archived: row.archived === 1,
    revision: row.current_revision,
    hash: row.current_hash,
    bytes: row.current_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    lastEditor: row.last_editor,
  };
  if (row.draft_of_project_id) {
    project.draftOfProjectId = row.draft_of_project_id;
    project.draftOwnerAccountId = row.draft_owner_account_id;
    if (row.official_title) project.officialTitle = row.official_title;
  }
  return project;
}

function publicRevision(row) {
  return {
    revision: row.revision,
    archived: row.archived === 1,
    hash: row.content_hash,
    bytes: row.byte_length,
    createdAt: row.created_at,
    editor: row.editor,
  };
}

function actorEmail(actor) {
  return typeof actor?.email === 'string' && actor.email ? actor.email : 'unknown';
}

function mutationStatement(db, {
  actor,
  attemptId,
  conditionSql = '1',
  conditionValues = [],
  idempotencyKey,
  kind,
  timestamp,
}) {
  return db.prepare(`
    INSERT INTO library_mutations (idempotency_key, attempt_id, mutation_kind, actor, created_at)
    SELECT CASE WHEN (${conditionSql}) THEN ? ELSE NULL END, ?, ?, ?, ?
  `).bind(...conditionValues, idempotencyKey, attemptId, kind, actorEmail(actor), timestamp);
}

export function createD1R2LibraryStore(env, options = {}) {
  if (!env?.PROJECTS_DB || !env?.PROJECT_BLOBS) return null;
  const db = env.PROJECTS_DB;
  const bucket = env.PROJECT_BLOBS;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const maxBackupBytes = Number.isFinite(options.maxBackupBytes) && options.maxBackupBytes > 0
    ? options.maxBackupBytes
    : DEFAULT_MAX_BACKUP_BYTES;
  const maxBackupRevisions = Number.isInteger(options.maxBackupRevisions) && options.maxBackupRevisions > 0
    ? options.maxBackupRevisions
    : DEFAULT_MAX_BACKUP_REVISIONS;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  function timestamp() {
    const value = now();
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }

  function requireSharedRole(identity) {
    if (identity?.role !== 'owner' && identity?.role !== 'worker') {
      fail('forbidden', 'This library operation is not allowed.', 403);
    }
  }

  function requireOwner(identity, { native = false } = {}) {
    if (identity?.role !== 'owner' || (native && typeof identity?.accountId !== 'string')) {
      fail('forbidden', 'Only a native owner may perform this operation.', 403);
    }
  }

  async function unusedKey(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      fail('invalid_request', 'An idempotency key is required.', 400);
    }
    const accepted = await db.prepare(
      'SELECT idempotency_key FROM library_mutations WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first();
    if (accepted) fail('idempotency_conflict', 'The idempotency key was already accepted.', 409);
  }

  async function acceptedMutation(idempotencyKey) {
    return db.prepare(
      'SELECT * FROM library_mutations WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first();
  }

  async function acceptedKey(idempotencyKey) {
    return Boolean(await acceptedMutation(idempotencyKey));
  }

  async function cleanupObjects(keys) {
    if (!keys.length) return;
    for (let index = 0; index < keys.length; index += 1000) {
      const chunk = keys.slice(index, index + 1000);
      try {
        await bucket.delete(chunk.length === 1 ? chunk[0] : chunk);
      } catch {
        // Orphans are private and unreachable. A later maintenance pass may remove them.
      }
    }
  }

  async function deleteObjectsRequired(keys) {
    for (let index = 0; index < keys.length; index += 1000) {
      const chunk = keys.slice(index, index + 1000);
      await bucket.delete(chunk.length === 1 ? chunk[0] : chunk);
    }
  }

  async function cleanupUnreferencedObjects(keys) {
    if (!keys.length) return;
    const referenced = new Set();
    for (let index = 0; index < keys.length; index += 25) {
      const chunk = keys.slice(index, index + 25);
      const placeholders = chunk.map(() => '?').join(', ');
      const { results } = await db.prepare(`
        SELECT current_object_key AS object_key FROM projects
          WHERE current_object_key IN (${placeholders})
        UNION SELECT object_key FROM project_revisions
          WHERE object_key IN (${placeholders})
        UNION SELECT current_object_key AS object_key FROM asset_heads
          WHERE current_object_key IN (${placeholders})
        UNION SELECT object_key FROM asset_revisions
          WHERE object_key IN (${placeholders})
      `).bind(...chunk, ...chunk, ...chunk, ...chunk).all();
      for (const row of results) referenced.add(row.object_key);
    }
    await cleanupObjects(keys.filter(key => !referenced.has(key)));
  }

  async function guardedBatch(statements, {
    attemptId,
    cleanup = [],
    idempotencyKey,
    onConflict,
  }) {
    try {
      return await db.batch(statements);
    } catch (error) {
      const accepted = await acceptedMutation(idempotencyKey);
      await cleanupUnreferencedObjects(cleanup);
      if (accepted?.attempt_id === attemptId) {
        return [];
      }
      if (accepted) {
        fail('idempotency_conflict', 'The idempotency key was already accepted.', 409);
      }
      if (onConflict && await onConflict()) {
        fail('revision_conflict', 'The record changed since it was opened.', 409);
      }
      throw error;
    }
  }

  async function putBody(key, details) {
    const result = await bucket.put(key, details.text, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      onlyIf: { etagDoesNotMatch: '*' },
      sha256: details.hash,
    });
    if (!result) throw new Error('The immutable object already exists.');
  }

  async function readBody(key, expectedHash) {
    const object = await bucket.get(key);
    if (!object) fail('not_found', 'The stored library body was not found.', 404);
    const text = await object.text();
    const parsed = JSON.parse(text);
    const details = await contentDetails(parsed);
    if (details.hash !== expectedHash) throw new Error('Stored library body integrity check failed.');
    return parsed;
  }

  async function rawProjectRow(id, { includeDeleted = false } = {}) {
    const row = await db.prepare(`
      SELECT * FROM projects WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `).bind(id).first();
    if (!row) fail('not_found', 'The requested project was not found.', 404);
    return row;
  }

  async function customerHasAssignment(row, identity) {
    if (identity?.role !== 'customer'
      || typeof identity.accountId !== 'string'
      || row.draft_owner_account_id !== identity.accountId
      || !row.draft_of_project_id) return false;
    return Boolean(await db.prepare(`
      SELECT id FROM project_assignments
      WHERE customer_account_id = ? AND project_id = ?
    `).bind(identity.accountId, row.draft_of_project_id).first());
  }

  async function projectRow(id, identity, capability = 'read') {
    const row = await rawProjectRow(id);
    if (!row.draft_of_project_id) {
      if (identity?.role === 'owner' || identity?.role === 'worker') return row;
      fail('not_found', 'The requested project was not found.', 404);
    }
    if (identity?.role === 'owner'
      && (capability === 'read' || capability === 'history' || capability === 'delete')) return row;
    const assigned = await customerHasAssignment(row, identity);
    if (assigned && (capability === 'read' || capability === 'history' || capability === 'update')) {
      return row;
    }
    if (identity?.role === 'owner' || assigned) {
      fail('forbidden', 'This project operation is not allowed.', 403);
    }
    fail('not_found', 'The requested project was not found.', 404);
  }

  async function anyProjectRow(id) {
    return db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
  }

  async function requireProjectHead(id, baseRevision, identity, capability = 'update') {
    validateBaseRevision(baseRevision);
    const row = await projectRow(id, identity, capability);
    if (row.current_revision !== baseRevision) {
      fail('revision_conflict', 'The project changed since it was opened.', 409);
    }
    return row;
  }

  async function listProjects({ state = 'active', identity } = {}) {
    const archived = state === 'archived' ? 1 : 0;
    if (identity?.role !== 'owner' && identity?.role !== 'worker' && identity?.role !== 'customer') {
      fail('forbidden', 'This library operation is not allowed.', 403);
    }
    const visibility = identity.role === 'customer'
      ? `p.draft_owner_account_id = ? AND p.draft_of_project_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM project_assignments a
            WHERE a.customer_account_id = ? AND a.project_id = p.draft_of_project_id
          )`
      : 'p.draft_of_project_id IS NULL';
    const visibilityValues = identity.role === 'customer'
      ? [identity.accountId, identity.accountId]
      : [];
    const { results } = await db.prepare(`
      SELECT p.*, official.title AS official_title FROM projects p
      LEFT JOIN projects official ON official.id = p.draft_of_project_id
      WHERE p.archived = ? AND p.deleted_at IS NULL AND ${visibility}
      ORDER BY p.updated_at DESC, p.id ASC
    `).bind(archived, ...visibilityValues).all();
    return results.map(publicProject);
  }

  async function createProject({ title, project, actor, idempotencyKey }) {
    requireSharedRole(actor);
    await unusedKey(idempotencyKey);
    const cleanTitle = validateProjectTitle(title);
    const document = validatePortableProject(project, { maxBytes });
    const details = await contentDetails(document);
    const id = crypto.randomUUID();
    const createdAt = timestamp();
    const attemptId = crypto.randomUUID();
    const objectKey = `projects/${id}/revisions/1-${crypto.randomUUID()}.lw.json`;
    await putBody(objectKey, details);

    const statements = [
      db.prepare(`
        INSERT INTO projects (
          id, embedded_project_id, title, archived, current_revision, current_object_key,
          current_hash, current_bytes, created_at, updated_at, created_by, last_editor
        ) VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, document.id, cleanTitle, objectKey, details.hash, details.bytes,
        createdAt, createdAt, actorEmail(actor), actorEmail(actor),
      ),
      db.prepare(`
        INSERT INTO project_revisions (
          project_id, revision, archived, object_key, content_hash, byte_length,
          project_version, created_at, editor
        ) VALUES (?, 1, 0, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, objectKey, details.hash, details.bytes, document.version, createdAt, actorEmail(actor),
      ),
      mutationStatement(db, {
        actor,
        attemptId,
        conditionSql: 'EXISTS (SELECT 1 FROM projects WHERE id = ? AND current_object_key = ?)',
        conditionValues: [id, objectKey],
        idempotencyKey,
        kind: 'create-project',
        timestamp: createdAt,
      }),
    ];
    await guardedBatch(statements, {
      attemptId,
      cleanup: [objectKey],
      idempotencyKey,
    });
    return publicProject(await rawProjectRow(id));
  }

  async function readProject({ id, identity }) {
    const row = await projectRow(id, identity);
    const document = validatePortableProject(
      await readBody(row.current_object_key, row.current_hash),
      { maxBytes },
    );
    return { ...publicProject(row), document };
  }

  async function updateProject({ id, title, project, baseRevision, actor, idempotencyKey }) {
    await unusedKey(idempotencyKey);
    const head = await requireProjectHead(id, baseRevision, actor, 'update');
    const cleanTitle = title === undefined ? head.title : validateProjectTitle(title);
    const document = validatePortableProject(project, { maxBytes });
    if (document.id !== head.embedded_project_id) {
      fail('invalid_project', 'An update cannot change the embedded project identity.', 400);
    }
    const revision = baseRevision + 1;
    const details = await contentDetails(document);
    const updatedAt = timestamp();
    const attemptId = crypto.randomUUID();
    const objectKey = `projects/${id}/revisions/${revision}-${crypto.randomUUID()}.lw.json`;
    await putBody(objectKey, details);

    const statements = [
      db.prepare(`
        INSERT INTO project_revisions (
          project_id, revision, archived, object_key, content_hash, byte_length,
          project_version, created_at, editor
        )
        SELECT id, ?, archived, ?, ?, ?, ?, ?, ? FROM projects
        WHERE id = ? AND current_revision = ? AND deleted_at IS NULL
      `).bind(
        revision, objectKey, details.hash, details.bytes, document.version,
        updatedAt, actorEmail(actor), id, baseRevision,
      ),
      db.prepare(`
        UPDATE projects SET
          title = ?, current_revision = ?, current_object_key = ?, current_hash = ?,
          current_bytes = ?, updated_at = ?, last_editor = ?
        WHERE id = ? AND current_revision = ? AND deleted_at IS NULL
      `).bind(
        cleanTitle, revision, objectKey, details.hash, details.bytes, updatedAt,
        actorEmail(actor), id, baseRevision,
      ),
      mutationStatement(db, {
        actor,
        attemptId,
        conditionSql: 'EXISTS (SELECT 1 FROM projects WHERE id = ? AND current_revision = ? AND current_object_key = ?)',
        conditionValues: [id, revision, objectKey],
        idempotencyKey,
        kind: 'update-project',
        timestamp: updatedAt,
      }),
    ];
    await guardedBatch(statements, {
      attemptId,
      cleanup: [objectKey],
      idempotencyKey,
      onConflict: async () => (await rawProjectRow(id)).current_revision !== baseRevision,
    });
    return publicProject(await rawProjectRow(id));
  }

  async function duplicateProject({ id, title, actor, idempotencyKey }) {
    requireSharedRole(actor);
    await unusedKey(idempotencyKey);
    const source = await readProject({ id, identity: actor });
    if (source.draftOfProjectId) fail('forbidden', 'Customer drafts cannot be duplicated.', 403);
    const cleanTitle = validateProjectTitle(title || `${source.title} Copy`);
    const document = structuredClone(source.document);
    document.id = `lwproj-${crypto.randomUUID()}`;
    document.name = cleanTitle;
    return createProject({ title: cleanTitle, project: document, actor, idempotencyKey });
  }

  async function setArchived({ id, archived, baseRevision, actor, idempotencyKey }) {
    requireSharedRole(actor);
    await unusedKey(idempotencyKey);
    await requireProjectHead(id, baseRevision, actor);
    const nextArchived = archived === true ? 1 : 0;
    const revision = baseRevision + 1;
    const updatedAt = timestamp();
    const attemptId = crypto.randomUUID();
    const statements = [
      db.prepare(`
        INSERT INTO project_revisions (
          project_id, revision, archived, object_key, content_hash, byte_length,
          project_version, created_at, editor
        )
        SELECT p.id, ?, ?, p.current_object_key, p.current_hash, p.current_bytes,
          r.project_version, ?, ?
        FROM projects p
        JOIN project_revisions r
          ON r.project_id = p.id AND r.revision = p.current_revision
        WHERE p.id = ? AND p.current_revision = ? AND p.deleted_at IS NULL
      `).bind(revision, nextArchived, updatedAt, actorEmail(actor), id, baseRevision),
      db.prepare(`
        UPDATE projects SET archived = ?, current_revision = ?, updated_at = ?, last_editor = ?
        WHERE id = ? AND current_revision = ? AND deleted_at IS NULL
      `).bind(nextArchived, revision, updatedAt, actorEmail(actor), id, baseRevision),
      mutationStatement(db, {
        actor,
        attemptId,
        conditionSql: 'EXISTS (SELECT 1 FROM projects WHERE id = ? AND current_revision = ? AND archived = ?)',
        conditionValues: [id, revision, nextArchived],
        idempotencyKey,
        kind: nextArchived ? 'archive-project' : 'unarchive-project',
        timestamp: updatedAt,
      }),
    ];
    await guardedBatch(statements, {
      attemptId,
      idempotencyKey,
      onConflict: async () => (await rawProjectRow(id)).current_revision !== baseRevision,
    });
    return publicProject(await rawProjectRow(id));
  }

  async function deleteProject({ id, baseRevision, actor, idempotencyKey }) {
    requireOwner(actor);
    validateBaseRevision(baseRevision);
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      fail('invalid_request', 'An idempotency key is required.', 400);
    }
    let deletion = await anyProjectRow(id);
    if (!deletion) {
      if (await acceptedKey(idempotencyKey)) {
        fail('idempotency_conflict', 'The idempotency key was already accepted.', 409);
      }
      fail('not_found', 'The requested project was not found.', 404);
    }
    if (deletion.deleted_at) {
      if (deletion.deletion_idempotency_key !== idempotencyKey
        || deletion.current_revision !== baseRevision) {
        fail('revision_conflict', 'The project deletion is already in progress.', 409);
      }
    } else {
      await unusedKey(idempotencyKey);
      if (deletion.current_revision !== baseRevision) {
        fail('revision_conflict', 'The project changed since it was opened.', 409);
      }
      const deletedAt = timestamp();
      const attemptId = crypto.randomUUID();
      const tombstone = [
        mutationStatement(db, {
          actor,
          attemptId,
          conditionSql: 'EXISTS (SELECT 1 FROM projects WHERE id = ? AND current_revision = ? AND deleted_at IS NULL)',
          conditionValues: [id, baseRevision],
          idempotencyKey,
          kind: 'delete-project',
          timestamp: deletedAt,
        }),
        db.prepare(`
          UPDATE projects SET
            deleted_at = ?, deletion_idempotency_key = ?, updated_at = ?, last_editor = ?
          WHERE id = ? AND current_revision = ? AND deleted_at IS NULL
        `).bind(
          deletedAt, idempotencyKey, deletedAt, actorEmail(actor), id, baseRevision,
        ),
      ];
      if (!deletion.draft_of_project_id) {
        tombstone.push(db.prepare(`
          UPDATE projects SET deleted_at = ?, updated_at = ?, last_editor = ?
          WHERE draft_of_project_id = ? AND deleted_at IS NULL
        `).bind(deletedAt, deletedAt, actorEmail(actor), id));
      }
      try {
        await db.batch(tombstone);
      } catch (error) {
        deletion = await anyProjectRow(id);
        if (deletion?.deleted_at
          && deletion.deletion_idempotency_key === idempotencyKey
          && deletion.current_revision === baseRevision) {
          // A concurrent retry with this same key won the tombstone CAS; resume cleanup.
        } else if (await acceptedKey(idempotencyKey)) {
          fail('idempotency_conflict', 'The idempotency key was already accepted.', 409);
        } else if (!deletion
          || deletion.deleted_at
          || deletion.current_revision !== baseRevision) {
          fail('revision_conflict', 'The project changed since it was opened.', 409);
        } else {
          throw error;
        }
      }
      deletion = await anyProjectRow(id);
      if (!deletion?.deleted_at || deletion.deletion_idempotency_key !== idempotencyKey) {
        throw new Error('The project deletion tombstone was not committed.');
      }
    }

    const deletingOfficial = !deletion.draft_of_project_id;
    const { results: revisions } = await db.prepare(deletingOfficial ? `
      SELECT DISTINCT r.object_key FROM project_revisions r
      JOIN projects p ON p.id = r.project_id
      WHERE p.id = ? OR p.draft_of_project_id = ?
    ` : `
      SELECT DISTINCT object_key FROM project_revisions WHERE project_id = ?
    `).bind(...(deletingOfficial ? [id, id] : [id])).all();
    await deleteObjectsRequired(revisions.map(row => row.object_key));
    const statements = deletingOfficial ? [
      db.prepare('DELETE FROM project_assignments WHERE project_id = ?').bind(id),
      db.prepare(`
        DELETE FROM project_revisions
        WHERE project_id = ? OR project_id IN (
          SELECT id FROM projects WHERE draft_of_project_id = ?
        )
      `).bind(id, id),
      db.prepare('DELETE FROM projects WHERE draft_of_project_id = ?').bind(id),
      db.prepare(`
        DELETE FROM projects
        WHERE id = ? AND current_revision = ? AND deletion_idempotency_key = ?
      `).bind(id, baseRevision, idempotencyKey),
    ] : [
      db.prepare(`
        DELETE FROM project_assignments
        WHERE (customer_account_id, project_id) IN (
          SELECT draft_owner_account_id, draft_of_project_id FROM projects WHERE id = ?
        )
      `).bind(id),
      db.prepare(`
        DELETE FROM project_revisions
        WHERE project_id = ?
          AND EXISTS (
            SELECT 1 FROM projects
            WHERE id = ? AND current_revision = ? AND deletion_idempotency_key = ?
          )
      `).bind(id, id, baseRevision, idempotencyKey),
      db.prepare(`
        DELETE FROM projects
        WHERE id = ? AND current_revision = ? AND deletion_idempotency_key = ?
      `).bind(id, baseRevision, idempotencyKey),
    ];
    const results = await db.batch(statements);
    if ((results.at(-1)?.meta?.changes || 0) === 0 && await anyProjectRow(id)) {
      throw new Error('The project deletion could not be finalized.');
    }
    return { deleted: true };
  }

  async function listRevisions({ id, identity }) {
    await projectRow(id, identity, 'history');
    const { results } = await db.prepare(`
      SELECT revision, archived, content_hash, byte_length, created_at, editor
      FROM project_revisions WHERE project_id = ? ORDER BY revision DESC
    `).bind(id).all();
    return results.map(publicRevision);
  }

  async function restoreRevision({ id, revision: sourceRevision, baseRevision, actor, idempotencyKey }) {
    requireSharedRole(actor);
    await unusedKey(idempotencyKey);
    const head = await requireProjectHead(id, baseRevision, actor);
    const source = await db.prepare(`
      SELECT * FROM project_revisions WHERE project_id = ? AND revision = ?
    `).bind(id, sourceRevision).first();
    if (!source) fail('revision_not_found', 'The requested revision was not found.', 404);
    const document = validatePortableProject(
      await readBody(source.object_key, source.content_hash),
      { maxBytes },
    );
    const nextRevision = baseRevision + 1;
    const details = await contentDetails(document);
    const updatedAt = timestamp();
    const attemptId = crypto.randomUUID();
    const objectKey = `projects/${id}/revisions/${nextRevision}-${crypto.randomUUID()}.lw.json`;
    await putBody(objectKey, details);
    const statements = [
      db.prepare(`
        INSERT INTO project_revisions (
          project_id, revision, archived, object_key, content_hash, byte_length,
          project_version, created_at, editor
        )
        SELECT id, ?, archived, ?, ?, ?, ?, ?, ? FROM projects
        WHERE id = ? AND current_revision = ? AND deleted_at IS NULL
      `).bind(
        nextRevision, objectKey, details.hash, details.bytes, document.version,
        updatedAt, actorEmail(actor), id, baseRevision,
      ),
      db.prepare(`
        UPDATE projects SET current_revision = ?, current_object_key = ?, current_hash = ?,
          current_bytes = ?, updated_at = ?, last_editor = ?
        WHERE id = ? AND current_revision = ? AND deleted_at IS NULL
      `).bind(
        nextRevision, objectKey, details.hash, details.bytes, updatedAt,
        actorEmail(actor), id, baseRevision,
      ),
      mutationStatement(db, {
        actor,
        attemptId,
        conditionSql: 'EXISTS (SELECT 1 FROM projects WHERE id = ? AND current_revision = ? AND current_object_key = ?)',
        conditionValues: [id, nextRevision, objectKey],
        idempotencyKey,
        kind: 'restore-project-revision',
        timestamp: updatedAt,
      }),
    ];
    await guardedBatch(statements, {
      attemptId,
      cleanup: [objectKey],
      idempotencyKey,
      onConflict: async () => (await rawProjectRow(id)).current_revision !== baseRevision,
    });
    return publicProject(await rawProjectRow(id));
  }

  async function assetRow(kind) {
    return db.prepare('SELECT * FROM asset_heads WHERE asset_kind = ?').bind(kind).first();
  }

  async function readAsset({ kind, identity }) {
    requireSharedRole(identity);
    const row = await assetRow(kind);
    if (!row) fail('not_found', 'The requested workspace asset was not found.', 404);
    const value = validateWorkspaceAsset(
      kind,
      await readBody(row.current_object_key, row.current_hash),
      { maxBytes },
    );
    return {
      kind,
      revision: row.current_revision,
      hash: row.current_hash,
      bytes: row.current_bytes,
      updatedAt: row.updated_at,
      lastEditor: row.last_editor,
      value,
    };
  }

  async function writeAsset({ kind, value, baseRevision, actor, idempotencyKey }) {
    requireSharedRole(actor);
    await unusedKey(idempotencyKey);
    validateBaseRevision(baseRevision);
    const current = await assetRow(kind);
    const currentRevision = current?.current_revision || 0;
    if (currentRevision !== baseRevision) {
      fail('revision_conflict', 'The workspace asset changed since it was opened.', 409);
    }
    const normalized = validateWorkspaceAsset(kind, value, { maxBytes });
    const revision = baseRevision + 1;
    const details = await contentDetails(normalized);
    const updatedAt = timestamp();
    const attemptId = crypto.randomUUID();
    const objectKey = `workspace-assets/${encodeURIComponent(kind)}/revisions/${revision}-${crypto.randomUUID()}.json`;
    await putBody(objectKey, details);

    const statements = current ? [
      db.prepare(`
        INSERT INTO asset_revisions (
          asset_kind, revision, object_key, content_hash, byte_length, created_at, editor
        )
        SELECT asset_kind, ?, ?, ?, ?, ?, ? FROM asset_heads
        WHERE asset_kind = ? AND current_revision = ?
      `).bind(
        revision, objectKey, details.hash, details.bytes, updatedAt,
        actorEmail(actor), kind, baseRevision,
      ),
      db.prepare(`
        UPDATE asset_heads SET current_revision = ?, current_object_key = ?, current_hash = ?,
          current_bytes = ?, updated_at = ?, last_editor = ?
        WHERE asset_kind = ? AND current_revision = ?
      `).bind(
        revision, objectKey, details.hash, details.bytes, updatedAt,
        actorEmail(actor), kind, baseRevision,
      ),
    ] : [
      db.prepare(`
        INSERT INTO asset_heads (
          asset_kind, current_revision, current_object_key, current_hash,
          current_bytes, updated_at, last_editor
        )
        SELECT ?, 1, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM asset_heads WHERE asset_kind = ?)
      `).bind(
        kind, objectKey, details.hash, details.bytes, updatedAt,
        actorEmail(actor), kind,
      ),
      db.prepare(`
        INSERT INTO asset_revisions (
          asset_kind, revision, object_key, content_hash, byte_length, created_at, editor
        )
        SELECT asset_kind, 1, ?, ?, ?, ?, ? FROM asset_heads
        WHERE asset_kind = ? AND current_revision = 1 AND current_object_key = ?
      `).bind(
        objectKey, details.hash, details.bytes, updatedAt,
        actorEmail(actor), kind, objectKey,
      ),
    ];
    statements.push(mutationStatement(db, {
      actor,
      attemptId,
      conditionSql: 'EXISTS (SELECT 1 FROM asset_heads WHERE asset_kind = ? AND current_revision = ? AND current_object_key = ?)',
      conditionValues: [kind, revision, objectKey],
      idempotencyKey,
      kind: 'write-workspace-asset',
      timestamp: updatedAt,
    }));
    await guardedBatch(statements, {
      attemptId,
      cleanup: [objectKey],
      idempotencyKey,
      onConflict: async () => (await assetRow(kind))?.current_revision !== baseRevision,
    });
    return readAsset({ kind, identity: actor });
  }

  async function exportBackup({ exportedAt = timestamp(), identity } = {}) {
    requireSharedRole(identity);
    const projectStats = await db.prepare(`
      SELECT COUNT(DISTINCT p.id) AS entry_count,
        COUNT(r.id) AS revision_count,
        COALESCE(SUM(r.byte_length), 0) AS body_bytes
      FROM projects p
      LEFT JOIN project_revisions r ON r.project_id = p.id
      WHERE p.deleted_at IS NULL AND p.draft_of_project_id IS NULL
    `).first();
    const assetStats = await db.prepare(`
      SELECT COUNT(DISTINCT h.asset_kind) AS entry_count,
        COUNT(r.id) AS revision_count,
        COALESCE(SUM(r.byte_length), 0) AS body_bytes
      FROM asset_heads h
      LEFT JOIN asset_revisions r ON r.asset_kind = h.asset_kind
    `).first();
    const revisionCount = Number(projectStats.revision_count) + Number(assetStats.revision_count);
    const estimatedBytes = Number(projectStats.body_bytes)
      + Number(assetStats.body_bytes)
      + revisionCount * 256
      + Number(projectStats.entry_count) * 384
      + Number(assetStats.entry_count) * 256
      + 1024;
    if (revisionCount > maxBackupRevisions || estimatedBytes > maxBackupBytes) {
      fail('backup_too_large', 'The project library is too large for one backup response.', 413);
    }

    const { results: projects } = await db.prepare(`
      SELECT * FROM projects
      WHERE deleted_at IS NULL AND draft_of_project_id IS NULL
      ORDER BY created_at, id
    `).all();
    const backedUpProjects = [];
    for (const project of projects) {
      const { results: revisions } = await db.prepare(`
        SELECT * FROM project_revisions WHERE project_id = ? ORDER BY revision
      `).bind(project.id).all();
      const exportedRevisions = [];
      for (const revision of revisions) {
        exportedRevisions.push({
          revision: revision.revision,
          archived: revision.archived === 1,
          createdAt: revision.created_at,
          document: validatePortableProject(
            await readBody(revision.object_key, revision.content_hash),
            { maxBytes },
          ),
        });
      }
      backedUpProjects.push({
        id: project.id,
        title: project.title,
        archived: project.archived === 1,
        currentRevision: project.current_revision,
        revisions: exportedRevisions,
      });
    }

    const { results: assets } = await db.prepare('SELECT * FROM asset_heads ORDER BY asset_kind').all();
    const workspaceAssets = [];
    for (const asset of assets) {
      const { results: revisions } = await db.prepare(`
        SELECT * FROM asset_revisions WHERE asset_kind = ? ORDER BY revision
      `).bind(asset.asset_kind).all();
      const exportedRevisions = [];
      for (const revision of revisions) {
        exportedRevisions.push({
          revision: revision.revision,
          createdAt: revision.created_at,
          value: validateWorkspaceAsset(
            asset.asset_kind,
            await readBody(revision.object_key, revision.content_hash),
            { maxBytes },
          ),
        });
      }
      workspaceAssets.push({
        kind: asset.asset_kind,
        currentRevision: asset.current_revision,
        revisions: exportedRevisions,
      });
    }
    return createLibraryBackup({ exportedAt, projects: backedUpProjects, workspaceAssets });
  }

  function uniqueRestoredTitle(title, occupied) {
    if (!occupied.has(title.toLocaleLowerCase())) return title;
    let index = 1;
    while (true) {
      const suffix = index === 1 ? ' (restored)' : ` (restored ${index})`;
      const candidate = `${title.slice(0, Math.max(1, 160 - suffix.length))}${suffix}`;
      if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
      index += 1;
    }
  }

  async function importBackup({ backup, actor, idempotencyKey }) {
    requireSharedRole(actor);
    await unusedKey(idempotencyKey);
    const normalized = validateMasterBackup(backup, {
      maxBackupBytes,
      maxEntryBytes: maxBytes,
    });
    const { results: existingProjects } = await db.prepare(`
      SELECT id, embedded_project_id, title FROM projects
      WHERE deleted_at IS NULL
    `).all();
    const occupiedIds = new Set(existingProjects.map(row => row.id));
    const occupiedEmbeddedIds = new Set(existingProjects.map(row => row.embedded_project_id));
    const occupiedTitles = new Set(existingProjects.map(row => row.title.toLocaleLowerCase()));
    const statements = [];
    const objectKeys = [];
    const conditions = [];
    const conditionValues = [];
    const importedAt = timestamp();
    const attemptId = crypto.randomUUID();

    try {
      for (const source of normalized.projects) {
      const sourceHead = source.revisions.find(revision => revision.revision === source.currentRevision);
      const unsafeId = !/^[a-zA-Z0-9_-]{1,128}$/.test(source.id);
      const remoteCollision = unsafeId || occupiedIds.has(source.id);
      const embeddedCollision = occupiedEmbeddedIds.has(sourceHead.document.id);
      const id = remoteCollision ? crypto.randomUUID() : source.id;
      const embeddedProjectId = embeddedCollision ? `lwproj-${crypto.randomUUID()}` : sourceHead.document.id;
      const title = remoteCollision || embeddedCollision
        ? uniqueRestoredTitle(source.title, occupiedTitles)
        : validateProjectTitle(source.title);
      const planned = [];
      for (const revision of source.revisions.slice().sort((left, right) => left.revision - right.revision)) {
        const document = structuredClone(revision.document);
        document.id = embeddedProjectId;
        const normalizedDocument = validatePortableProject(document, { maxBytes });
        const details = await contentDetails(normalizedDocument);
        const createdAt = revision.createdAt && Number.isFinite(Date.parse(revision.createdAt))
          ? revision.createdAt
          : importedAt;
        const objectKey = `projects/${id}/revisions/${revision.revision}-${crypto.randomUUID()}.lw.json`;
        await putBody(objectKey, details);
        objectKeys.push(objectKey);
        planned.push({
          archived: revision.archived ? 1 : 0,
          createdAt,
          details,
          document: normalizedDocument,
          objectKey,
          revision: revision.revision,
        });
      }
      const head = planned.find(revision => revision.revision === source.currentRevision);
      statements.push(db.prepare(`
        INSERT INTO projects (
          id, embedded_project_id, title, archived, current_revision, current_object_key,
          current_hash, current_bytes, created_at, updated_at, created_by, last_editor
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, embeddedProjectId, title, source.archived ? 1 : 0, source.currentRevision,
        head.objectKey, head.details.hash, head.details.bytes, planned[0].createdAt,
        head.createdAt, actorEmail(actor), actorEmail(actor),
      ));
      for (const revision of planned) {
        statements.push(db.prepare(`
          INSERT INTO project_revisions (
            project_id, revision, archived, object_key, content_hash, byte_length,
            project_version, created_at, editor
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id, revision.revision, revision.archived, revision.objectKey,
          revision.details.hash, revision.details.bytes, revision.document.version,
          revision.createdAt, actorEmail(actor),
        ));
      }
      conditions.push('EXISTS (SELECT 1 FROM projects WHERE id = ? AND current_object_key = ?)');
      conditionValues.push(id, head.objectKey);
      occupiedIds.add(id);
      occupiedEmbeddedIds.add(embeddedProjectId);
      occupiedTitles.add(title.toLocaleLowerCase());
      }

      for (const source of normalized.workspaceAssets) {
      const existing = await assetRow(source.kind);
      const offset = existing?.current_revision || 0;
      const planned = [];
      for (const sourceRevision of source.revisions.slice().sort((left, right) => left.revision - right.revision)) {
        const value = validateWorkspaceAsset(source.kind, sourceRevision.value, { maxBytes });
        const details = await contentDetails(value);
        const revision = offset + planned.length + 1;
        const createdAt = sourceRevision.createdAt && Number.isFinite(Date.parse(sourceRevision.createdAt))
          ? sourceRevision.createdAt
          : importedAt;
        const objectKey = `workspace-assets/${encodeURIComponent(source.kind)}/revisions/${revision}-${crypto.randomUUID()}.json`;
        await putBody(objectKey, details);
        objectKeys.push(objectKey);
        planned.push({ createdAt, details, objectKey, revision });
      }
      const head = planned.at(-1);
      if (existing) {
        for (const revision of planned) {
          statements.push(db.prepare(`
            INSERT INTO asset_revisions (
              asset_kind, revision, object_key, content_hash, byte_length, created_at, editor
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            source.kind, revision.revision, revision.objectKey, revision.details.hash,
            revision.details.bytes, revision.createdAt, actorEmail(actor),
          ));
        }
        statements.push(db.prepare(`
          UPDATE asset_heads SET current_revision = ?, current_object_key = ?, current_hash = ?,
            current_bytes = ?, updated_at = ?, last_editor = ?
          WHERE asset_kind = ? AND current_revision = ?
        `).bind(
          head.revision, head.objectKey, head.details.hash, head.details.bytes,
          head.createdAt, actorEmail(actor), source.kind, offset,
        ));
      } else {
        statements.push(db.prepare(`
          INSERT INTO asset_heads (
            asset_kind, current_revision, current_object_key, current_hash,
            current_bytes, updated_at, last_editor
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          source.kind, head.revision, head.objectKey, head.details.hash,
          head.details.bytes, head.createdAt, actorEmail(actor),
        ));
        for (const revision of planned) {
          statements.push(db.prepare(`
            INSERT INTO asset_revisions (
              asset_kind, revision, object_key, content_hash, byte_length, created_at, editor
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            source.kind, revision.revision, revision.objectKey, revision.details.hash,
            revision.details.bytes, revision.createdAt, actorEmail(actor),
          ));
        }
      }
      conditions.push('EXISTS (SELECT 1 FROM asset_heads WHERE asset_kind = ? AND current_object_key = ?)');
      conditionValues.push(source.kind, head.objectKey);
      }
    } catch (error) {
      await cleanupObjects(objectKeys);
      throw error;
    }

    statements.push(mutationStatement(db, {
      actor,
      attemptId,
      conditionSql: conditions.length ? conditions.join(' AND ') : '1',
      conditionValues,
      idempotencyKey,
      kind: 'import-library-backup',
      timestamp: importedAt,
    }));
    statements.push(db.prepare(`
      INSERT INTO library_imports (
        idempotency_key, actor, created_at, projects_created, assets_created
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      idempotencyKey, actorEmail(actor), importedAt,
      normalized.projects.length, normalized.workspaceAssets.length,
    ));
    await guardedBatch(statements, {
      attemptId,
      cleanup: objectKeys,
      idempotencyKey,
      onConflict: async () => true,
    });
    return {
      projectsCreated: normalized.projects.length,
      assetsCreated: normalized.workspaceAssets.length,
    };
  }

  async function activeCustomerAccount(id) {
    const account = typeof id === 'string' && id
      ? await db.prepare(`
          SELECT id, role, status FROM accounts
          WHERE id = ? AND role = 'customer' AND status = 'active'
        `).bind(id).first()
      : null;
    if (!account) fail('invalid_assignment', 'Assignments require an active customer account.', 400);
    return account;
  }

  async function customerDraftRow(customerId, officialId) {
    return db.prepare(`
      SELECT draft.*, official.title AS official_title
      FROM projects draft
      JOIN projects official ON official.id = draft.draft_of_project_id
      WHERE draft.draft_owner_account_id = ? AND draft.draft_of_project_id = ?
        AND draft.deleted_at IS NULL AND official.deleted_at IS NULL
    `).bind(customerId, officialId).first();
  }

  async function assignmentResult(customerId, officialId) {
    const row = await db.prepare(`
      SELECT a.created_at AS assigned_at, draft.*, official.title AS official_title
      FROM project_assignments a
      JOIN projects official ON official.id = a.project_id AND official.deleted_at IS NULL
      JOIN projects draft ON draft.draft_of_project_id = official.id
        AND draft.draft_owner_account_id = a.customer_account_id
        AND draft.deleted_at IS NULL
      WHERE a.customer_account_id = ? AND a.project_id = ?
    `).bind(customerId, officialId).first();
    if (!row) throw new Error('The customer assignment was not committed.');
    return {
      customerId,
      projectId: officialId,
      draftProjectId: row.id,
      assignedAt: row.assigned_at,
      project: publicProject(row),
    };
  }

  async function assignCustomerProject({ targetAccount, projectId, actor, idempotencyKey }) {
    requireOwner(actor, { native: true });
    await unusedKey(idempotencyKey);
    const customer = await activeCustomerAccount(targetAccount?.id);
    const official = await rawProjectRow(projectId);
    if (official.draft_of_project_id) fail('not_found', 'The requested project was not found.', 404);
    const existing = await customerDraftRow(customer.id, official.id);
    const assignedAt = timestamp();
    const attemptId = crypto.randomUUID();
    let objectKey;
    let details;
    if (!existing) {
      const document = validatePortableProject(
        await readBody(official.current_object_key, official.current_hash),
        { maxBytes },
      );
      details = await contentDetails(document);
      objectKey = `projects/${crypto.randomUUID()}/assignment-${crypto.randomUUID()}.lw.json`;
      await putBody(objectKey, details);
    }
    const draftId = existing?.id || crypto.randomUUID();
    const statements = [];
    if (!existing) {
      statements.push(db.prepare(`
        INSERT INTO projects (
          id, embedded_project_id, title, archived, current_revision, current_object_key,
          current_hash, current_bytes, created_at, updated_at, created_by, last_editor,
          draft_of_project_id, draft_owner_account_id
        )
        SELECT ?, embedded_project_id, title, 0, 1, ?, ?, ?, ?, ?, ?, ?, id, ?
        FROM projects
        WHERE id = ? AND deleted_at IS NULL AND draft_of_project_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM projects draft
            WHERE draft.draft_of_project_id = ? AND draft.draft_owner_account_id = ?
              AND draft.deleted_at IS NULL
          )
      `).bind(
        draftId, objectKey, details.hash, details.bytes, assignedAt, assignedAt,
        actorEmail(actor), actorEmail(actor), customer.id, official.id, official.id, customer.id,
      ));
      statements.push(db.prepare(`
        INSERT INTO project_revisions (
          project_id, revision, archived, object_key, content_hash, byte_length,
          project_version, created_at, editor
        )
        SELECT id, 1, 0, ?, ?, ?, ?, ?, ? FROM projects
        WHERE draft_of_project_id = ? AND draft_owner_account_id = ?
          AND current_object_key = ? AND deleted_at IS NULL
      `).bind(
        objectKey, details.hash, details.bytes,
        JSON.parse(details.text).version, assignedAt, actorEmail(actor),
        official.id, customer.id, objectKey,
      ));
    }
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO project_assignments (
        customer_account_id, project_id, assigned_by_account_id, created_at
      )
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM projects
        WHERE draft_of_project_id = ? AND draft_owner_account_id = ? AND deleted_at IS NULL
      )
    `).bind(customer.id, official.id, actor.accountId, assignedAt, official.id, customer.id));
    statements.push(mutationStatement(db, {
      actor,
      attemptId,
      conditionSql: `EXISTS (
        SELECT 1 FROM project_assignments
        WHERE customer_account_id = ? AND project_id = ?
      )`,
      conditionValues: [customer.id, official.id],
      idempotencyKey,
      kind: 'assign-customer-project',
      timestamp: assignedAt,
    }));
    await guardedBatch(statements, {
      attemptId,
      cleanup: objectKey ? [objectKey] : [],
      idempotencyKey,
    });
    if (objectKey) await cleanupUnreferencedObjects([objectKey]);
    const assignment = await assignmentResult(customer.id, official.id);
    return { assignment, created: !existing && assignment.project.id === draftId };
  }

  async function unassignCustomerProject({ targetAccount, projectId, actor, idempotencyKey }) {
    requireOwner(actor, { native: true });
    await unusedKey(idempotencyKey);
    const customer = await activeCustomerAccount(targetAccount?.id);
    const official = await rawProjectRow(projectId);
    if (official.draft_of_project_id) fail('not_found', 'The requested project was not found.', 404);
    const removedAt = timestamp();
    const attemptId = crypto.randomUUID();
    await guardedBatch([
      db.prepare(`
        DELETE FROM project_assignments WHERE customer_account_id = ? AND project_id = ?
      `).bind(customer.id, official.id),
      mutationStatement(db, {
        actor,
        attemptId,
        idempotencyKey,
        kind: 'unassign-customer-project',
        timestamp: removedAt,
      }),
    ], { attemptId, idempotencyKey });
    return { unassigned: true };
  }

  async function listCustomerAssignments({ targetAccount, identity }) {
    requireOwner(identity, { native: true });
    const customer = await activeCustomerAccount(targetAccount?.id);
    const { results } = await db.prepare(`
      SELECT a.project_id FROM project_assignments a
      JOIN projects official ON official.id = a.project_id AND official.deleted_at IS NULL
      WHERE a.customer_account_id = ? ORDER BY a.created_at, a.project_id
    `).bind(customer.id).all();
    const assignments = [];
    for (const row of results) assignments.push(await assignmentResult(customer.id, row.project_id));
    return assignments;
  }

  async function listProjectDrafts({ officialId, identity }) {
    requireOwner(identity);
    const official = await rawProjectRow(officialId);
    if (official.draft_of_project_id) fail('not_found', 'The requested project was not found.', 404);
    const { results } = await db.prepare(`
      SELECT draft.*, official.title AS official_title
      FROM projects draft JOIN projects official ON official.id = draft.draft_of_project_id
      WHERE draft.draft_of_project_id = ? AND draft.deleted_at IS NULL
      ORDER BY draft.created_at, draft.id
    `).bind(official.id).all();
    return results.map(publicProject);
  }

  async function promoteDraft({ draftId, officialBaseRevision, actor, idempotencyKey }) {
    requireOwner(actor);
    validateBaseRevision(officialBaseRevision);
    const draft = await rawProjectRow(draftId);
    if (!draft.draft_of_project_id || !draft.draft_owner_account_id) {
      fail('not_found', 'The requested project was not found.', 404);
    }
    const official = await rawProjectRow(draft.draft_of_project_id);
    if (official.current_revision !== officialBaseRevision) {
      fail('revision_conflict', 'The project changed since it was opened.', 409);
    }
    const document = validatePortableProject(
      await readBody(draft.current_object_key, draft.current_hash),
      { maxBytes },
    );
    document.id = official.embedded_project_id;
    document.name = official.title;
    return updateProject({
      id: official.id,
      title: official.title,
      project: document,
      baseRevision: officialBaseRevision,
      actor,
      idempotencyKey,
    });
  }

  return {
    listProjects,
    createProject,
    readProject,
    updateProject,
    duplicateProject,
    setArchived,
    deleteProject,
    listRevisions,
    restoreRevision,
    readAsset,
    writeAsset,
    exportBackup,
    importBackup,
    assignCustomerProject,
    unassignCustomerProject,
    listCustomerAssignments,
    listProjectDrafts,
    promoteDraft,
  };
}
