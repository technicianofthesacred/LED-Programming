import assert from 'node:assert/strict';
import test from 'node:test';

import { probeFirmwareUpdateGrantService, requestSoftwareFirmwareUpdateGrant } from './ownerFirmwareUpdateGrant.js';

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

test('an owner-protection redirect or network failure names the sign-in, not "Failed to fetch"', async () => {
  const common = {
    authority: exactAuthority([]), release: { manifest: { buildId: BUILD }, ticketSha256: TICKET },
    origin: 'https://led.mandalacodes.com',
  };
  // Cloudflare Access answers the grant POST with an off-site login redirect.
  await assert.rejects(
    requestSoftwareFirmwareUpdateGrant({ ...common, fetchImpl: async () => ({ type: 'opaqueredirect', status: 0 }) }),
    error => error.reason === 'owner-sign-in-required' && /owner sign-in/i.test(error.message),
  );
  await assert.rejects(
    requestSoftwareFirmwareUpdateGrant({ ...common, fetchImpl: async () => ({ status: 302, async json() { return null; } }) }),
    error => error.reason === 'owner-sign-in-required',
  );
  // A JSON 401 (native auth, signed out) is the same owner action.
  await assert.rejects(
    requestSoftwareFirmwareUpdateGrant({ ...common, fetchImpl: async () => ({
      ok: false, status: 401, async json() { return { error: { code: 'unauthenticated' } }; },
    }) }),
    error => error.reason === 'owner-sign-in-required',
  );
  // The raw TypeError never reaches the owner.
  await assert.rejects(
    requestSoftwareFirmwareUpdateGrant({ ...common, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }),
    error => error.reason === 'grant-service-unreachable' && !/^Failed to fetch$/.test(error.message),
  );
  // A card challenge that dies at the network layer is named as the card leg.
  await assert.rejects(
    requestSoftwareFirmwareUpdateGrant({
      ...common,
      authority: {
        ...exactAuthority([]),
        async request() { throw new TypeError('Failed to fetch'); },
      },
      fetchImpl: async () => ({ ok: true, async json() { return {}; } }),
    }),
    /could not reach this card/i,
  );
});

test('probeFirmwareUpdateGrantService classifies the owner protection states', async () => {
  assert.deepEqual(
    await probeFirmwareUpdateGrantService({ fetchImpl: async () => ({ type: 'opaqueredirect', status: 0 }) }),
    { state: 'sign-in-required', reason: 'owner-access' },
  );
  assert.deepEqual(
    await probeFirmwareUpdateGrantService({ fetchImpl: async () => ({ status: 401 }) }),
    { state: 'sign-in-required', reason: 'native-session' },
  );
  assert.deepEqual(
    await probeFirmwareUpdateGrantService({ fetchImpl: async () => ({ ok: true, status: 200 }) }),
    { state: 'ready', reason: '' },
  );
  assert.deepEqual(
    await probeFirmwareUpdateGrantService({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }),
    { state: 'unavailable', reason: 'unreachable' },
  );
  assert.deepEqual(
    await probeFirmwareUpdateGrantService({ fetchImpl: async () => ({ status: 503 }) }),
    { state: 'unavailable', reason: 'http-503' },
  );
});
