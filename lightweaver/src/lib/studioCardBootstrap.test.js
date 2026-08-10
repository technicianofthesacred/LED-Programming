import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapStudioCardConnection } from './studioCardBootstrap.js';

test('Studio reload restores its persisted exact card through direct transport', async () => {
  const calls = [];
  let persisted = null;
  const authority = {
    connected: true,
    host: '192.168.18.70',
    cardId: 'lw-card-a',
    bootId: 'boot-new',
    buildId: 'b'.repeat(40),
    card: { id: 'lw-card-a', name: 'Lightweaver' },
  };
  const result = await bootstrapStudioCardConnection({
    bootstrapLink: async () => ({ state: 'disconnected' }),
    isConnected: () => false,
    readIdentity: () => ({ id: 'lw-card-a', name: 'Saved card' }),
    readHost: () => 'lightweaver.local',
    candidateHosts: () => ['192.168.18.70', 'lightweaver.local'],
    connectTransport: async options => { calls.push(options); return authority; },
    persistIdentity: value => { persisted = value; return true; },
  });

  assert.equal(result, authority);
  assert.deepEqual(calls, [{ host: '192.168.18.70', expectedCardId: 'lw-card-a' }]);
  assert.equal(persisted.id, 'lw-card-a');
  assert.equal(persisted.address, '192.168.18.70');
  assert.equal(persisted.bootId, 'boot-new');
});

test('Studio falls through stale hosts until the exact paired card answers', async () => {
  const calls = [];
  const result = await bootstrapStudioCardConnection({
    bootstrapLink: async () => ({ state: 'disconnected' }),
    isConnected: () => false,
    readIdentity: () => ({ id: 'lw-card-a', address: '192.168.18.70' }),
    readHost: () => 'lightweaver.local',
    candidateHosts: () => ['lightweaver.local', '192.168.18.70'],
    connectTransport: async ({ host }) => {
      calls.push(host);
      return host === '192.168.18.70'
        ? { connected: true, host, cardId: 'lw-card-a', card: { id: 'lw-card-a' } }
        : { connected: false, reason: 'direct-unavailable' };
    },
    persistIdentity: () => true,
  });
  assert.equal(result.connected, true);
  assert.deepEqual(calls, ['lightweaver.local', '192.168.18.70']);
});

test('Studio never races direct transport against a restored bridge', async () => {
  let directCalls = 0;
  const bridge = { state: 'connected-bridge' };
  const result = await bootstrapStudioCardConnection({
    bootstrapLink: async () => bridge,
    isConnected: state => state.state === 'connected-bridge',
    connectTransport: async () => { directCalls += 1; },
  });
  assert.equal(result, bridge);
  assert.equal(directCalls, 0);
});

test('Studio does not probe an unpaired card on reload', async () => {
  let directCalls = 0;
  await bootstrapStudioCardConnection({
    bootstrapLink: async () => ({ state: 'disconnected' }),
    isConnected: () => false,
    readIdentity: () => null,
    connectTransport: async () => { directCalls += 1; },
  });
  assert.equal(directCalls, 0);
});
