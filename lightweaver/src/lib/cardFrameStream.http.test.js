import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpFrameTransport } from './cardFrameStream.js';

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('HTTP frames acquire a lease, carry bounded monotonic chunks, and Stop revokes it', async () => {
  const calls = [];
  const authority = {
    transport: 'direct-lna', host: '192.168.18.70', cardId: 'lw-card-a', bootId: 'boot-2',
    ownerSessionId: 'owner-1', operationGeneration: 4, revoked: false,
    ownerCapability: 'cap-1', ownerCapabilityExpectedHead: 'head-1',
    snapshot() { return { host: this.host, cardId: this.cardId, bootId: this.bootId, ownerSessionId: this.ownerSessionId, operationGeneration: this.operationGeneration }; },
  };
  const transport = createHttpFrameTransport('192.168.18.70', {
    authority,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ path: new URL(url).pathname, body });
      return jsonResponse(calls.length === 1 ? { ok: true, leaseId: 'lease-1', expiresInMs: 4000, nextSequence: 7 } : { ok: true, nextSequence: 8 });
    },
    nowImpl: () => 1000,
    maxChunkPixels: 2,
  });
  await transport.sendFrame(['FF0000', '00FF00', '0000FF'], 0, { sequence: 7 });
  await transport.sendCancel();
  assert.deepEqual(calls.map(call => call.path), [
    '/api/stream/lease', '/api/stream/frame', '/api/stream/frame', '/api/stream/stop',
  ]);
  assert.deepEqual(calls.slice(1, 3).map(call => call.body.sequence), [7, 8]);
  assert.deepEqual(calls.slice(1, 3).map(call => call.body.start), [0, 2]);
  assert.equal(calls[0].body.capability, 'cap-1');
  assert.equal(calls[0].body.expectedHead, 'head-1');
  await assert.rejects(() => transport.sendFrame(['FFFFFF'], 0, { sequence: 8 }), /revoked/i);
});

test('HTTP transport rejects non-monotonic frames and authority drift before sending', async () => {
  let calls = 0;
  const authority = {
    transport: 'local-origin', host: 'lightweaver.local', cardId: 'lw-a', bootId: 'b1',
    ownerSessionId: 'o1', operationGeneration: 1,
    ownerCapability: 'cap-2', ownerCapabilityExpectedHead: null,
    snapshot() { return { host: this.host, cardId: this.cardId, bootId: this.bootId, ownerSessionId: this.ownerSessionId, operationGeneration: this.operationGeneration }; },
  };
  const transport = createHttpFrameTransport('lightweaver.local', {
    authority,
    fetchImpl: async () => { calls += 1; return jsonResponse(calls === 1 ? { leaseId: 'l1', expiresInMs: 9999, nextSequence: 3 } : { ok: true, nextSequence: 4 }); },
    nowImpl: () => 1,
  });
  await transport.sendFrame(['FFFFFF'], 0, { sequence: 3 });
  await assert.rejects(() => transport.sendFrame(['FFFFFF'], 0, { sequence: 3 }), /sequence/i);
  authority.bootId = 'b2';
  await assert.rejects(() => transport.sendFrame(['FFFFFF'], 0, { sequence: 4 }), /revoked/i);
});
