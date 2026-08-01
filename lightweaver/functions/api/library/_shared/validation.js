import { PROJECT_VERSION, migrateProject } from '../../../../src/lib/projectModel.js';
import {
  LIBRARY_BACKUP_FORMAT,
  LIBRARY_BACKUP_VERSION,
} from './backup.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_BACKUP_ENTRIES = 10_000;
const WORKSPACE_ASSET_KINDS = new Set(['custom-patterns', 'pattern-lab-drafts']);

export class LibraryValidationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LibraryValidationError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status) {
  throw new LibraryValidationError(code, message, status);
}

function jsonText(value) {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) fail('invalid_request', 'A JSON value is required.');
    return text;
  } catch (error) {
    if (error instanceof LibraryValidationError) throw error;
    fail('invalid_request', 'The value must be valid JSON.');
  }
}

function assertBoundedJson(value, maxBytes = DEFAULT_MAX_BYTES) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const text = jsonText(value);
  if (new TextEncoder().encode(text).byteLength > limit) {
    fail('payload_too_large', 'The JSON payload is too large.', 413);
  }

  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > MAX_JSON_DEPTH) fail('invalid_request', 'The JSON payload is too deeply nested.');
    if (!current.value || typeof current.value !== 'object') continue;
    for (const child of Object.values(current.value)) {
      if (child && typeof child === 'object') stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return JSON.parse(text);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validatePortableProject(value, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const clone = assertBoundedJson(value, maxBytes);
  if (!isRecord(clone) || !Number.isInteger(clone.version) || clone.version > PROJECT_VERSION) {
    fail('invalid_project', 'The project is not a supported Lightweaver project.');
  }
  const migrated = migrateProject(clone);
  if (!migrated) fail('invalid_project', 'The project is not a supported Lightweaver project.');
  return migrated;
}

export function validateWorkspaceAsset(kind, value, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!WORKSPACE_ASSET_KINDS.has(kind)) {
    fail('invalid_asset_kind', 'The workspace asset kind is not supported.');
  }
  const clone = assertBoundedJson(value, maxBytes);
  if (!clone || typeof clone !== 'object') {
    fail('invalid_asset', 'The workspace asset must be a JSON object or array.');
  }
  return clone;
}

function validateBackupProject(entry, maxBytes) {
  if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.title !== 'string') {
    fail('invalid_backup', 'The library backup contains an invalid project entry.');
  }
  if (!Array.isArray(entry.revisions) || entry.revisions.length === 0) {
    fail('invalid_backup', 'Every backed-up project must contain revisions.');
  }
  const seen = new Set();
  const revisions = entry.revisions.map(item => {
    if (!isRecord(item) || !Number.isInteger(item.revision) || item.revision < 1 || seen.has(item.revision)) {
      fail('invalid_backup', 'The library backup contains an invalid project revision.');
    }
    seen.add(item.revision);
    return {
      revision: item.revision,
      archived: item.archived === true,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
      document: validatePortableProject(item.document, { maxBytes }),
    };
  });
  const currentRevision = Number(entry.currentRevision);
  if (!seen.has(currentRevision)) {
    fail('invalid_backup', 'The backed-up project head revision is missing.');
  }
  revisions.find(item => item.revision === currentRevision).archived = entry.archived === true;
  return {
    id: entry.id,
    title: validateProjectTitle(entry.title),
    archived: entry.archived === true,
    currentRevision,
    revisions,
  };
}

function validateBackupAsset(entry, maxBytes) {
  if (!isRecord(entry) || !Array.isArray(entry.revisions) || entry.revisions.length === 0) {
    fail('invalid_backup', 'The library backup contains an invalid workspace asset.');
  }
  const seen = new Set();
  const revisions = entry.revisions.map(item => {
    if (!isRecord(item) || !Number.isInteger(item.revision) || item.revision < 1 || seen.has(item.revision)) {
      fail('invalid_backup', 'The library backup contains an invalid workspace asset revision.');
    }
    seen.add(item.revision);
    return {
      revision: item.revision,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
      value: validateWorkspaceAsset(entry.kind, item.value, { maxBytes }),
    };
  });
  const currentRevision = Number(entry.currentRevision);
  if (!seen.has(currentRevision)) fail('invalid_backup', 'The backed-up workspace asset head is missing.');
  return { kind: entry.kind, currentRevision, revisions };
}

export function validateMasterBackup(value, { maxBytes = 32 * DEFAULT_MAX_BYTES } = {}) {
  const clone = assertBoundedJson(value, maxBytes);
  if (!isRecord(clone)
    || clone.format !== LIBRARY_BACKUP_FORMAT
    || clone.version !== LIBRARY_BACKUP_VERSION
    || typeof clone.exportedAt !== 'string'
    || !Number.isFinite(Date.parse(clone.exportedAt))
    || !Array.isArray(clone.projects)
    || !Array.isArray(clone.workspaceAssets)
    || clone.projects.length + clone.workspaceAssets.length > MAX_BACKUP_ENTRIES) {
    fail('invalid_backup', 'The file is not a supported Lightweaver library backup.');
  }
  return {
    format: LIBRARY_BACKUP_FORMAT,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt: clone.exportedAt,
    projects: clone.projects.map(entry => validateBackupProject(entry, maxBytes)),
    workspaceAssets: clone.workspaceAssets.map(entry => validateBackupAsset(entry, maxBytes)),
  };
}

export function validateProjectTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title || title.length > 160) fail('invalid_request', 'Project title must be between 1 and 160 characters.');
  return title;
}

export function validateBaseRevision(value) {
  if (!Number.isInteger(value) || value < 0) fail('invalid_request', 'A non-negative baseRevision is required.');
  return value;
}

export function validateAssetKind(kind) {
  if (!WORKSPACE_ASSET_KINDS.has(kind)) fail('invalid_asset_kind', 'The workspace asset kind is not supported.');
  return kind;
}
