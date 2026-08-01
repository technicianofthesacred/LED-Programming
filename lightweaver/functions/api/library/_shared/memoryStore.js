import { createLibraryBackup } from './backup.js';
import {
  validateBaseRevision,
  validateMasterBackup,
  validatePortableProject,
  validateProjectTitle,
  validateWorkspaceAsset,
} from './validation.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export class LibraryStoreError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'LibraryStoreError';
    this.code = code;
    this.status = status;
  }
}

function clone(value) {
  return structuredClone(value);
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
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { hash, bytes: bytes.byteLength };
}

function editor(actor) {
  return typeof actor?.email === 'string' ? actor.email : 'unknown';
}

function publicMetadata(record) {
  return {
    id: record.id,
    embeddedProjectId: record.embeddedProjectId,
    title: record.title,
    archived: record.archived,
    revision: record.revision,
    hash: record.hash,
    bytes: record.bytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    lastEditor: record.lastEditor,
  };
}

function publicRevision(revision) {
  return {
    revision: revision.revision,
    hash: revision.hash,
    bytes: revision.bytes,
    createdAt: revision.createdAt,
    editor: revision.editor,
  };
}

export function createMemoryLibraryStore(seed = {}) {
  const projects = new Map();
  const assets = new Map();
  const usedIdempotencyKeys = new Set(seed.idempotencyKeys || []);
  const maxBytes = seed.maxBytes || DEFAULT_MAX_BYTES;
  const now = typeof seed.now === 'function' ? seed.now : () => new Date().toISOString();

  function timestamp() {
    const value = now();
    return typeof value === 'string' ? value : new Date(value).toISOString();
  }

  function requireProject(id) {
    const record = projects.get(id);
    if (!record) throw new LibraryStoreError('not_found', 'The requested project was not found.', 404);
    return record;
  }

  function requireUnusedKey(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
      throw new LibraryStoreError('invalid_request', 'An idempotency key is required.', 400);
    }
    if (usedIdempotencyKeys.has(idempotencyKey)) {
      throw new LibraryStoreError('idempotency_conflict', 'The idempotency key was already accepted.', 409);
    }
  }

  function acceptKey(idempotencyKey) {
    usedIdempotencyKeys.add(idempotencyKey);
  }

  function requireHead(record, baseRevision) {
    validateBaseRevision(baseRevision);
    if (record.revision !== baseRevision) {
      throw new LibraryStoreError('revision_conflict', 'The project changed since it was opened.', 409);
    }
  }

  function uniqueRestoredTitle(title) {
    const occupied = new Set([...projects.values()].map(record => record.title.toLocaleLowerCase()));
    if (!occupied.has(title.toLocaleLowerCase())) return title;
    let index = 1;
    while (true) {
      const suffix = index === 1 ? ' (restored)' : ` (restored ${index})`;
      const candidate = `${title.slice(0, Math.max(1, 160 - suffix.length))}${suffix}`;
      if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
      index += 1;
    }
  }

  async function makeRevision(revision, document, actor, createdAt = timestamp()) {
    const normalized = validatePortableProject(document, { maxBytes });
    const details = await contentDetails(normalized);
    return {
      revision,
      document: normalized,
      ...details,
      createdAt,
      editor: editor(actor),
    };
  }

  async function listProjects({ state = 'active' } = {}) {
    const archived = state === 'archived';
    return [...projects.values()]
      .filter(record => record.archived === archived)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map(record => publicMetadata(record));
  }

  async function createProject({ title, project, actor, idempotencyKey }) {
    requireUnusedKey(idempotencyKey);
    const cleanTitle = validateProjectTitle(title);
    const document = validatePortableProject(project, { maxBytes });
    const id = crypto.randomUUID();
    const createdAt = timestamp();
    const revision = await makeRevision(1, document, actor, createdAt);
    const record = {
      id,
      embeddedProjectId: revision.document.id,
      title: cleanTitle,
      archived: false,
      revision: 1,
      hash: revision.hash,
      bytes: revision.bytes,
      createdAt,
      updatedAt: createdAt,
      createdBy: editor(actor),
      lastEditor: editor(actor),
      revisions: [revision],
    };
    projects.set(id, record);
    acceptKey(idempotencyKey);
    return publicMetadata(record);
  }

  async function readProject({ id }) {
    const record = requireProject(id);
    const head = record.revisions.find(item => item.revision === record.revision);
    return { ...publicMetadata(record), document: clone(head.document) };
  }

  async function updateProject({ id, title, project, baseRevision, actor, idempotencyKey }) {
    requireUnusedKey(idempotencyKey);
    const record = requireProject(id);
    requireHead(record, baseRevision);
    const cleanTitle = title === undefined ? record.title : validateProjectTitle(title);
    const document = validatePortableProject(project, { maxBytes });
    if (document.id !== record.embeddedProjectId) {
      throw new LibraryStoreError('invalid_project', 'An update cannot change the embedded project identity.', 400);
    }
    const nextRevision = record.revision + 1;
    const revision = await makeRevision(nextRevision, document, actor);
    record.revisions.push(revision);
    record.title = cleanTitle;
    record.revision = nextRevision;
    record.hash = revision.hash;
    record.bytes = revision.bytes;
    record.updatedAt = revision.createdAt;
    record.lastEditor = editor(actor);
    acceptKey(idempotencyKey);
    return publicMetadata(record);
  }

  async function duplicateProject({ id, title, actor, idempotencyKey }) {
    requireUnusedKey(idempotencyKey);
    const source = requireProject(id);
    const cleanTitle = validateProjectTitle(title || `${source.title} Copy`);
    const head = source.revisions.find(item => item.revision === source.revision);
    const document = clone(head.document);
    document.id = `lwproj-${crypto.randomUUID()}`;
    document.name = cleanTitle;
    const remoteId = crypto.randomUUID();
    const createdAt = timestamp();
    const revision = await makeRevision(1, document, actor, createdAt);
    const record = {
      id: remoteId,
      embeddedProjectId: revision.document.id,
      title: cleanTitle,
      archived: false,
      revision: 1,
      hash: revision.hash,
      bytes: revision.bytes,
      createdAt,
      updatedAt: createdAt,
      createdBy: editor(actor),
      lastEditor: editor(actor),
      revisions: [revision],
    };
    projects.set(remoteId, record);
    acceptKey(idempotencyKey);
    return publicMetadata(record);
  }

  async function setArchived({ id, archived, baseRevision, actor, idempotencyKey }) {
    requireUnusedKey(idempotencyKey);
    const record = requireProject(id);
    requireHead(record, baseRevision);
    record.archived = archived === true;
    record.updatedAt = timestamp();
    record.lastEditor = editor(actor);
    acceptKey(idempotencyKey);
    return publicMetadata(record);
  }

  async function deleteProject({ id, baseRevision, idempotencyKey }) {
    requireUnusedKey(idempotencyKey);
    const record = requireProject(id);
    requireHead(record, baseRevision);
    projects.delete(id);
    acceptKey(idempotencyKey);
    return { deleted: true };
  }

  async function listRevisions({ id }) {
    return requireProject(id).revisions
      .slice()
      .sort((left, right) => right.revision - left.revision)
      .map(publicRevision);
  }

  async function restoreRevision({ id, revision, baseRevision, actor, idempotencyKey }) {
    requireUnusedKey(idempotencyKey);
    const record = requireProject(id);
    requireHead(record, baseRevision);
    const source = record.revisions.find(item => item.revision === revision);
    if (!source) throw new LibraryStoreError('revision_not_found', 'The requested revision was not found.', 404);
    const next = await makeRevision(record.revision + 1, source.document, actor);
    record.revisions.push(next);
    record.revision = next.revision;
    record.hash = next.hash;
    record.bytes = next.bytes;
    record.updatedAt = next.createdAt;
    record.lastEditor = editor(actor);
    acceptKey(idempotencyKey);
    return publicMetadata(record);
  }

  async function readAsset({ kind }) {
    const record = assets.get(kind);
    if (!record) throw new LibraryStoreError('not_found', 'The requested workspace asset was not found.', 404);
    const head = record.revisions.find(item => item.revision === record.revision);
    return {
      kind,
      revision: record.revision,
      hash: head.hash,
      bytes: head.bytes,
      updatedAt: head.createdAt,
      lastEditor: head.editor,
      value: clone(head.value),
    };
  }

  async function writeAsset({ kind, value, baseRevision, actor, idempotencyKey }) {
    requireUnusedKey(idempotencyKey);
    validateBaseRevision(baseRevision);
    const normalized = validateWorkspaceAsset(kind, value, { maxBytes });
    const record = assets.get(kind);
    const currentRevision = record?.revision || 0;
    if (baseRevision !== currentRevision) {
      throw new LibraryStoreError('revision_conflict', 'The workspace asset changed since it was opened.', 409);
    }
    const details = await contentDetails(normalized);
    const next = {
      revision: currentRevision + 1,
      value: normalized,
      ...details,
      createdAt: timestamp(),
      editor: editor(actor),
    };
    if (record) {
      record.revision = next.revision;
      record.revisions.push(next);
    } else {
      assets.set(kind, { kind, revision: 1, revisions: [next] });
    }
    acceptKey(idempotencyKey);
    return readAsset({ kind });
  }

  async function exportBackup({ exportedAt = timestamp() } = {}) {
    const backedUpProjects = [...projects.values()].map(record => ({
      id: record.id,
      title: record.title,
      archived: record.archived,
      currentRevision: record.revision,
      revisions: record.revisions.map(revision => ({
        revision: revision.revision,
        createdAt: revision.createdAt,
        document: clone(revision.document),
      })),
    }));
    const workspaceAssets = [...assets.values()].map(record => ({
      kind: record.kind,
      currentRevision: record.revision,
      revisions: record.revisions.map(revision => ({
        revision: revision.revision,
        createdAt: revision.createdAt,
        value: clone(revision.value),
      })),
    }));
    return createLibraryBackup({ exportedAt, projects: backedUpProjects, workspaceAssets });
  }

  async function importBackup({ backup, actor, idempotencyKey }) {
    requireUnusedKey(idempotencyKey);
    const normalized = validateMasterBackup(backup, { maxBytes: maxBytes * 32 });
    const occupiedRemoteIds = new Set(projects.keys());
    const occupiedEmbeddedIds = new Set([...projects.values()].map(record => record.embeddedProjectId));
    const plans = [];

    for (const project of normalized.projects) {
      const remoteCollision = occupiedRemoteIds.has(project.id);
      const sourceHead = project.revisions.find(item => item.revision === project.currentRevision);
      const embeddedCollision = occupiedEmbeddedIds.has(sourceHead.document.id);
      const id = remoteCollision ? crypto.randomUUID() : project.id;
      const embeddedProjectId = embeddedCollision ? `lwproj-${crypto.randomUUID()}` : sourceHead.document.id;
      const title = remoteCollision || embeddedCollision
        ? uniqueRestoredTitle(project.title)
        : validateProjectTitle(project.title);
      const importedRevisions = [];
      for (const sourceRevision of project.revisions.slice().sort((a, b) => a.revision - b.revision)) {
        const document = clone(sourceRevision.document);
        document.id = embeddedProjectId;
        const importedRevision = await makeRevision(
          sourceRevision.revision,
          document,
          actor,
          sourceRevision.createdAt || timestamp(),
        );
        importedRevisions.push(importedRevision);
      }
      const head = importedRevisions.find(item => item.revision === project.currentRevision);
      plans.push({
        id,
        embeddedProjectId,
        title,
        archived: project.archived,
        revision: project.currentRevision,
        hash: head.hash,
        bytes: head.bytes,
        createdAt: importedRevisions[0].createdAt,
        updatedAt: head.createdAt,
        createdBy: editor(actor),
        lastEditor: editor(actor),
        revisions: importedRevisions,
      });
      occupiedRemoteIds.add(id);
      occupiedEmbeddedIds.add(embeddedProjectId);
    }

    const assetPlans = [];
    for (const source of normalized.workspaceAssets) {
      const existing = assets.get(source.kind);
      const offset = existing?.revision || 0;
      const revisions = [];
      for (const sourceRevision of source.revisions.slice().sort((a, b) => a.revision - b.revision)) {
        const value = validateWorkspaceAsset(source.kind, sourceRevision.value, { maxBytes });
        revisions.push({
          revision: offset + revisions.length + 1,
          value,
          ...(await contentDetails(value)),
          createdAt: sourceRevision.createdAt || timestamp(),
          editor: editor(actor),
        });
      }
      assetPlans.push({ kind: source.kind, existing, revisions });
    }

    for (const record of plans) projects.set(record.id, record);
    for (const plan of assetPlans) {
      if (plan.existing) {
        plan.existing.revisions.push(...plan.revisions);
        plan.existing.revision = plan.revisions.at(-1).revision;
      } else {
        assets.set(plan.kind, {
          kind: plan.kind,
          revision: plan.revisions.at(-1).revision,
          revisions: plan.revisions,
        });
      }
    }
    acceptKey(idempotencyKey);
    return { projectsCreated: plans.length, assetsCreated: assetPlans.length };
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
  };
}
