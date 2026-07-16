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

function recordingLocks(calls) {
  const tails = new Map();
  return { request(name, _options, callback) {
    calls.push(name);
    const prior = tails.get(name) ?? Promise.resolve();
    const result = prior.then(callback);
    tails.set(name, result.catch(() => {}));
    return result;
  } };
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

test('target claims authority and durably saves a sanitized result before UI and acknowledgement', async () => {
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
  const order = [];
  const origin = createBridgeResultChannel({
    sessionStorage: originSession, localStorage: storage, eventTarget,
    BroadcastChannel: null,
    claimReceipt: (_receipt, message) => { order.push(`claim:${message.operation}`); return true; },
    persistResult: result => { order.push(`save:${result.operation}`); assert.equal('ackReceipt' in result, false); },
    onResult: result => { order.push(`ui:${result.operation}`); received.push(result); },
    confirmReceipt: () => { order.push('finalize'); return true; },
    acknowledge: () => order.push('ack'),
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
  assert.deepEqual(order, ['claim:install-current-release', 'save:install-current-release', 'ui:install-current-release', 'finalize', 'ack']);
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

test('adversarial duplicate persisted receipts cannot reach UI or acknowledge either result', async () => {
  const { createBridgeResultChannel } = await import('./bridgeLaunch.js');
  const localStorage = memoryStorage();
  const receipt = 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk';
  const firstNonce = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
  const secondNonce = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';
  localStorage.setItem(`lightweaver.bridge.pending.v1.${firstNonce}`, JSON.stringify({
    operation: 'restart-card', nonce: firstNonce, tabId: 'AQEBAQEBAQEBAQEBAQEBAQ',
    createdAt: 0, expiresAt: 300_000, receipt,
  }));
  localStorage.setItem(`lightweaver.bridge.pending.v1.${secondNonce}`, JSON.stringify({
    operation: 'release-usb', nonce: secondNonce, tabId: 'AgICAgICAgICAgICAgICAg',
    createdAt: 0, expiresAt: 300_000, receipt,
  }));
  const sessionStorage = memoryStorage();
  sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', 'AQEBAQEBAQEBAQEBAQEBAQ');
  const received = [];
  const acknowledged = [];
  const channel = createBridgeResultChannel({
    sessionStorage, localStorage, BroadcastChannel: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} },
    onResult: result => received.push(result), acknowledge: url => acknowledged.push(url),
  });
  const notification = {
    version: 1, type: 'bridge-result', deliveryId: 'AQEBAQEBAQEBAQEB',
    targetTabId: 'AQEBAQEBAQEBAQEBAQEBAQ', operation: 'restart-card',
    status: 'awaiting-card-acknowledgement', code: 'operation-complete',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified',
    physicalOutput: 'unconfirmed', ackReceipt: receipt,
  };

  assert.throws(() => channel.receive(notification), /registry|invalid|receipt/i);
  assert.equal(received.length, 0);
  assert.deepEqual(acknowledged, []);
  assert.equal(localStorage.length, 2);
  channel.close();
});

test('a receipt from another pending result cannot clear or acknowledge the wrong correlation', async () => {
  const { createBridgeResultChannel } = await import('./bridgeLaunch.js');
  const localStorage = memoryStorage();
  const firstReceipt = Buffer.alloc(32, 8).toString('base64url');
  const secondReceipt = Buffer.alloc(32, 9).toString('base64url');
  const firstNonce = Buffer.alloc(32, 1).toString('base64url');
  const secondNonce = Buffer.alloc(32, 2).toString('base64url');
  const firstTab = Buffer.alloc(16, 1).toString('base64url');
  const secondTab = Buffer.alloc(16, 2).toString('base64url');
  localStorage.setItem(`lightweaver.bridge.pending.v1.${firstNonce}`, JSON.stringify({
    operation: 'restart-card', nonce: firstNonce, tabId: firstTab,
    createdAt: 0, expiresAt: 300_000, receipt: firstReceipt,
  }));
  localStorage.setItem(`lightweaver.bridge.pending.v1.${secondNonce}`, JSON.stringify({
    operation: 'release-usb', nonce: secondNonce, tabId: secondTab,
    createdAt: 0, expiresAt: 300_000, receipt: secondReceipt,
  }));
  const sessionStorage = memoryStorage();
  sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', firstTab);
  const received = [];
  const acknowledged = [];
  const channel = createBridgeResultChannel({
    sessionStorage, localStorage, BroadcastChannel: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} },
    onResult: result => received.push(result), acknowledge: url => acknowledged.push(url),
  });

  channel.receive({
    version: 1, type: 'bridge-result', deliveryId: 'AQEBAQEBAQEBAQEB', targetTabId: firstTab,
    operation: 'restart-card', status: 'awaiting-card-acknowledgement', code: 'operation-complete',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified',
    physicalOutput: 'unconfirmed', ackReceipt: secondReceipt,
  });
  assert.deepEqual(received, []);
  assert.deepEqual(acknowledged, []);
  assert.equal(localStorage.length, 2);
  channel.close();
});

test('callback bootstrap publishes as a receipt-free producer handoff without returning result data', async () => {
  const { bootstrapBridgeCallback } = await import('./bridgeLaunch.js');
  const order = [];
  const receipt = 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ';
  const success = await bootstrapBridgeCallback({
    href: 'https://led.mandalacodes.com/#bridge-result?x=1',
    consume: async href => { order.push(`consume:${href}`); return { operation: 'restart-card', ackReceipt: receipt }; },
    publish: result => order.push(`publish:${result.operation}`),
  });
  assert.deepEqual(success, {
    kind: 'handoff',
    message: 'Bridge return is pending in the Studio tab that started this action.',
  });
  assert.equal(JSON.stringify(success).includes(receipt), false);
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

test('storage failure keeps receipt authority pending and exposes no UI or acknowledgement', async () => {
  const { createBridgeResultChannel } = await import('./bridgeLaunch.js');
  const sessionStorage = memoryStorage();
  sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', 'AQEBAQEBAQEBAQEBAQEBAQ');
  const calls = [];
  const channel = createBridgeResultChannel({
    sessionStorage, localStorage: memoryStorage(), BroadcastChannel: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} },
    claimReceipt: () => { calls.push('claim'); return true; },
    persistResult: () => { calls.push('save'); throw new Error('quota'); },
    onResult: () => calls.push('ui'),
    confirmReceipt: () => { calls.push('finalize'); return true; },
    releaseReceipt: () => calls.push('release'),
    acknowledge: () => calls.push('ack'),
  });
  assert.throws(() => channel.receive({
    version: 1, type: 'bridge-result', deliveryId: 'AQEBAQEBAQEBAQEB',
    targetTabId: 'AQEBAQEBAQEBAQEBAQEBAQ', operation: 'restart-card',
    status: 'awaiting-card-acknowledgement', code: 'operation-complete',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified',
    physicalOutput: 'unconfirmed', ackReceipt: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  }), /quota/);
  assert.deepEqual(calls, ['claim', 'save', 'release']);
  channel.close();
});

test('UI delivery failure releases the claim and leaves the durable result available for refresh retry', async () => {
  const { createBridgeResultChannel } = await import('./bridgeLaunch.js');
  const sessionStorage = memoryStorage();
  sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', 'AQEBAQEBAQEBAQEBAQEBAQ');
  const calls = [];
  const channel = createBridgeResultChannel({
    sessionStorage, localStorage: memoryStorage(), BroadcastChannel: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} },
    claimReceipt: () => { calls.push('claim'); return true; },
    persistResult: () => calls.push('save'),
    onResult: () => { calls.push('ui'); throw new Error('renderer stopped'); },
    confirmReceipt: () => { calls.push('finalize'); return true; },
    releaseReceipt: () => calls.push('release'),
    acknowledge: () => calls.push('ack'),
  });
  assert.throws(() => channel.receive({
    version: 1, type: 'bridge-result', deliveryId: 'AQEBAQEBAQEBAQEB',
    targetTabId: 'AQEBAQEBAQEBAQEBAQEBAQ', operation: 'restart-card',
    status: 'awaiting-card-acknowledgement', code: 'operation-complete',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified',
    physicalOutput: 'unconfirmed', ackReceipt: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  }), /renderer stopped/);
  assert.deepEqual(calls, ['claim', 'save', 'ui', 'release']);
  channel.close();
});

