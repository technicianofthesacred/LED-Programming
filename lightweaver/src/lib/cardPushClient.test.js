import assert from 'node:assert/strict';
import test from 'node:test';
import { readCardProjectEvidence } from './cardPushClient.js';

test('project evidence reader performs an uncached independent branded firmware-info GET', async () => {
  let call;
  const body = {
    app: 'Lightweaver',
    cardId: 'lw-aabbccddeeff',
    firmwareVersion: '1.2.3',
    buildId: 'build-123',
    projectRevision: 7,
    projectFingerprint: 'a'.repeat(16),
    productionJobId: 'job-42',
    productionJobDigest: 'b'.repeat(64),
  };
  const result = await readCardProjectEvidence({
    host: '192.168.4.1',
    transport: 'direct',
    fetchImpl: async (url, init) => {
      call = { url, init };
      return { ok: true, json: async () => body };
    },
  });
  assert.deepEqual(result, body);
  assert.match(call.url, /\/api\/firmware-info$/);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.cache, 'no-store');
});

test('project evidence reader rejects a response branded as another product', async () => {
  await assert.rejects(readCardProjectEvidence({
    host: '192.168.4.1',
    transport: 'direct',
    fetchImpl: async () => ({ ok: true, json: async () => ({ app: 'Other', cardId: 'lw-aabbccddeeff' }) }),
  }), /Lightweaver/i);
});

test('project evidence reader rejects identity without an exact Lightweaver provenance marker', async () => {
  await assert.rejects(readCardProjectEvidence({
    host: '192.168.4.1',
    transport: 'direct',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      cardId: 'lw-aabbccddeeff',
      firmwareVersion: '1.2.3',
      buildId: 'build-123',
      projectRevision: 7,
      projectFingerprint: 'a'.repeat(16),
    }) }),
  }), /Lightweaver/i);
});

test('project evidence reader rejects malformed card-owned identity fields', async () => {
  await assert.rejects(readCardProjectEvidence({
    host: '192.168.4.1',
    transport: 'direct',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      app: 'Lightweaver',
      cardId: 'lw-aabbccddeeff',
      firmwareVersion: '1.2.3',
      buildId: 'build-123',
      projectRevision: 7,
      projectFingerprint: 'ABCDEF0123456789',
    }) }),
  }), /project fingerprint/i);
});

test('project evidence rejects a partial production job identity', async () => {
  for (const partial of [
    { productionJobId: 'job-42' },
    { productionJobDigest: 'b'.repeat(64) },
  ]) {
    await assert.rejects(readCardProjectEvidence({
      host: '192.168.4.1',
      transport: 'direct',
      fetchImpl: async () => ({ ok: true, json: async () => ({
        app: 'Lightweaver',
        cardId: 'lw-aabbccddeeff',
        firmwareVersion: '1.2.3',
        buildId: 'build-123',
        projectRevision: 7,
        projectFingerprint: 'a'.repeat(16),
        ...partial,
      }) }),
    }), /production job identity/i);
  }
});
