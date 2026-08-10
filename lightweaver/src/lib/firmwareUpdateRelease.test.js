import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { loadVerifiedFirmwareUpdateRelease } from './firmwareUpdateRelease.js';

const BUILD = 'a'.repeat(40);
const ticket = {
  schemaVersion: 1, firmwareVersion: '1.2.0', buildId: BUILD, buildNumber: 1300,
  target: 'esp32-s3-n16r8', image: { size: 3, sha256: createHash('sha256').update(Uint8Array.from([0xe9, 1, 2])).digest('hex') },
  partition: { layout: 'default_16MB.csv', tableSha256: 'b'.repeat(64), app0Offset: 0x10000, app1Offset: 0x650000, slotSize: 0x640000 },
  compatibility: { firmwareApiMin: 2, firmwareApiMax: 2, projectSchemaMin: 3, projectSchemaMax: 3, minimumUpdaterVersion: 1, minimumBootstrapBuild: 1198 },
  preservation: { dataPartitionsIncluded: false },
};
const ticketBytes = new TextEncoder().encode(JSON.stringify(ticket));
const ticketSha256 = createHash('sha256').update(ticketBytes).digest('hex');

function fixture(changes = {}) {
  return {
    manifest: { firmwareVersion: '1.2.0', buildId: BUILD, buildNumber: 1300, target: 'esp32-s3-n16r8' },
    ticket, ticketBytes, ticketSha256,
    ticketSignature: new Uint8Array(64).fill(1),
    imageBytes: Uint8Array.from([0xe9, 1, 2]),
    ...changes,
  };
}

test('Studio retains only a short-lived exact verified update identity chain', async () => {
  const loaded = await loadVerifiedFirmwareUpdateRelease({ loadRelease: async () => fixture() });
  assert.equal(loaded.ticketSha256, ticketSha256);
  assert.equal(loaded.ticket, ticket);
  assert.equal(loaded.imageBytes.byteLength, 3);
  assert.equal(Object.isFrozen(loaded), true);
});

test('Studio rejects identity or byte drift even after the shared loader returns', async () => {
  await assert.rejects(
    () => loadVerifiedFirmwareUpdateRelease({ loadRelease: async () => fixture({ manifest: { ...fixture().manifest, buildId: 'c'.repeat(40) } }) }),
    /identity/i,
  );
  await assert.rejects(
    () => loadVerifiedFirmwareUpdateRelease({ loadRelease: async () => fixture({ imageBytes: Uint8Array.from([0xe9, 9, 9]) }) }),
    /SHA-256/i,
  );
  await assert.rejects(
    () => loadVerifiedFirmwareUpdateRelease({ loadRelease: async () => fixture({ ticketBytes: new TextEncoder().encode('{}') }) }),
    /ticket SHA-256/i,
  );
});