test('finalization throw releases the receiver claim and never acknowledges', async () => {
  const { createBridgeResultChannel } = await import('./bridgeLaunch.js');
  const sessionStorage = memoryStorage();
  sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', 'AQEBAQEBAQEBAQEBAQEBAQ');
  const calls = [];
  const channel = createBridgeResultChannel({
    sessionStorage, localStorage: memoryStorage(), BroadcastChannel: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} }, claimReceipt: () => true,
    revalidateReceipt: () => true, persistResult() {}, onResult() {},
    confirmReceipt: () => { calls.push('finalize'); throw new Error('corrupt'); },
    releaseReceipt: () => calls.push('release'), acknowledge: () => calls.push('ack'),
  });
  assert.throws(() => channel.receive({
    version: 1, type: 'bridge-result', deliveryId: 'AQEBAQEBAQEBAQEB', targetTabId: 'AQEBAQEBAQEBAQEBAQEBAQ',
    operation: 'restart-card', status: 'awaiting-card-acknowledgement', code: 'operation-complete',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed',
    ackReceipt: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  }), /corrupt/);
  assert.deepEqual(calls, ['finalize', 'release']);
  channel.close();
});

test('accepted sanitized result survives refresh and explicit completion or dismissal clears it', async () => {
  const { clearStoredBridgeResult, createBridgeResultChannel, readStoredBridgeResult } = await import('./bridgeLaunch.js');
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', 'AQEBAQEBAQEBAQEBAQEBAQ');
  const channel = createBridgeResultChannel({
    sessionStorage, localStorage, BroadcastChannel: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} },
    claimReceipt: () => true, confirmReceipt: () => true, acknowledge() {}, onResult() {},
  });
  channel.receive({
    version: 1, type: 'bridge-result', deliveryId: 'AQEBAQEBAQEBAQEB',
    targetTabId: 'AQEBAQEBAQEBAQEBAQEBAQ', operation: 'restart-card',
    status: 'awaiting-card-acknowledgement', code: 'operation-complete', cardId: 'lw-441bf681feb0',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified',
    physicalOutput: 'unconfirmed', ackReceipt: 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ',
  });
  const restored = readStoredBridgeResult({ sessionStorage, localStorage });
  assert.equal(restored.operation, 'restart-card');
  assert.equal(restored.cardId, 'lw-441bf681feb0');
  assert.equal('ackReceipt' in restored, false);
  assert.equal('deliveryId' in restored, false);
  assert.equal(clearStoredBridgeResult({ sessionStorage, localStorage }), true);
  assert.equal(readStoredBridgeResult({ sessionStorage, localStorage }), null);
  assert.equal(clearStoredBridgeResult({ sessionStorage, localStorage }), false);
  channel.close();
});

