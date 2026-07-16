import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

test('launch persists the current project before navigating to one exact Bridge URL', async () => {
  const { launchBridgeOperation } = await import('./bridgeLaunch.js');
  const calls = [];
  const url = await launchBridgeOperation('recover-current-release', {
    persistProject: async () => calls.push('persist'),
    createLaunch: operation => {
      calls.push(`create:${operation}`);
      return 'lightweaver://run?operation=recover-current-release&nonce=safe&version=1';
    },
    navigate: value => calls.push(`navigate:${value}`),
  });
  assert.equal(url, 'lightweaver://run?operation=recover-current-release&nonce=safe&version=1');
  assert.deepEqual(calls, [
    'persist',
    'create:recover-current-release',
    'navigate:lightweaver://run?operation=recover-current-release&nonce=safe&version=1',
  ]);
});

test('failed persistence does not create or navigate a Bridge launch', async () => {
  const { launchBridgeOperation } = await import('./bridgeLaunch.js');
  let created = 0;
  let navigated = 0;
  await assert.rejects(() => launchBridgeOperation('install-current-release', {
    persistProject: async () => { throw new Error('save failed'); },
    createLaunch: () => { created += 1; },
    navigate: () => { navigated += 1; },
  }), /save failed/);
  assert.equal(created, 0);
  assert.equal(navigated, 0);
});

test('launch never discards an unacknowledged pending correlation before creating a replacement', async () => {
  const { launchBridgeOperation } = await import('./bridgeLaunch.js');
  const calls = [];
  await launchBridgeOperation('restart-card', {
    persistProject: async () => calls.push('persist'),
    clearPending: () => calls.push('clear-pending'),
    createLaunch: () => { calls.push('create'); return 'lightweaver://run?operation=restart-card&nonce=safe&version=1'; },
    navigate: () => calls.push('navigate'),
  });
  assert.deepEqual(calls, ['persist', 'create', 'navigate']);
});

test('result notification is bounded, nonce-free, operation-valid, targeted, and idempotent', async () => {
  const { createBridgeResultChannel } = await import('./bridgeLaunch.js');
  const storage = memoryStorage();
  const listeners = new Set();
  const eventTarget = {
    addEventListener: (_name, fn) => listeners.add(fn),
    removeEventListener: (_name, fn) => listeners.delete(fn),
  };
  const originSession = memoryStorage();
  originSession.setItem('lightweaver.bridge.origin-tab.v1', 'AQEBAQEBAQEBAQEBAQEBAQ');
  const received = [];
  const origin = createBridgeResultChannel({
    sessionStorage: originSession, localStorage: storage, eventTarget,
    BroadcastChannel: null, onResult: result => received.push(result),
  });
  const callback = createBridgeResultChannel({
    sessionStorage: memoryStorage(), localStorage: storage, eventTarget,
    BroadcastChannel: null,
  });
  const result = {
    operation: 'install-current-release', status: 'awaiting-card-acknowledgement',
    code: 'flash-verified', cardId: 'lw-441bf681feb0', firmwareVersion: '1.2.3',
    buildId: 'a'.repeat(40), target: 'lightweaver-controller-esp32s3',
    verification: 'flash-verified', physicalOutput: 'unconfirmed', physicalProof: false,
    originTabId: 'AQEBAQEBAQEBAQEBAQEBAQ', nonce: 'must-not-leak',
  };
  const message = callback.publish(result);
  assert.equal(JSON.stringify(message).includes('nonce'), false);
  assert.ok(JSON.stringify(message).length < 1024);
  for (const fn of listeners) fn({ key: 'lightweaver.bridge.result.v1', newValue: JSON.stringify(message) });
  for (const fn of listeners) fn({ key: 'lightweaver.bridge.result.v1', newValue: JSON.stringify(message) });
  assert.equal(received.length, 1);
  assert.equal(received[0].cardId, result.cardId);
  assert.throws(() => callback.publish({ ...result, operation: 'restart-card' }), /semantic|result/i);
  origin.close();
  callback.close();
});

test('callback bootstrap consumes before sanitizing and returns bounded guidance on failure', async () => {
  const { bootstrapBridgeCallback } = await import('./bridgeLaunch.js');
  const order = [];
  const success = await bootstrapBridgeCallback({
    href: 'https://led.mandalacodes.com/#bridge-result?x=1',
    consume: async href => { order.push(`consume:${href}`); return { operation: 'restart-card' }; },
    publish: result => order.push(`publish:${result.operation}`),
  });
  assert.equal(success.kind, 'result');
  assert.deepEqual(order, [
    'consume:https://led.mandalacodes.com/#bridge-result?x=1',
    'publish:restart-card',
  ]);
  const failure = await bootstrapBridgeCallback({
    href: 'https://led.mandalacodes.com/#bridge-result?bad=raw-secret',
    consume: async () => { throw new Error('raw-secret'); },
  });
  assert.deepEqual(failure, {
    kind: 'failure',
    message: 'Studio could not match this Bridge return. Paste the one-time return code from Bridge into the original Studio tab.',
  });
});

test('callback and pasted return code acknowledge only after successful Studio consumption', async () => {
  const { bootstrapBridgeCallback, resumeBridgeReturnCode } = await import('./bridgeLaunch.js');
  const calls = [];
  const consumed = { operation: 'restart-card', acknowledgementUrl: 'lightweaver://ack?receipt=safe&version=1' };
  await bootstrapBridgeCallback({
    href: 'https://led.mandalacodes.com/#bridge-result?x=1',
    consume: async () => consumed,
    publish: result => calls.push(`publish:${result.operation}`),
    acknowledge: url => calls.push(`ack:${url}`),
  });
  await resumeBridgeReturnCode('LW1-safe', {
    consume: async () => consumed,
    publish: result => calls.push(`manual:${result.operation}`),
    acknowledge: url => calls.push(`manual-ack:${url}`),
  });
  assert.deepEqual(calls, [
    'publish:restart-card', 'ack:lightweaver://ack?receipt=safe&version=1',
    'manual:restart-card', 'manual-ack:lightweaver://ack?receipt=safe&version=1',
  ]);
});

test('Studio lifecycle source has no four-second missing inference and exposes a pasted return path', () => {
  for (const file of ['../components/card/CardConnectionCenter.jsx', '../v3/lw-flash.jsx']) {
    const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
    assert.doesNotMatch(source, /BRIDGE_OPEN_TIMEOUT_MS|setBridgeState\('missing'\)|setBridgeLaunchState\('missing'\)|Bridge may not be installed/);
    assert.match(source, /return code/i);
    assert.match(source, /return-pending|working/);
    assert.match(source, /installer-unavailable/);
  }
});
