import test from 'node:test';
import assert from 'node:assert/strict';

import { createCardProjectRepository } from './cardProjectRepository.js';
import { createProjectEnvelope } from './projectRepository.js';
import { createDefaultProject } from './projectModel.js';

function envelope() { return createProjectEnvelope({ ...createDefaultProject(), id: 'p1' }); }

test('card save requires owner capability, preflights, uploads sequential chunks, commits, and verifies readback', async () => {
  const calls = [];
  const advancedHeads = [];
  const authority = {
    ownerCapability: 'cap-1',
    ownerCapabilityExpectedHead: null,
    cardId: 'lw-a', bootId: 'boot-1', ownerSessionId: 'owner-1', operationGeneration: 4,
    async request(path, init = {}) {
      const body = init.body || {};
      calls.push({ path, body, headers: init.headers || {} });
      if (path.endsWith('/preflight')) return { ok: true, chunkSize: 64 };
      if (path.endsWith('/begin')) return { uploadId: 'up-1', chunkSize: 64 };
      if (path.endsWith('/commit')) return { ok: true, head: body.contentHash };
      if (path === '/api/projects/read?id=p1') return envelope();
      return { ok: true };
    },
    watch() { return () => {}; },
    advanceOwnerCapabilityHead(head) { advancedHeads.push(head); },
  };
  const repo = createCardProjectRepository({ authority, maxChunkBytes: 64 });
  const saved = await repo.save(envelope(), null);
  assert.equal(saved.projectId, 'p1');
  assert.deepEqual(calls.slice(0, 2).map(call => call.path), ['/api/projects/preflight', '/api/projects/begin']);
  assert.match(calls[0].body.transferHash, /^[a-f0-9]{64}$/);
  assert.notEqual(calls[0].body.transferHash, calls[0].body.contentHash, 'serialized envelope hash is distinct from editable project head');
  assert.equal(calls[1].body.transferHash, calls[0].body.transferHash);
  assert.ok(calls.filter(call => call.path !== '/api/projects/read?id=p1').every(call => call.headers['X-Lightweaver-Capability'] === 'cap-1'));
  const chunkCalls = calls.filter(call => call.path.includes('/chunk'));
  assert.ok(chunkCalls.length > 1);
  assert.deepEqual(chunkCalls.map(call => call.body.chunkIndex), chunkCalls.map((_, index) => index));
  assert.ok(chunkCalls.every(call => typeof call.body.data === 'string' && !Object.hasOwn(call.body, 'bytes')));
  assert.match(calls.at(-2).path, /commit$/);
  assert.equal(calls.at(-1).path, '/api/projects/read?id=p1');
  assert.deepEqual(advancedHeads, [saved.contentHash]);
});

test('card mutations reject absent owner capability and preserve head on cancellation', async () => {
  const repo = createCardProjectRepository({ authority: { request() {}, watch() {} } });
  await assert.rejects(() => repo.save(envelope(), null), /owner capability/i);

  const controller = new AbortController();
  controller.abort();
  const capable = createCardProjectRepository({
    authority: { ownerCapability: 'cap', request: async () => ({ ok: true, chunkSize: 64 }), watch: () => () => {} },
  });
  await assert.rejects(() => capable.save(envelope(), null, { signal: controller.signal }), error => error.name === 'AbortError');
});
