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
  const metadata = {
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
  if (record.draftOfProjectId) {
    metadata.draftOfProjectId = record.draftOfProjectId;
    metadata.draftOwnerAccountId = record.draftOwnerAccountId;
    metadata.officialTitle = record.officialTitle;
  }
  return metadata;
}

function publicRevision(revision) {
  return {
    revision: revision.revision,
    archived: revision.archived,
    hash: revision.hash,
    bytes: revision.bytes,
    createdAt: revision.createdAt,
    editor: revision.editor,
  };
}

export function createMemoryLibraryStore(seed = {}) {
  const projects = new Map();
  const assets = new Map();
  const assignments = new Map();
  const usedIdempotencyKeys = new Set(seed.idempotencyKeys || []);
  let mutationTail = Promise.resolve();
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

  function assignmentKey(customerId, projectId) {
    return `${customerId}\u0000${projectId}`;
  }

  function role(identity) {
    return identity?.role;
  }

  function requireSharedRole(identity) {
    if (role(identity) !== 'owner' && role(identity) !== 'worker') {
      throw new LibraryStoreError('forbidden', 'This library operation is not allowed.', 403);
    }
  }

  function requireOwner(identity, { native = false } = {}) {
    if (role(identity) !== 'owner' || (native && typeof identity?.accountId !== 'string')) {
      throw new LibraryStoreError('forbidden', 'Only a native owner may perform this operation.', 403);
    }
  }

  function customerCanRead(record, identity) {
    return role(identity) === 'customer'
      && record.draftOwnerAccountId === identity.accountId
      && assignments.has(assignmentKey(identity.accountId, record.draftOfProjectId));
  }

  function requireVisibleProject(id, identity, capability = 'read') {
    const record = requireProject(id);
    if (!record.draftOfProjectId) {
      if (role(identity) === 'owner' || role(identity) === 'worker') return record;
      throw new LibraryStoreError('not_found', 'The requested project was not found.', 404);
    }
    if (role(identity) === 'owner' && (capability === 'read' || capability === 'history' || capability === 'delete')) {
      return record;
    }
    if (customerCanRead(record, identity)
      && (capability === 'read' || capability === 'history' || capability === 'update')) {
      return record;
    }
    if (role(identity) === 'owner' || customerCanRead(record, identity)) {
      throw new LibraryStoreError('forbidden', 'This project operation is not allowed.', 403);
    }
    throw new LibraryStoreError('not_found', 'The requested project was not found.', 404);
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

  function serializeMutation(operation) {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function makeRevision(revision, document, actor, {
    createdAt = timestamp(),
    archived = false,
  } = {}) {
    const normalized = validatePortableProject(document, { maxBytes });
    const details = await contentDetails(normalized);
    return {
      revision,
      archived,
      document: normalized,
      ...details,
      createdAt,
      editor: editor(actor),
    };
  }

  async function listProjects({ state = 'active', identity } = {}) {
    const archived = state === 'archived';
    return [...projects.values()]
      .filter(record => {
        if (record.archived !== archived) return false;
        if (role(identity) === 'customer') return customerCanRead(record, identity);
        if (role(identity) === 'owner' || role(identity) === 'worker') return !record.draftOfProjectId;
        return false;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map(record => publicMetadata(record));
  }

  async function createProject({ title, project, actor, idempotencyKey }) {
    requireSharedRole(actor);
    requireUnusedKey(idempotencyKey);
    const cleanTitle = validateProjectTitle(title);
    const document = validatePortableProject(project, { maxBytes });
    const id = crypto.randomUUID();
    const createdAt = timestamp();
    const revision = await makeRevision(1, document, actor, { createdAt });
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

  async function readProject({ id, identity }) {
    const record = requireVisibleProject(id, identity);
    const head = record.revisions.find(item => item.revision === record.revision);
    return { ...publicMetadata(record), document: clone(head.document) };
  }

  async function updateProject({ id, title, project, baseRevision, actor, idempotencyKey }) {
    requireUnusedKey(idempotencyKey);
    const record = requireVisibleProject(id, actor, 'update');
    requireHead(record, baseRevision);
    const cleanTitle = title === undefined ? record.title : validateProjectTitle(title);
    const document = validatePortableProject(project, { maxBytes });
    if (document.id !== record.embeddedProjectId) {
      throw new LibraryStoreError('invalid_project', 'An update cannot change the embedded project identity.', 400);
    }
    const nextRevision = record.revision + 1;
    const revision = await makeRevision(nextRevision, document, actor, { archived: record.archived });
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
    requireSharedRole(actor);
    requireUnusedKey(idempotencyKey);
    const source = requireVisibleProject(id, actor);
    if (source.draftOfProjectId) {
      throw new LibraryStoreError('forbidden', 'Customer drafts cannot be duplicated.', 403);
    }
    const cleanTitle = validateProjectTitle(title || `${source.title} Copy`);
    const head = source.revisions.find(item => item.revision === source.revision);
    const document = clone(head.document);
    document.id = `lwproj-${crypto.randomUUID()}`;
    document.name = cleanTitle;
    const remoteId = crypto.randomUUID();
    const createdAt = timestamp();
    const revision = await makeRevision(1, document, actor, { createdAt });
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
    requireSharedRole(actor);
    requireUnusedKey(idempotencyKey);
    const record = requireVisibleProject(id, actor, 'update');
    requireHead(record, baseRevision);
    const nextArchived = archived === true;
    const head = record.revisions.find(item => item.revision === record.revision);
    const revision = await makeRevision(record.revision + 1, head.document, actor, {
      archived: nextArchived,
    });
    record.revisions.push(revision);
    record.archived = nextArchived;
    record.revision = revision.revision;
    record.hash = revision.hash;
    record.bytes = revision.bytes;
    record.updatedAt = revision.createdAt;
    record.lastEditor = editor(actor);
    acceptKey(idempotencyKey);
    return publicMetadata(record);
  }

  async function deleteProject({ id, baseRevision, actor, idempotencyKey }) {
    requireOwner(actor);
    requireUnusedKey(idempotencyKey);
    const record = requireVisibleProject(id, actor, 'delete');
    requireHead(record, baseRevision);
    if (record.draftOfProjectId) {
      assignments.delete(assignmentKey(record.draftOwnerAccountId, record.draftOfProjectId));
      projects.delete(id);
    } else {
      for (const draft of [...projects.values()]) {
        if (draft.draftOfProjectId === id) projects.delete(draft.id);
      }
      for (const key of [...assignments.keys()]) {
        if (key.endsWith(`\u0000${id}`)) assignments.delete(key);
      }
      projects.delete(id);
    }
    acceptKey(idempotencyKey);
    return { deleted: true };
  }

  async function listRevisions({ id, identity }) {
    return requireVisibleProject(id, identity, 'history').revisions
      .slice()
      .sort((left, right) => right.revision - left.revision)
      .map(publicRevision);
  }

  async function restoreRevision({ id, revision, baseRevision, actor, idempotencyKey }) {
    requireSharedRole(actor);
    requireUnusedKey(idempotencyKey);
    const record = requireVisibleProject(id, actor, 'update');
    requireHead(record, baseRevision);
    const source = record.revisions.find(item => item.revision === revision);
    if (!source) throw new LibraryStoreError('revision_not_found', 'The requested revision was not found.', 404);
    const next = await makeRevision(record.revision + 1, source.document, actor, {
      archived: record.archived,
    });
    record.revisions.push(next);
    record.revision = next.revision;
    record.hash = next.hash;
    record.bytes = next.bytes;
    record.updatedAt = next.createdAt;
    record.lastEditor = editor(actor);
    acceptKey(idempotencyKey);
    return publicMetadata(record);
  }

  async function readAsset({ kind, identity }) {
    requireSharedRole(identity);
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
    requireSharedRole(actor);
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
    return readAsset({ kind, identity: actor });
  }

  async function exportBackup({ exportedAt = timestamp(), identity } = {}) {
    requireSharedRole(identity);
    const backedUpProjects = [...projects.values()].filter(record => !record.draftOfProjectId).map(record => ({
      id: record.id,
      title: record.title,
      archived: record.archived,
      currentRevision: record.revision,
      revisions: record.revisions.map(revision => ({
        revision: revision.revision,
        archived: revision.archived,
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
    requireSharedRole(actor);
    requireUnusedKey(idempotencyKey);
    const normalized = validateMasterBackup(backup, {
      maxBackupBytes: DEFAULT_MAX_BACKUP_BYTES,
      maxEntryBytes: maxBytes,
    });
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
          {
            createdAt: sourceRevision.createdAt || timestamp(),
            archived: sourceRevision.archived,
          },
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

  function requireCustomerAccount(account) {
    if (!account || account.role !== 'customer' || account.status !== 'active') {
      throw new LibraryStoreError('invalid_assignment', 'Assignments require an active customer account.', 400);
    }
    return account;
  }

  function draftFor(customerId, officialId) {
    return [...projects.values()].find(record => (
      record.draftOfProjectId === officialId
      && record.draftOwnerAccountId === customerId
    ));
  }

  function publicAssignment(customerId, official, draft) {
    draft.officialTitle = official.title;
    return {
      customerId,
      projectId: official.id,
      draftProjectId: draft.id,
      assignedAt: assignments.get(assignmentKey(customerId, official.id)).createdAt,
      project: publicMetadata(draft),
    };
  }

  async function assignCustomerProject({ targetAccount, projectId, actor, idempotencyKey }) {
    requireOwner(actor, { native: true });
    requireUnusedKey(idempotencyKey);
    const customer = requireCustomerAccount(targetAccount);
    const official = requireProject(projectId);
    if (official.draftOfProjectId) {
      throw new LibraryStoreError('not_found', 'The requested project was not found.', 404);
    }
    let draft = draftFor(customer.id, official.id);
    const created = !draft;
    if (!draft) {
      const head = official.revisions.find(item => item.revision === official.revision);
      const createdAt = timestamp();
      const revision = await makeRevision(1, head.document, actor, { createdAt });
      draft = {
        id: crypto.randomUUID(),
        embeddedProjectId: revision.document.id,
        title: official.title,
        archived: false,
        revision: 1,
        hash: revision.hash,
        bytes: revision.bytes,
        createdAt,
        updatedAt: createdAt,
        createdBy: editor(actor),
        lastEditor: editor(actor),
        draftOfProjectId: official.id,
        draftOwnerAccountId: customer.id,
        officialTitle: official.title,
        revisions: [revision],
      };
      projects.set(draft.id, draft);
    }
    const key = assignmentKey(customer.id, official.id);
    if (!assignments.has(key)) assignments.set(key, { createdAt: timestamp() });
    acceptKey(idempotencyKey);
    return { assignment: publicAssignment(customer.id, official, draft), created };
  }

  async function unassignCustomerProject({ targetAccount, projectId, actor, idempotencyKey }) {
    requireOwner(actor, { native: true });
    requireUnusedKey(idempotencyKey);
    const customer = requireCustomerAccount(targetAccount);
    const official = requireProject(projectId);
    if (official.draftOfProjectId) {
      throw new LibraryStoreError('not_found', 'The requested project was not found.', 404);
    }
    assignments.delete(assignmentKey(customer.id, official.id));
    acceptKey(idempotencyKey);
    return { unassigned: true };
  }

  async function listCustomerAssignments({ targetAccount, identity }) {
    requireOwner(identity, { native: true });
    const customer = requireCustomerAccount(targetAccount);
    const results = [];
    for (const [key] of assignments) {
      const [customerId, projectId] = key.split('\u0000');
      if (customerId !== customer.id) continue;
      const official = projects.get(projectId);
      const draft = draftFor(customer.id, projectId);
      if (official && draft) results.push(publicAssignment(customer.id, official, draft));
    }
    return results.sort((left, right) => left.projectId.localeCompare(right.projectId));
  }

  async function listProjectDrafts({ officialId, identity }) {
    requireOwner(identity);
    const official = requireProject(officialId);
    if (official.draftOfProjectId) {
      throw new LibraryStoreError('not_found', 'The requested project was not found.', 404);
    }
    return [...projects.values()]
      .filter(record => record.draftOfProjectId === official.id)
      .map(record => {
        record.officialTitle = official.title;
        return publicMetadata(record);
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async function promoteDraft({ draftId, officialBaseRevision, actor, idempotencyKey }) {
    requireOwner(actor);
    requireUnusedKey(idempotencyKey);
    const draft = requireProject(draftId);
    if (!draft.draftOfProjectId) {
      throw new LibraryStoreError('not_found', 'The requested project was not found.', 404);
    }
    const official = requireProject(draft.draftOfProjectId);
    requireHead(official, officialBaseRevision);
    const draftHead = draft.revisions.find(item => item.revision === draft.revision);
    const document = clone(draftHead.document);
    document.id = official.embeddedProjectId;
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
    createProject: args => serializeMutation(() => createProject(args)),
    readProject,
    updateProject: args => serializeMutation(() => updateProject(args)),
    duplicateProject: args => serializeMutation(() => duplicateProject(args)),
    setArchived: args => serializeMutation(() => setArchived(args)),
    deleteProject: args => serializeMutation(() => deleteProject(args)),
    listRevisions,
    restoreRevision: args => serializeMutation(() => restoreRevision(args)),
    readAsset,
    writeAsset: args => serializeMutation(() => writeAsset(args)),
    exportBackup,
    importBackup: args => serializeMutation(() => importBackup(args)),
    assignCustomerProject: args => serializeMutation(() => assignCustomerProject(args)),
    unassignCustomerProject: args => serializeMutation(() => unassignCustomerProject(args)),
    listCustomerAssignments,
    listProjectDrafts,
    promoteDraft: args => serializeMutation(() => promoteDraft(args)),
  };
}