test('durable accepted results use one bounded registry across one hundred tabs', async () => {
  const { createBridgeResultChannel } = await import('./bridgeLaunch.js');
  const localStorage = memoryStorage();
  for (let index = 0; index < 100; index += 1) {
    const tabId = Buffer.alloc(16, index + 1).toString('base64url');
    const sessionStorage = memoryStorage();
    sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', tabId);
    const channel = createBridgeResultChannel({
      sessionStorage, localStorage, BroadcastChannel: null,
      eventTarget: { addEventListener() {}, removeEventListener() {} },
      claimReceipt: () => true, revalidateReceipt: () => true, confirmReceipt: () => true, acknowledge() {}, onResult() {},
      now: () => index + 1,
    });
    channel.receive({ version: 1, type: 'bridge-result', deliveryId: Buffer.alloc(12, index + 1).toString('base64url'),
      targetTabId: tabId, operation: 'restart-card', status: 'awaiting-card-acknowledgement', code: 'operation-complete',
      target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed',
      ackReceipt: Buffer.alloc(32, index + 1).toString('base64url') });
    channel.close();
  }
  const resultKeys = [...Array(localStorage.length).keys()].map(index => localStorage.key(index)).filter(key => key.includes('accepted-result'));
  assert.equal(resultKeys.length, 1);
  assert.ok(localStorage.getItem(resultKeys[0]).length <= 8192);
});

test('durable result registry prunes expiry and fails closed on corrupt or oversized state', async () => {
  const { clearStoredBridgeResult, createBridgeResultChannel, readStoredBridgeResult } = await import('./bridgeLaunch.js');
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const tabId = Buffer.alloc(16, 3).toString('base64url');
  sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', tabId);
  const channel = createBridgeResultChannel({ sessionStorage, localStorage, BroadcastChannel: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} }, claimReceipt: () => true,
    revalidateReceipt: () => true, confirmReceipt: () => true, acknowledge() {}, onResult() {}, now: () => 1 });
  channel.receive({ version: 1, type: 'bridge-result', deliveryId: Buffer.alloc(12, 3).toString('base64url'), targetTabId: tabId,
    operation: 'restart-card', status: 'awaiting-card-acknowledgement', code: 'operation-complete',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed',
    ackReceipt: Buffer.alloc(32, 3).toString('base64url') });
  const key = [...Array(localStorage.length).keys()].map(index => localStorage.key(index)).find(value => value.includes('accepted-result'));
  assert.ok(readStoredBridgeResult({ sessionStorage, localStorage, now: () => 2 }));
  assert.equal(readStoredBridgeResult({ sessionStorage, localStorage, now: () => 7 * 24 * 60 * 60 * 1_000 + 2 }), null);
  assert.deepEqual(JSON.parse(localStorage.getItem(key)).records, []);
  localStorage.setItem(key, '{bad');
  assert.equal(readStoredBridgeResult({ sessionStorage, localStorage }), null);
  assert.equal(clearStoredBridgeResult({ sessionStorage, localStorage }), false);
  localStorage.setItem(key, 'x'.repeat(8_193));
  assert.equal(readStoredBridgeResult({ sessionStorage, localStorage }), null);
  assert.equal(localStorage.length, 1);
  channel.close();
});

