import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMemoryProjectRepository,
  createProjectEnvelope,
  ProjectHeadConflictError,
  validateProjectEnvelope,
} from './projectRepository.js';
import { createDefaultProject } from './projectModel.js';

function project(id = 'p1', name = 'One') {
  return { ...createDefaultProject(), id, name };
}

test('project envelope validates complete editable package and immutable hash metadata', () => {
  const envelope = createProjectEnvelope(project(), { localRevision: 3, source: { kind: 'card', cardId: 'lw-a', installationId: 'i1' } });
  assert.equal(validateProjectEnvelope(envelope).project.layout.strips.length > 0, true);
  assert.equal(envelope.projectId, 'p1');
  assert.equal(envelope.localRevision, 3);
  assert.equal(envelope.source.cardId, 'lw-a');
  assert.ok(/^[a-f0-9]{64}$/.test(envelope.contentHash));
  assert.ok(Object.isFrozen(envelope));
  assert.throws(() => validateProjectEnvelope({ ...envelope, contentHash: '0'.repeat(64) }), /content-hash-mismatch/);
});

test('memory repository enforces compare-and-swap despite newer timestamps', async () => {
  const repo = createMemoryProjectRepository();
  const first = await repo.save(createProjectEnvelope(project()), null);
  const second = await repo.save(createProjectEnvelope(project('p1', 'Two'), { parentHash: first.contentHash, modifiedAt: 2 }), first.contentHash);
  await assert.rejects(
    () => repo.save(createProjectEnvelope(project('p1', 'Stale'), { parentHash: first.contentHash, modifiedAt: 999999 }), first.contentHash),
    error => error instanceof ProjectHeadConflictError && error.currentHead.contentHash === second.contentHash,
  );
});

test('watch and remove follow repository CAS semantics', async () => {
  const repo = createMemoryProjectRepository();
  const events = [];
  const unwatch = repo.watch(event => events.push(event));
  const saved = await repo.save(createProjectEnvelope(project()), null);
  await assert.rejects(() => repo.remove('p1', 'stale'), error => error.code === 'head-conflict');
  await repo.remove('p1', saved.contentHash);
  unwatch();
  assert.deepEqual(events.map(event => event.type), ['save', 'remove']);
});
