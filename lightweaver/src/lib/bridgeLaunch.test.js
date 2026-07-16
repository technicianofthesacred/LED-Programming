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

function broadcastBus() {
  const channels = new Set();
  return class FakeBroadcastChannel {
    constructor() { this.listeners = new Set(); channels.add(this); }
    addEventListener(_name, listener) { this.listeners.add(listener); }
    postMessage(data) {
      for (const channel of channels) if (channel !== this) for (const listener of channel.listeners) listener({ data });
    }
    close() { channels.delete(this); }
  };
}

function maintenanceReturnCode(nonce, receipt = Buffer.alloc(32, 4).toString('base64url')) {
  const payload = new URLSearchParams([
    ['status', 'awaiting-card-acknowledgement'], ['code', 'operation-complete'],
    ['target', 'lightweaver-controller-esp32s3'], ['verification', 'not-verified'],
    ['physicalOutput', 'unconfirmed'], ['nonce', nonce], ['receipt', receipt], ['version', '1'],
  ]).toString();
  return `LW1-${Buffer.from(payload).toString('base64url')}`;
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

test('target tab accepts a bounded result once before issuing its receipt acknowledgement', async () => {
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
  const acknowledged = [];
  const origin = createBridgeResultChannel({
    sessionStorage: originSession, localStorage: storage, eventTarget,
    BroadcastChannel: null, onResult: result => received.push(result), acknowledge: url => acknowledged.push(url),
    confirmReceipt: () => true,
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
    originTabId: 'AQEBAQEBAQEBAQEBAQEBAQ', ackReceipt: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ', nonce: 'must-not-leak',
  };
  const message = callback.publish(result);
  assert.equal(JSON.stringify(message).includes('nonce'), false);
  assert.ok(JSON.stringify(message).length < 1024);
  for (const fn of listeners) fn({ key: 'lightweaver.bridge.result.v1', newValue: JSON.stringify(message) });
  for (const fn of listeners) fn({ key: 'lightweaver.bridge.result.v1', newValue: JSON.stringify(message) });
  assert.equal(received.length, 1);
  assert.equal(received[0].cardId, result.cardId);
  assert.equal('ackReceipt' in received[0], false);
  assert.deepEqual(acknowledged, ['lightweaver://ack?receipt=BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ&version=1']);
  assert.throws(() => callback.publish({ ...result, operation: 'restart-card' }), /semantic|result/i);
  origin.close();
  callback.close();
});

test('callback publish cannot acknowledge when the target tab closes before receipt', async () => {
  const { createBridgeResultChannel } = await import('./bridgeLaunch.js');
  const acknowledged = [];
  const callback = createBridgeResultChannel({
    sessionStorage: memoryStorage(), localStorage: memoryStorage(), BroadcastChannel: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} }, acknowledge: url => acknowledged.push(url),
  });
  callback.publish({
    operation: 'restart-card', status: 'awaiting-card-acknowledgement', code: 'operation-complete',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed',
    originTabId: 'AQEBAQEBAQEBAQEBAQEBAQ', ackReceipt: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  });
  assert.deepEqual(acknowledged, []);
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

test('callback and pasted return code publish without acknowledging from the producer tab', async () => {
  const { bootstrapBridgeCallback, resumeBridgeReturnCode } = await import('./bridgeLaunch.js');
  const calls = [];
  const consumed = { operation: 'restart-card', ackReceipt: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ' };
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
    'publish:restart-card', 'manual:restart-card',
  ]);
});

test('Firefox origin survives refresh and accepts a manual return after default Chrome profile mismatch', async () => {
  const { createBridgeResultChannel, resumeBridgeReturnCode } = await import('./bridgeLaunch.js');
  const { consumeBridgeReturnCode, createBridgeLaunch } = await import('./bridgeProtocol.js');
  const FirefoxBroadcast = broadcastBus();
  const firefoxLocal = memoryStorage();
  const firefoxSession = memoryStorage();
  const chromeLocal = memoryStorage();
  const launch = createBridgeLaunch('restart-card', {
    crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } },
    sessionStorage: firefoxSession, localStorage: firefoxLocal, now: () => 0,
  });
  const code = maintenanceReturnCode(new URL(launch).searchParams.get('nonce'));
  await assert.rejects(() => consumeBridgeReturnCode(code, {
    currentOrigin: 'https://led.mandalacodes.com', sessionStorage: memoryStorage(), localStorage: chromeLocal,
    crypto: { getRandomValues(bytes) { bytes.fill(8); return bytes; } }, now: () => 1,
  }), /pending|profile|operation/i);

  const received = [];
  const acknowledgements = [];
  const refreshedFirefox = createBridgeResultChannel({
    sessionStorage: firefoxSession, localStorage: firefoxLocal, BroadcastChannel: FirefoxBroadcast,
    onResult: result => received.push(result), acknowledge: url => acknowledgements.push(url),
  });
  const producer = createBridgeResultChannel({
    sessionStorage: memoryStorage(), localStorage: firefoxLocal, BroadcastChannel: FirefoxBroadcast,
  });
  await resumeBridgeReturnCode(code, {
    protocolDependencies: { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: firefoxSession, localStorage: firefoxLocal, now: () => 1 },
    publish: result => producer.publish(result),
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].operation, 'restart-card');
  assert.equal(acknowledgements.length, 1);
  refreshedFirefox.close();
  producer.close();
});