test('distinct receipt accepts share one registry mutation lock and both restore', async () => {
  const { createBridgeResultChannel, readStoredBridgeResult } = await import('./bridgeLaunch.js');
  const localStorage = memoryStorage();
  const calls = [];
  const locks = recordingLocks(calls);
  const channels = [];
  for (let index = 1; index <= 2; index += 1) {
    const sessionStorage = memoryStorage();
    const tabId = Buffer.alloc(16, index).toString('base64url');
    sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', tabId);
    const received = [];
    const channel = createBridgeResultChannel({ sessionStorage, localStorage, locks,
      eventTarget: { addEventListener() {}, removeEventListener() {} }, BroadcastChannel: null,
      claimReceipt: () => true, revalidateReceipt: () => true, confirmReceipt: () => true,
      onResult: result => received.push(result), acknowledge() {}, now: () => index });
    channels.push({ channel, sessionStorage, received, index, tabId });
  }
  await Promise.all(channels.map(({ channel, index, tabId }) => channel.receive({
    version: 1, type: 'bridge-result', deliveryId: Buffer.alloc(12, index).toString('base64url'), targetTabId: tabId,
    operation: 'restart-card', status: 'awaiting-card-acknowledgement', code: 'operation-complete',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed',
    ackReceipt: Buffer.alloc(32, index).toString('base64url'),
  })));
  assert.equal(calls.filter(name => name === 'lightweaver.bridge.accepted-result-registry.lock.v1').length, 2);
  for (const item of channels) {
    assert.equal(item.received.length, 1);
    assert.equal(readStoredBridgeResult({ sessionStorage: item.sessionStorage, localStorage, now: () => 3 }).operation, 'restart-card');
    item.channel.close();
  }
});

test('fallback registry contention waits for release and times out without UI or ACK', async () => {
  const { createBridgeResultChannel } = await import('./bridgeLaunch.js');
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const tabId = Buffer.alloc(16, 11).toString('base64url');
  sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', tabId);
  const leaseKey = 'lightweaver.bridge.accepted-result-registry.lease.v1';
  let now = 1;
  localStorage.setItem(leaseKey, JSON.stringify({ owner: Buffer.alloc(16, 12).toString('base64url'), expiresAt: 50 }));
  const calls = [];
  const channel = createBridgeResultChannel({ sessionStorage, localStorage, locks: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} }, BroadcastChannel: null,
    claimReceipt: () => true, revalidateReceipt: () => true, confirmReceipt: () => true,
    releaseReceipt: () => calls.push('release'), onResult: () => calls.push('ui'), acknowledge: () => calls.push('ack'),
    now: () => now, registryDelay: async () => { now = 51; localStorage.removeItem(leaseKey); } });
  const message = { version: 1, type: 'bridge-result', deliveryId: Buffer.alloc(12, 11).toString('base64url'), targetTabId: tabId,
    operation: 'restart-card', status: 'awaiting-card-acknowledgement', code: 'operation-complete', target: 'lightweaver-controller-esp32s3',
    verification: 'not-verified', physicalOutput: 'unconfirmed', ackReceipt: Buffer.alloc(32, 11).toString('base64url') };
  await channel.receive(message);
  assert.deepEqual(calls, ['ui', 'ack']);
  calls.length = 0; now = 100;
  localStorage.setItem(leaseKey, JSON.stringify({ owner: Buffer.alloc(16, 12).toString('base64url'), expiresAt: 10_000 }));
  const blocked = createBridgeResultChannel({ sessionStorage, localStorage, locks: null,
    eventTarget: { addEventListener() {}, removeEventListener() {} }, BroadcastChannel: null,
    claimReceipt: () => true, revalidateReceipt: () => true, releaseReceipt: () => calls.push('release'),
    onResult: () => calls.push('ui'), acknowledge: () => calls.push('ack'), now: () => now,
    registryDelay: async () => { now += 900; } });
  await assert.rejects(() => blocked.receive({ ...message, deliveryId: Buffer.alloc(12, 13).toString('base64url'), ackReceipt: Buffer.alloc(32, 13).toString('base64url') }), /busy/);
  assert.deepEqual(calls, ['release']);
  channel.close(); blocked.close();
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
    onResult: result => received.push(result), acknowledge: url => acknowledgements.push(url), now: () => 2,
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
    onResult: result => order.push(`ui:${result.operation}`), acknowledge: () => order.push('ack'), now: () => 2,
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
  const appSource = fs.readFileSync(path.join(import.meta.dirname, '../v3/app.jsx'), 'utf8');
  assert.doesNotMatch(appSource, /setBridgeResult\(outcome\.result\)/);
  assert.match(appSource, /readStoredBridgeResult/);
  assert.match(appSource, /clearStoredBridgeResult/);
});
