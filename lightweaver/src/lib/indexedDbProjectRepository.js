import {
  ProjectHeadConflictError,
  ProjectRepositoryError,
  createProjectEnvelope,
  validateProjectEnvelope,
} from './projectRepository.js';
import { migrateProject } from './projectModel.js';

export const PROJECT_REPOSITORY_DB_NAME = 'lightweaver-projects-v1';
export const PROJECT_REPOSITORY_MIGRATION_KEY = 'lw_project_repository_migrated_v1';
export const PROJECT_AUTOSAVE_KEY = 'lw_autosave_v3';
export const PROJECT_AUTOSAVE_BACKUP_KEY = 'lw_autosave_v3_backup';

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export function createIndexedDbBackend({ indexedDB = globalThis.indexedDB, dbName = PROJECT_REPOSITORY_DB_NAME } = {}) {
  if (!indexedDB?.open) throw new ProjectRepositoryError('storage-unavailable', 'IndexedDB is unavailable in this browser.');
  let dbPromise = null;
  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'projectId' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open IndexedDB'));
    });
    return dbPromise;
  };
  async function store(mode, name, operation) {
    const db = await open();
    const tx = db.transaction(name, mode);
    const result = await operation(tx.objectStore(name));
    await transactionPromise(tx);
    return result;
  }
  return {
    list: () => store('readonly', 'projects', objectStore => requestPromise(objectStore.getAll())),
    get: id => store('readonly', 'projects', objectStore => requestPromise(objectStore.get(id))),
    put: value => store('readwrite', 'projects', objectStore => requestPromise(objectStore.put(value))),
    delete: id => store('readwrite', 'projects', objectStore => requestPromise(objectStore.delete(id))),
    async compareAndSwap(projectId, expectedHead, next) {
      const db = await open();
      const tx = db.transaction('projects', 'readwrite');
      const objectStore = tx.objectStore('projects');
      const current = await requestPromise(objectStore.get(projectId));
      if ((current?.contentHash || null) !== (expectedHead || null)) {
        tx.abort();
        throw new ProjectHeadConflictError(current || null);
      }
      if (next) objectStore.put(next); else objectStore.delete(projectId);
      await transactionPromise(tx);
      return current || null;
    },
    enqueue: operation => store('readwrite', 'outbox', objectStore => requestPromise(objectStore.put(operation))),
    listOutbox: () => store('readonly', 'outbox', objectStore => requestPromise(objectStore.getAll())),
    deleteOutbox: id => store('readwrite', 'outbox', objectStore => requestPromise(objectStore.delete(id))),
  };
}

function repositoryFailure(error) {
  if (error instanceof ProjectHeadConflictError || error instanceof ProjectRepositoryError) return error;
  if (error?.name === 'QuotaExceededError') return new ProjectRepositoryError('quota-exceeded', 'This browser has no space left for the project.', error);
  return new ProjectRepositoryError('storage-failed', 'The browser project repository failed.', error);
}

export function createIndexedDbProjectRepository({ backend, indexedDB, dbName, source } = {}) {
  const storage = backend || createIndexedDbBackend({ indexedDB, dbName });
  const listeners = new Set();
  const notify = event => listeners.forEach(listener => { try { listener(event); } catch { /* isolated */ } });
  return Object.freeze({
    source: Object.freeze(source || { kind: 'browser', label: 'This browser' }),
    async list() {
      try { return (await storage.list()).map(validateProjectEnvelope).sort((a, b) => b.modifiedAt - a.modifiedAt); }
      catch (error) { throw repositoryFailure(error); }
    },
    async read(projectId) {
      try { const value = await storage.get(String(projectId)); return value ? validateProjectEnvelope(value) : null; }
      catch (error) { throw repositoryFailure(error); }
    },
    async save(envelope, expectedHead = null) {
      const valid = validateProjectEnvelope(envelope);
      try {
        if (valid.parentHash !== (expectedHead || null)) throw new ProjectHeadConflictError(await storage.get(valid.projectId));
        if (storage.compareAndSwap) await storage.compareAndSwap(valid.projectId, expectedHead, valid);
        else {
          const current = await storage.get(valid.projectId);
          if ((current?.contentHash || null) !== (expectedHead || null)) throw new ProjectHeadConflictError(current);
          await storage.put(valid);
        }
        const readback = await storage.get(valid.projectId);
        if (!readback || readback.contentHash !== valid.contentHash) throw new ProjectRepositoryError('readback-failed', 'Project save could not be read back.');
        notify({ type: 'save', projectId: valid.projectId, envelope: valid });
        return validateProjectEnvelope(readback);
      } catch (error) { throw repositoryFailure(error); }
    },
    async remove(projectId, expectedHead = null) {
      const id = String(projectId);
      try {
        let previous;
        if (storage.compareAndSwap) previous = await storage.compareAndSwap(id, expectedHead, null);
        else {
          previous = await storage.get(id);
          if ((previous?.contentHash || null) !== (expectedHead || null)) throw new ProjectHeadConflictError(previous);
          await storage.delete(id);
        }
        if (await storage.get(id)) throw new ProjectRepositoryError('readback-failed', 'Project removal could not be verified.');
        notify({ type: 'remove', projectId: id, previous: previous || null });
        return true;
      } catch (error) { throw repositoryFailure(error); }
    },
    watch(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async enqueueOutbox(operation) {
      const queued = { ...structuredClone(operation), id: String(operation.id), createdAt: Number(operation.createdAt || Date.now()) };
      await storage.enqueue(queued);
      return queued;
    },
    async replayOutbox(send) {
      const operations = (await storage.listOutbox()).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      for (const operation of operations) {
        await send(operation);
        await storage.deleteOutbox(operation.id);
      }
      return operations.length;
    },
  });
}

function defaultLocalStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export async function migrateLocalStorageProjects(repository, {
  storage = defaultLocalStorage(),
  autosaveKey = PROJECT_AUTOSAVE_KEY,
  backupKey = PROJECT_AUTOSAVE_BACKUP_KEY,
  migrationKey = PROJECT_REPOSITORY_MIGRATION_KEY,
} = {}) {
  if (!storage || storage.getItem(migrationKey) === '1') return { migrated: 0, alreadyComplete: true };
  const candidates = [];
  const rawAutosave = storage.getItem(autosaveKey);
  if (rawAutosave) {
    if (!storage.getItem(backupKey)) storage.setItem(backupKey, rawAutosave);
    try { const project = migrateProject(JSON.parse(rawAutosave)); if (project) candidates.push(project); } catch { /* recovery copy retained */ }
  }
  try {
    const library = JSON.parse(storage.getItem('lw_project_library_v1') || 'null');
    for (const record of library?.records || []) {
      const project = migrateProject(record?.project);
      if (project) candidates.push(project);
    }
  } catch { /* legacy data stays untouched */ }
  let migrated = 0;
  for (const project of candidates) {
    const current = await repository.read(project.id);
    if (current) continue;
    const envelope = createProjectEnvelope(project);
    await repository.save(envelope, null);
    const readback = await repository.read(project.id);
    if (!readback || readback.contentHash !== envelope.contentHash) throw new ProjectRepositoryError('migration-readback-failed', 'Migrated project could not be read back.');
    migrated += 1;
  }
  storage.setItem(migrationKey, '1');
  return { migrated, alreadyComplete: false };
}
