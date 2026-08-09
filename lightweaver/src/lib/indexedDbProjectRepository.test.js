import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createIndexedDbProjectRepository,
  migrateLocalStorageProjects,
} from './indexedDbProjectRepository.js';
import { createProjectEnvelope } from './projectRepository.js';
import { createDefaultProject } from './projectModel.js';

class MemoryBackend {
  constructor() { this.projects = new Map(); this.outbox = []; }
  async list() { return [...this.projects.values()]; }
  async get(id) { return this.projects.get(id) || null; }
  async put(value) { this.projects.set(value.projectId, structuredClone(value)); }
  async delete(id) { this.projects.delete(id); }
  async enqueue(operation) { this.outbox.push(structuredClone(operation)); }
  async listOutbox() { return structuredClone(this.outbox); }
  async deleteOutbox(id) { this.outbox = this.outbox.filter(item => item.id !== id); }
}

class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function envelope(id = 'p1') {
  return createProjectEnvelope({ ...createDefaultProject(), id });
}

test('IndexedDB repository exposes CAS list/read/save/remove/watch through a durable backend', async () => {
  const repo = createIndexedDbProjectRepository({ backend: new MemoryBackend() });
  const events = [];
  repo.watch(event => events.push(event));
  const saved = await repo.save(envelope(), null);
  assert.equal((await repo.list())[0].projectId, 'p1');
  assert.equal((await repo.read('p1')).contentHash, saved.contentHash);
  await repo.remove('p1', saved.contentHash);
  assert.deepEqual(events.map(event => event.type), ['save', 'remove']);
});

test('migration reads back before marking complete and retains autosave recovery copy', async () => {
  const backend = new MemoryBackend();
  const repo = createIndexedDbProjectRepository({ backend });
  const project = { ...createDefaultProject(), id: 'migrated' };
  const storage = new MemoryStorage({ lw_autosave_v3: JSON.stringify(project) });
  const result = await migrateLocalStorageProjects(repo, { storage });
  assert.equal(result.migrated, 1);
  assert.ok(storage.getItem('lw_autosave_v3_backup'));
  assert.equal(storage.getItem('lw_project_repository_migrated_v1'), '1');
  assert.equal((await repo.read('migrated')).project.id, 'migrated');
});

test('quota/readback failures stay explicit and durable outbox replays in order', async () => {
  const backend = new MemoryBackend();
  backend.put = async () => { const error = new Error('quota'); error.name = 'QuotaExceededError'; throw error; };
  const repo = createIndexedDbProjectRepository({ backend });
  await assert.rejects(() => repo.save(envelope(), null), error => error.code === 'quota-exceeded');

  const outboxBackend = new MemoryBackend();
  const outboxRepo = createIndexedDbProjectRepository({ backend: outboxBackend });
  await outboxRepo.enqueueOutbox({ id: 'a', parentHash: null, envelope: envelope('a') });
  await outboxRepo.enqueueOutbox({ id: 'b', parentHash: 'parent', envelope: envelope('b') });
  const replayed = [];
  await outboxRepo.replayOutbox(async operation => replayed.push(operation.id));
  assert.deepEqual(replayed, ['a', 'b']);
  assert.deepEqual(await outboxBackend.listOutbox(), []);
});
