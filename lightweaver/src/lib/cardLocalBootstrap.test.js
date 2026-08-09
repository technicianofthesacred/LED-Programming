import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { authorizeCardLocalProject, bootstrapCardLocalAuthority } from './cardLocalBootstrap.js';

test('card-local Studio establishes same-origin authority before rendering routine controls', async () => {
  const calls = [];
  const authority = { connected: true, transport: 'local-origin' };
  const result = await bootstrapCardLocalAuthority({
    host: 'lightweaver.local',
    connectImpl: async options => { calls.push(options); return authority; },
  });
  assert.equal(result, authority);
  assert.deepEqual(calls, [{ host: 'lightweaver.local', expectedCardId: '', transport: 'local-origin' }]);
});

test('card-local Studio fails closed when exact same-origin identity cannot be established', async () => {
  await assert.rejects(() => bootstrapCardLocalAuthority({
    host: '192.168.4.1',
    connectImpl: async () => ({ connected: false, reason: 'identity-missing' }),
  }), /identity-missing/);
});

test('card-local project opens only after physical confirmation and comes from card storage', async () => {
  const events = [];
  const envelope = { contentHash: 'a'.repeat(64), project: { id: 'project-a' } };
  const authority = {
    projectHead: envelope.contentHash,
    async issueOwnerCapability(input) { events.push(['issue', input]); },
  };
  const repository = {
    source: { kind: 'card' },
    async list() { events.push(['list']); return [{ projectId: 'project-a', head: envelope.contentHash }]; },
    async read(id) { events.push(['read', id]); return envelope; },
  };
  const opened = await authorizeCardLocalProject({ authority, repositoryFactory: () => repository });
  assert.equal(opened.repository, repository);
  assert.equal(opened.envelope, envelope);
  assert.deepEqual(events, [
    ['issue', { commissioningProof: 'card-local-physical-confirmation', expectedProjectHead: envelope.contentHash }],
    ['list'],
    ['read', 'project-a'],
  ]);
});

test('card entry uses the card repository instead of browser IndexedDB for its open copy', async () => {
  const source = await readFile(new URL('../card-main.jsx', import.meta.url), 'utf8');
  assert.match(source, /authorizeCardLocalProject/);
  assert.doesNotMatch(source, /createIndexedDbProjectRepository/);
  assert.match(source, /Open card project/);
});
