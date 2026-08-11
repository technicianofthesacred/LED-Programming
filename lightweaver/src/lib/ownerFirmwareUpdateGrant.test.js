import assert from 'node:assert/strict';
import test from 'node:test';

import { requestSoftwareFirmwareUpdateGrant } from './ownerFirmwareUpdateGrant.js';

const BUILD = 'b'.repeat(40);
const TICKET = 'c'.repeat(64);
const SIGNATURE = 'A'.repeat(86);

function exactAuthority(calls) {
  return {
    cardId: 'lw-b0fe81f61b44', bootId: 'boot-1', ownerSessionId: 'owner-1',
    operationGeneration: 8, projectHead: 'a'.repeat(64), revoked: false,
    async request(path, init) {
      calls.push({ path, init });
      return { grantPayload: '{"exact":"card-bytes"}' };
    },
  };
}

test('requests exact card challenge then same-origin owner signature', async () => {
  const calls = [];
  const fetchCalls = [];
  const result = await requestSoftwareFirmwareUpdateGrant({
    authority: exactAuthority(calls),
    release: { manifest: { buildId: BUILD }, ticketSha256: TICKET },
    origin: 'https://led.mandalacodes.com',
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return { ok: true, async json() { return {
        grantPayload: '{"exact":"card-bytes"}', signature: SIGNATURE,
        algorithm: 'ECDSA_P256_SHA256_P1363',
      }; } };
    },
  });

  assert.equal(calls[0].path, '/api/update/challenge');
  assert.deepEqual(calls[0].init.body, {
    cardId: 'lw-b0fe81f61b44', bootId: 'boot-1', ownerSessionId: 'owner-1',
    operationGeneration: 8, expectedProjectHead: 'a'.repeat(64),
    studioOrigin: 'https://led.mandalacodes.com', releaseBuildId: BUILD, ticketSha256: TICKET,
  });
  assert.equal(fetchCalls[0].url, '/api/library/firmware-update-grant');
  assert.equal(fetchCalls[0].init.credentials, 'same-origin');
  assert.equal(fetchCalls[0].init.cache, 'no-store');
  assert.deepEqual(result, {
    grantPayload: '{"exact":"card-bytes"}', grantSignature: SIGNATURE,
    grantAlgorithm: 'ECDSA_P256_SHA256_P1363',
  });
});

test('rejects changed payload, malformed signature, and unauthenticated response', async () => {
  const common = {
    authority: exactAuthority([]), release: { manifest: { buildId: BUILD }, ticketSha256: TICKET },
    origin: 'https://led.mandalacodes.com',
  };
  await assert.rejects(requestSoftwareFirmwareUpdateGrant({ ...common, fetchImpl: async () => ({
    ok: true, async json() { return { grantPayload: 'changed', signature: SIGNATURE, algorithm: 'ECDSA_P256_SHA256_P1363' }; },
  }) }), /invalid software update authorization/i);
  await assert.rejects(requestSoftwareFirmwareUpdateGrant({ ...common, fetchImpl: async () => ({
    ok: false, async json() { return { error: { message: 'Sign in as the owner.' } }; },
  }) }), /sign in as the owner/i);
});
