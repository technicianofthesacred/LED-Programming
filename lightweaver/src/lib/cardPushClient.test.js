import assert from 'node:assert/strict';
import test from 'node:test';
import { readCardProjectEvidence } from './cardPushClient.js';

test('project evidence reader performs an uncached independent firmware-info GET', async () => {
  let call;
  const body = { cardId: 'lw-aabbccddeeff', projectRevision: 7 };
  const result = await readCardProjectEvidence({
    host: '192.168.4.1',
    transport: 'direct',
    fetchImpl: async (url, init) => {
      call = { url, init };
      return { ok: true, json: async () => body };
    },
  });
  assert.equal(result, body);
  assert.match(call.url, /\/api\/firmware-info$/);
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.cache, 'no-store');
});
