import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  createEncryptedProjectHandoff,
  decryptProjectHandoff,
  parseProjectHandoffFragment,
  resolveProjectHandoffConflict,
} from './projectHandoff.js';
import { createProjectEnvelope } from './projectRepository.js';
import { createDefaultProject } from './projectModel.js';

function envelope(parentHash = null) {
  return createProjectEnvelope({ ...createDefaultProject(), id: 'p1' }, { parentHash });
}

test('handoff uses independent 32-byte lookup/key secrets and stages ciphertext only', async () => {
  const handoff = await createEncryptedProjectHandoff(envelope(), {
    cryptoImpl: webcrypto,
    localStudioUrl: 'http://lightweaver.local/studio/',
  });
  assert.notEqual(handoff.lookupToken, handoff.key);
  assert.equal(Buffer.from(handoff.lookupToken, 'base64url').length, 32);
  assert.equal(Buffer.from(handoff.key, 'base64url').length, 32);
  assert.equal(Object.hasOwn(handoff.stagingPayload, 'project'), false);
  assert.equal(Object.hasOwn(handoff.stagingPayload, 'key'), false);
  assert.match(handoff.localUrl, /^http:\/\/lightweaver\.local\/studio\/#handoff=/);
  assert.equal(new URL(handoff.localUrl).search, '');
  const parsed = parseProjectHandoffFragment(new URL(handoff.localUrl).hash);
  const restored = await decryptProjectHandoff(handoff.stagingPayload, parsed, { cryptoImpl: webcrypto, expectedCardId: 'lw-card-a' });
  assert.equal(restored.envelope.projectId, 'p1');
  assert.equal(restored.source.cardId, 'lw-card-a');
});

test('handoff rejects wrong card binding and exposes parent-hash conflict choices', async () => {
  const handoff = await createEncryptedProjectHandoff(envelope('a'.repeat(64)), { cryptoImpl: webcrypto });
  const parsed = parseProjectHandoffFragment(`#handoff=${handoff.lookupToken}.${handoff.key}`);
  await assert.rejects(
    () => decryptProjectHandoff(handoff.stagingPayload, parsed, { cryptoImpl: webcrypto, expectedCardId: 'lw-b', claimedCardId: 'lw-a' }),
    /wrong card/i,
  );
  assert.deepEqual(resolveProjectHandoffConflict({ incomingParentHash: 'old', currentHead: 'new' }), {
    conflict: true, choices: ['compare', 'keep-both', 'replace'],
  });
});
