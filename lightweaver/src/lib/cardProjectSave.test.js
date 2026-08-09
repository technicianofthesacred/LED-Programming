import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { saveProjectToCardFromGesture } from './cardProjectSave.js';
import { ProjectHeadConflictError } from './projectRepository.js';

test('deliberate card save pairs physically, reports progress, and saves through the repository', async () => {
  const events = [];
  const authority = {
    ownerCapability: '',
    async issueOwnerCapability(input) { events.push(['issue', input]); this.ownerCapability = 'cap'; return 'cap'; },
  };
  const result = await saveProjectToCardFromGesture({
    authority,
    envelope: { projectId: 'p1' },
    expectedHead: 'head-1',
    commissioningProof: 'owner-confirmed-physical-control',
    repositoryFactory: () => ({ save: async (...args) => { events.push(['save', ...args]); return { contentHash: 'head-2' }; } }),
    onProgress: value => events.push(['progress', value]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events.filter(event => event[0] === 'progress').map(event => event[1]), ['pairing', 'uploading', 'verifying', 'complete']);
  assert.equal(events[0][1].expectedProjectHead, 'head-1');
});

test('card save names pairing, conflict, quota, and cancellation failures', async () => {
  const base = { envelope: {}, commissioningProof: 'physical', repositoryFactory: () => ({ save: async () => ({}) }) };
  const forbidden = new Error('touch a card control to pair'); forbidden.status = 403;
  assert.equal((await saveProjectToCardFromGesture({ ...base, authority: { issueOwnerCapability: async () => { throw forbidden; } } })).reason, 'pairing-required');
  assert.equal((await saveProjectToCardFromGesture({ ...base, authority: { issueOwnerCapability: async () => 'cap' }, repositoryFactory: () => ({ save: async () => { throw new ProjectHeadConflictError({ contentHash: 'new' }); } }) })).reason, 'head-conflict');
  const quota = new Error('quota'); quota.code = 'quota-exceeded';
  assert.equal((await saveProjectToCardFromGesture({ ...base, authority: { issueOwnerCapability: async () => 'cap' }, repositoryFactory: () => ({ save: async () => { throw quota; } }) })).reason, 'quota-exceeded');
  const controller = new AbortController(); controller.abort();
  assert.equal((await saveProjectToCardFromGesture({ ...base, signal: controller.signal, authority: { issueOwnerCapability: async () => 'cap' } })).reason, 'cancelled');
});

test('Settings exposes the explicit physical-pairing card-save gesture and source label', async () => {
  const source = await readFile(new URL('../v3/lw-settings.jsx', import.meta.url), 'utf8');
  assert.match(source, /Save project to this card/);
  assert.match(source, /touch a physical control/i);
  assert.match(source, /saveProjectToCardFromGesture/);
  assert.match(source, /projectCopySource/);
});