test('closed original tab is replaced by a same-profile tab that receives UI result before one ACK', async () => {
  const { createBridgeResultChannel, resumeBridgeReturnCode } = await import('./bridgeLaunch.js');
  const { createBridgeLaunch } = await import('./bridgeProtocol.js');
  const Broadcast = broadcastBus();
  const sharedLocal = memoryStorage();
  const closedSession = memoryStorage();
  const replacementSession = memoryStorage();
  const launch = createBridgeLaunch('restart-card', {
    crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } },
    sessionStorage: closedSession, localStorage: sharedLocal, now: () => 0,
  });
  const code = maintenanceReturnCode(new URL(launch).searchParams.get('nonce'));
  const order = [];
  const replacement = createBridgeResultChannel({
    sessionStorage: replacementSession, localStorage: sharedLocal, BroadcastChannel: Broadcast,
    onResult: result => order.push(`ui:${result.operation}`), acknowledge: () => order.push('ack'),
  });
  const producer = createBridgeResultChannel({ sessionStorage: replacementSession, localStorage: sharedLocal, BroadcastChannel: Broadcast });
  await resumeBridgeReturnCode(code, {
    protocolDependencies: {
      currentOrigin: 'https://led.mandalacodes.com', sessionStorage: replacementSession, localStorage: sharedLocal,
      crypto: { getRandomValues(bytes) { bytes.fill(9); return bytes; } }, now: () => 1,
    },
    publish: result => producer.publish(result),
  });
  assert.deepEqual(order, ['ui:restart-card', 'ack']);
  assert.notEqual(replacementSession.getItem('lightweaver.bridge.origin-tab.v1'), closedSession.getItem('lightweaver.bridge.origin-tab.v1'));
  replacement.close();
  producer.close();
});

test('Studio lifecycle source has no four-second missing inference and exposes a pasted return path', () => {
  for (const file of ['../components/card/CardConnectionCenter.jsx', '../v3/lw-flash.jsx']) {
    const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
    assert.doesNotMatch(source, /BRIDGE_OPEN_TIMEOUT_MS|setBridgeState\('missing'\)|setBridgeLaunchState\('missing'\)|Bridge may not be installed/);
    assert.match(source, /return code/i);
    assert.match(source, /return-pending|waiting-for-bridge/);
    assert.doesNotMatch(source, /setBridge(?:State|LaunchState)\('working'\)|Working in Lightweaver Bridge|Bridge is working/);
    assert.match(source, /installer-unavailable/);
  }
});
