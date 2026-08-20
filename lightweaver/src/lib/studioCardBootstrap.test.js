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
    // A real transport authority publishes host/cardId/bootId and the observed
    // card — never a top-level buildId. Keep the fake honest about that.
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

test('Studio reload keeps the firmware build it paired with, so a reflash stays visible', async () => {
  let persisted = null;
  await bootstrapStudioCardConnection({
    bootstrapLink: async () => ({ state: 'disconnected' }),
    isConnected: () => false,
    readIdentity: () => ({
      id: 'lw-card-a', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
    }),
    readHost: () => 'lightweaver.local',
    candidateHosts: () => ['lightweaver.local'],
    connectTransport: async () => ({
      connected: true,
      host: 'lightweaver.local',
      cardId: 'lw-card-a',
      bootId: 'boot-new',
      // The card now answers with a DIFFERENT build: the owner reflashed it.
      card: { id: 'lw-card-a', firmwareVersion: '1.0.0', buildId: 'b'.repeat(40) },
    }),
    persistIdentity: value => { persisted = value; return true; },
  });
  // Restoring the pairing must not re-learn the new firmware behind the
  // owner's back — the remembered build is what makes the change detectable,
  // and only the explicit "keep the new firmware" action may replace it.
  assert.equal(persisted.buildId, 'a'.repeat(40));
  assert.equal(persisted.bootId, 'boot-new');
});
