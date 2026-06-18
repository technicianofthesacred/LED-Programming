import { createProjectId, migrateProject, PROJECT_VERSION } from './projectModel.js';

export const PROJECT_LIBRARY_STORAGE_KEY = 'lw_project_library_v1';
export const PROJECT_LIBRARY_BACKUP_STORAGE_KEY = 'lw_project_library_v1_backup';
export const PROJECT_ACTIVE_RECORD_STORAGE_KEY = 'lw_project_active_record_v1';
export const PROJECT_LIBRARY_CHANGED_EVENT = 'lightweaver-project-library-changed';
export const PROJECT_LIBRARY_VERSION = 1;
export const PROJECT_LIBRARY_LIMIT = 24;

function getDefaultStorage() {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

function makeId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `project-${Date.now().toString(36)}-${random}`;
}

function storageFromOptions(options = {}) {
  return options.storage || getDefaultStorage();
}

export function readStorageJsonWithBackup(primaryKey, backupKey, options = {}) {
  const storage = storageFromOptions(options);
  if (!storage) return null;
  const keys = [primaryKey, backupKey].filter(Boolean);
  for (const key of keys) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      return JSON.parse(raw);
    } catch {
      // Try the next copy.
    }
  }
  return null;
}

export function writeStorageJsonWithBackup(primaryKey, backupKey, value, options = {}) {
  const storage = storageFromOptions(options);
  if (!storage) return false;
  const text = JSON.stringify(value);
  storage.setItem(primaryKey, text);
  if (backupKey) {
    try {
      storage.setItem(backupKey, text);
    } catch {
      // Primary write succeeded; the backup is best-effort.
    }
  }
  return true;
}

function parseEnvelopePayload(payload) {
  if (!payload) return null;
  const records = Array.isArray(payload?.records)
    ? payload.records
    : Array.isArray(payload)
      ? payload
      : null;
  if (!records) return null;
  return { version: PROJECT_LIBRARY_VERSION, records };
}

function readEnvelope({ storage = getDefaultStorage() } = {}) {
  if (!storage) return { version: PROJECT_LIBRARY_VERSION, records: [] };
  const parsed = readStorageJsonWithBackup(
    PROJECT_LIBRARY_STORAGE_KEY,
    PROJECT_LIBRARY_BACKUP_STORAGE_KEY,
    { storage },
  );
  return parseEnvelopePayload(parsed) || { version: PROJECT_LIBRARY_VERSION, records: [] };
}

function writeEnvelope(records, { storage = getDefaultStorage() } = {}) {
  if (!storage) return false;
  const payload = {
    version: PROJECT_LIBRARY_VERSION,
    records: records.slice(0, PROJECT_LIBRARY_LIMIT),
  };
  return writeStorageJsonWithBackup(
    PROJECT_LIBRARY_STORAGE_KEY,
    PROJECT_LIBRARY_BACKUP_STORAGE_KEY,
    payload,
    { storage },
  );
}

function requireStorage(storage) {
  if (!storage) {
    throw new Error('Project library storage is unavailable in this browser');
  }
}

function notifyProjectLibraryChanged(detail = {}) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(PROJECT_LIBRARY_CHANGED_EVENT, { detail }));
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const project = migrateProject(record.project);
  if (!project) return null;
  const id = String(record.id || '').trim();
  if (!id) return null;
  const name = String(record.name || project.name || 'Untitled Project').trim() || 'Untitled Project';
  const createdAt = Number(record.createdAt || record.updatedAt || Date.now());
  const updatedAt = Number(record.updatedAt || createdAt);
  return {
    id,
    name,
    createdAt,
    updatedAt,
    projectVersion: project.version || PROJECT_VERSION,
    project: {
      ...project,
      name,
    },
  };
}

function sortedRecords(records = []) {
  return records
    .map(normalizeRecord)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

export function createProjectLibraryRecord(project, { id = makeId(), now = Date.now() } = {}) {
  const migrated = migrateProject(project);
  if (!migrated) {
    throw new Error('Invalid Lightweaver project');
  }
  const name = String(migrated.name || 'Untitled Project').trim() || 'Untitled Project';
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    projectVersion: migrated.version || PROJECT_VERSION,
    project: {
      ...migrated,
      name,
    },
  };
}

export function listProjectLibraryRecords(options = {}) {
  const storage = storageFromOptions(options);
  return sortedRecords(readEnvelope({ storage }).records);
}

export function readActiveProjectLibraryRecordId(options = {}) {
  const storage = storageFromOptions(options);
  if (!storage) return '';
  try {
    return String(storage.getItem(PROJECT_ACTIVE_RECORD_STORAGE_KEY) || '');
  } catch {
    return '';
  }
}

export function writeActiveProjectLibraryRecordId(id, options = {}) {
  const storage = storageFromOptions(options);
  if (!storage) return '';
  const value = String(id || '');
  if (value) storage.setItem(PROJECT_ACTIVE_RECORD_STORAGE_KEY, value);
  else storage.removeItem(PROJECT_ACTIVE_RECORD_STORAGE_KEY);
  notifyProjectLibraryChanged({ action: 'active', id: value });
  return value;
}

export function saveProjectLibraryRecord(record, options = {}) {
  const storage = storageFromOptions(options);
  requireStorage(storage);
  const incoming = normalizeRecord(record);
  if (!incoming) {
    throw new Error('Invalid Lightweaver project library record');
  }

  const existingRecords = listProjectLibraryRecords({ storage });
  const existing = existingRecords.find(item => item.id === incoming.id);
  const next = {
    ...incoming,
    createdAt: existing?.createdAt || incoming.createdAt,
    updatedAt: Number(options.now || incoming.updatedAt || Date.now()),
  };
  const records = [
    next,
    ...existingRecords.filter(item => item.id !== incoming.id),
  ];
  if (!writeEnvelope(sortedRecords(records), { storage })) {
    throw new Error('Project library storage is unavailable in this browser');
  }
  notifyProjectLibraryChanged({ action: 'save', id: next.id });
  return next;
}

export function deleteProjectLibraryRecord(id, options = {}) {
  const storage = storageFromOptions(options);
  const target = String(id || '');
  const records = listProjectLibraryRecords({ storage }).filter(record => record.id !== target);
  writeEnvelope(records, { storage });
  if (readActiveProjectLibraryRecordId({ storage }) === target) {
    writeActiveProjectLibraryRecordId('', { storage });
  }
  notifyProjectLibraryChanged({ action: 'delete', id: target });
  return records;
}

export function duplicateProjectLibraryRecord(id, options = {}) {
  const storage = storageFromOptions(options);
  const source = listProjectLibraryRecords({ storage }).find(record => record.id === id);
  if (!source) return null;
  const name = `${source.name} copy`;
  const duplicate = createProjectLibraryRecord(
    { ...source.project, id: createProjectId(), name },
    { id: options.id || makeId(), now: options.now || Date.now() },
  );
  saveProjectLibraryRecord(duplicate, { storage });
  return duplicate;
}

export function saveCurrentProjectToLibrary(project, options = {}) {
  const storage = storageFromOptions(options);
  requireStorage(storage);
  const activeId = options.id || readActiveProjectLibraryRecordId({ storage });
  const existing = activeId
    ? listProjectLibraryRecords({ storage }).find(record => record.id === activeId)
    : null;
  const record = createProjectLibraryRecord(project, {
    id: existing?.id || options.id || makeId(),
    now: options.now || Date.now(),
  });
  const saved = saveProjectLibraryRecord(record, { storage, now: options.now });
  writeActiveProjectLibraryRecordId(saved.id, { storage });
  return saved;
}
