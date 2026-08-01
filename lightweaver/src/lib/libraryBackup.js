import { migrateProject } from './projectModel.js';

export const LIBRARY_BACKUP_FORMAT = 'lightweaver.library-backup';
export const LIBRARY_BACKUP_VERSION = 1;
export const LIBRARY_BACKUP_EXTENSION = '.lw-library.json';

const WORKSPACE_ASSET_KINDS = new Set(['custom-patterns', 'pattern-lab-drafts']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonSafe(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonSafe(value[index], ancestors)) return false;
    }
  } else {
    for (const nested of Object.values(value)) {
      if (!isJsonSafe(nested, ancestors)) return false;
    }
  }
  ancestors.delete(value);
  return true;
}

function isTimestamp(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function validRevisionSet(revisions, validateValue) {
  if (!Array.isArray(revisions) || revisions.length === 0) return null;
  const seen = new Set();
  for (const item of revisions) {
    if (!isRecord(item)
      || !Number.isInteger(item.revision)
      || item.revision < 1
      || seen.has(item.revision)
      || !isTimestamp(item.createdAt ?? null)
      || !validateValue(item)) return null;
    seen.add(item.revision);
  }
  return seen;
}

function isBackupProject(entry) {
  if (!isRecord(entry)
    || typeof entry.id !== 'string'
    || !entry.id
    || typeof entry.title !== 'string'
    || !entry.title.trim()
    || entry.title.trim().length > 160
    || typeof entry.archived !== 'boolean') return false;
  const revisions = validRevisionSet(entry.revisions, revision => {
    if (typeof revision.archived !== 'boolean' || !isRecord(revision.document)) return false;
    try {
      return migrateProject(structuredClone(revision.document)) !== null;
    } catch {
      return false;
    }
  });
  return revisions !== null
    && Number.isInteger(entry.currentRevision)
    && revisions.has(entry.currentRevision);
}

function isBackupAsset(entry) {
  if (!isRecord(entry) || !WORKSPACE_ASSET_KINDS.has(entry.kind)) return false;
  const revisions = validRevisionSet(entry.revisions, revision => (
    revision.value !== null
    && typeof revision.value === 'object'
    && isJsonSafe(revision.value)
  ));
  return revisions !== null
    && Number.isInteger(entry.currentRevision)
    && revisions.has(entry.currentRevision);
}

export function canonicalLibraryBackupFileName(date = new Date()) {
  const value = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (!Number.isFinite(value.getTime())) throw new TypeError('A valid date is required for a library backup name.');
  return `${value.toISOString().slice(0, 10)}-lightweaver-master${LIBRARY_BACKUP_EXTENSION}`;
}

export function isLibraryBackup(value) {
  if (!isRecord(value)
    || !isJsonSafe(value)
    || value.format !== LIBRARY_BACKUP_FORMAT
    || value.version !== LIBRARY_BACKUP_VERSION
    || !isTimestamp(value.exportedAt)
    || value.exportedAt === null
    || !Array.isArray(value.projects)
    || !Array.isArray(value.workspaceAssets)) return false;

  // These fields belong to individual portable projects, never the master root.
  if (['id', 'projectId', 'name', 'projectName', 'layout', 'strips'].some(key => Object.hasOwn(value, key))) {
    return false;
  }

  const projectIds = new Set();
  for (const project of value.projects) {
    if (!isBackupProject(project) || projectIds.has(project.id)) return false;
    projectIds.add(project.id);
  }
  const assetKinds = new Set();
  for (const asset of value.workspaceAssets) {
    if (!isBackupAsset(asset) || assetKinds.has(asset.kind)) return false;
    assetKinds.add(asset.kind);
  }
  return true;
}
