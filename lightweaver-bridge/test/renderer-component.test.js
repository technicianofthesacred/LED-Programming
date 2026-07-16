'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { buildReturnCode } = require('../src/deep-link-protocol');

const FULL_FLASH_RETURN_CODE = buildReturnCode({ nonce: Buffer.alloc(32, 1).toString('base64url'), version: 1 }, {
  status: 'awaiting-card-acknowledgement', code: 'flash-verified', cardId: 'lw-441bf681feb0',
  firmwareVersion: '1.2.3', buildId: 'a'.repeat(40), target: 'lightweaver-controller-esp32s3',
  verification: 'flash-verified', physicalOutput: 'unconfirmed',
}, Buffer.alloc(32, 4).toString('base64url'));

test('recovered verified result requires a visible explicit dismissal and never reruns hardware', async () => {
  const elements = new Map();
  for (const id of ['state-marker', 'state-title', 'state-message', 'return-code', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
    elements.set(`#${id}`, { textContent: '', disabled: false, hidden: false, style: {}, listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); } });
  }
  let onResult;
  let dismissed = 0;
  let dismissalContext;
  let hardware = 0;
  const bridge = {
    inspectCompatibleCard: async () => { hardware += 1; }, inspectForOperation: async () => { hardware += 1; },
    startOperation: async () => { hardware += 1; }, confirmDestructiveAction: async () => { hardware += 1; },
    runMaintenanceOperation: async () => { hardware += 1; }, cancelBeforeCriticalSection: async () => ({ cancelled: true }),
    dismissRecoveredResult: async context => { dismissed += 1; dismissalContext = context; return { state: 'select-card', message: 'Saved result dismissed.' }; },
    onResult(listener) { onResult = listener; }, onProgress() {}, onCallbackDelivery() {}, onLaunchRequest() {},
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  vm.runInNewContext(source, { window: { lightweaverBridge: bridge }, document: { querySelector: selector => elements.get(selector) } });
  const recoveredContext = {
    operation: 'install-current-release', cardId: 'lw-441bf681feb0', firmwareVersion: '1.2.3',
    buildId: 'a'.repeat(40), target: 'lightweaver-controller-esp32s3', verification: 'flash-verified',
    resultIdentityHash: 'b'.repeat(64),
  };
  onResult({ state: 'recovered-result-pending', message: 'Recovered verified result.', ...recoveredContext });
  assert.match(elements.get('#state-title').textContent, /recovered/i);
  assert.match(elements.get('#primary-action').textContent, /dismiss/i);
  assert.equal(dismissed, 0);
  await elements.get('#primary-action').listeners.get('click')();
  assert.equal(dismissed, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(dismissalContext)), recoveredContext);
  assert.equal(hardware, 0);
});

test('failed recovered-result dismissal stays in recovery UI for retry', async () => {
  const elements = new Map();
  for (const id of ['state-marker', 'state-title', 'state-message', 'return-code', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
    elements.set(`#${id}`, { textContent: '', disabled: false, hidden: false, style: {}, listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); } });
  }
  let onResult;
  const bridge = {
    dismissRecoveredResult: async () => ({ dismissed: false, state: 'recovered-result-pending', message: 'The saved result could not be cleared. Retry dismissal.' }),
    onResult(listener) { onResult = listener; }, onProgress() {}, onCallbackDelivery() {}, onLaunchRequest() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8'), {
    window: { lightweaverBridge: bridge }, document: { querySelector: selector => elements.get(selector) },
  });
  onResult({
    state: 'recovered-result-pending', operation: 'install-current-release', cardId: 'lw-441bf681feb0', firmwareVersion: '1.2.3',
    buildId: 'a'.repeat(40), target: 'lightweaver-controller-esp32s3', verification: 'flash-verified', resultIdentityHash: 'b'.repeat(64),
  });
  await elements.get('#primary-action').listeners.get('click')();
  assert.match(elements.get('#state-title').textContent, /recovered/i);
  assert.match(elements.get('#state-message').textContent, /could not be cleared/i);
  assert.match(elements.get('#primary-action').textContent, /dismiss/i);
});

test('unplug-replug guidance requires a deliberate acknowledgement before inspecting again', async () => {
  const elements = new Map();
  for (const id of ['state-marker', 'state-title', 'state-message', 'return-code', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
    elements.set(`#${id}`, {
      textContent: '', disabled: false, hidden: false, style: {},
      listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); },
    });
  }
  let onResult;
  let inspectCalls = 0;
  const bridge = {
    inspectCompatibleCard: async () => { inspectCalls += 1; return { state: 'inspect', compatible: true }; },
    inspectForOperation: async () => { inspectCalls += 1; return { state: 'inspect', compatible: true }; },
    startOperation: async () => ({}),
    confirmDestructiveAction: async () => ({}),
    cancelBeforeCriticalSection: async () => ({ cancelled: true }),
    runMaintenanceOperation: async () => ({ state: 'awaiting-card-acknowledgement', code: 'operation-complete' }),
    onProgress() {}, onCallbackDelivery() {},
    onResult(listener) { onResult = listener; },
    onLaunchRequest() {},
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  vm.runInNewContext(source, {
    window: { lightweaverBridge: bridge },
    document: { querySelector: selector => elements.get(selector) },
  });

  onResult({
    state: 'operation-failed',
    nextAction: 'unplug-replug-card',
    message: 'No card changes were confirmed. Inspect again before retrying.',
  });
  assert.equal(elements.get('#state-title').textContent, 'Reconnect the card');
  assert.match(elements.get('#state-message').textContent, /unplug.*wait.*reconnect.*inspect/i);
  assert.equal(elements.get('#primary-action').textContent, 'I reconnected the card');
  assert.equal(inspectCalls, 0);

  await elements.get('#primary-action').listeners.get('click')();
  assert.equal(inspectCalls, 0);
  assert.equal(elements.get('#state-title').textContent, 'Connect a Lightweaver card');
});

test('native launch requests require an operation-specific visible click before maintenance IPC', async () => {
  const elements = new Map();
  for (const id of ['state-marker', 'state-title', 'state-message', 'return-code', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
    elements.set(`#${id}`, { textContent: '', disabled: false, hidden: false, style: {}, listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); } });
  }
  let launch;
  const calls = [];
  const bridge = {
    inspectCompatibleCard: async () => ({}), startOperation: async () => ({}), confirmDestructiveAction: async () => ({}),
    inspectForOperation: async () => ({}),
    cancelBeforeCriticalSection: async () => ({ cancelled: true }), onProgress() {}, onResult() {}, onCallbackDelivery() {},
    onLaunchRequest(listener) { launch = listener; },
    async runMaintenanceOperation(operation) { calls.push(operation); return { state: 'awaiting-card-acknowledgement', code: 'operation-complete' }; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  vm.runInNewContext(source, { window: { lightweaverBridge: bridge }, document: { querySelector: selector => elements.get(selector) } });
  for (const [operation, label] of [['inspect-compatible-card', /inspect/i], ['release-usb', /release/i], ['restart-card', /restart/i]]) {
    launch({ operation });
    assert.match(elements.get('#primary-action').textContent, label);
    assert.equal(calls.includes(operation), false);
    await elements.get('#primary-action').listeners.get('click')();
    assert.equal(calls.at(-1), operation);
  }
});

test('callback delivery failure offers a typed retry without rerunning card hardware', async () => {
  const elements = new Map();
  for (const id of ['state-marker', 'state-title', 'state-message', 'return-code', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
    elements.set(`#${id}`, { textContent: '', disabled: false, hidden: false, style: {}, listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); } });
  }
  let onDelivery;
  let hardwareCalls = 0;
  let retryCalls = 0;
  const bridge = {
    inspectCompatibleCard: async () => { hardwareCalls += 1; },
    inspectForOperation: async () => { hardwareCalls += 1; },
    startOperation: async () => { hardwareCalls += 1; },
    confirmDestructiveAction: async () => { hardwareCalls += 1; },
    runMaintenanceOperation: async () => { hardwareCalls += 1; },
    cancelBeforeCriticalSection: async () => ({ cancelled: true }),
    retryStudioCallback: async () => { retryCalls += 1; return { state: 'callback-returned', message: 'Result returned to Studio.' }; },
    onCallbackDelivery(listener) { onDelivery = listener; }, onProgress() {}, onResult() {}, onLaunchRequest() {},
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  vm.runInNewContext(source, { window: { lightweaverBridge: bridge }, document: { querySelector: selector => elements.get(selector) } });
  onDelivery({ state: 'callback-delivery-failed', message: 'Studio could not be opened.' });
  assert.equal(elements.get('#primary-action').textContent, 'Return to Studio');
  await elements.get('#primary-action').listeners.get('click')();
  assert.equal(retryCalls, 1);
  assert.equal(hardwareCalls, 0);
  assert.equal(elements.get('#state-title').textContent, 'Returned to Studio');
});

test('a full flash return code renders separately and retries without hardware', async () => {
  const elements = new Map();
  for (const id of ['state-marker', 'state-title', 'state-message', 'return-code', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
    elements.set(`#${id}`, { textContent: '', disabled: false, hidden: false, style: {}, listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); } });
  }
  const returnCode = FULL_FLASH_RETURN_CODE;
  let retryCalls = 0;
  const bridge = {
    inspectCompatibleCard: async () => { throw new Error('hardware must not run'); }, inspectForOperation: async () => { throw new Error('hardware must not run'); },
    startOperation: async () => { throw new Error('hardware must not run'); }, confirmDestructiveAction: async () => { throw new Error('hardware must not run'); },
    runMaintenanceOperation: async () => { throw new Error('hardware must not run'); }, cancelBeforeCriticalSection: async () => ({ cancelled: true }),
    retryStudioCallback: async () => { retryCalls += 1; return { state: 'return-pending', message: 'Still pending', returnCode }; },
    onCallbackDelivery(listener) { this.delivery = listener; }, onProgress() {}, onResult() {}, onLaunchRequest() {},
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  vm.runInNewContext(source, { window: { lightweaverBridge: bridge }, document: { querySelector: selector => elements.get(selector) } });
  bridge.delivery({ state: 'return-pending', message: 'Result saved.', returnCode });
  assert.equal(elements.get('#state-message').textContent, 'Result saved.');
  assert.equal(elements.get('#return-code').textContent, returnCode);
  assert.equal(elements.get('#return-code').hidden, false);
  await elements.get('#primary-action').listeners.get('click')();
  assert.equal(retryCalls, 1);
});

test('expired website request is noncritical and dismisses without calling hardware', async () => {
  const elements = new Map();
  for (const id of ['state-marker', 'state-title', 'state-message', 'return-code', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
    elements.set(`#${id}`, { textContent: '', disabled: false, hidden: false, style: {}, listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); } });
  }
  let onDelivery;
  let hardwareCalls = 0;
  let dismissCalls = 0;
  const bridge = {
    inspectCompatibleCard: async () => { hardwareCalls += 1; }, inspectForOperation: async () => { hardwareCalls += 1; },
    startOperation: async () => { hardwareCalls += 1; }, confirmDestructiveAction: async () => { hardwareCalls += 1; },
    runMaintenanceOperation: async () => { hardwareCalls += 1; }, retryStudioCallback: async () => ({}),
    dismissExpiredLaunch: async () => { dismissCalls += 1; return { state: 'select-card', message: 'Connect a Lightweaver card' }; },
    cancelBeforeCriticalSection: async () => ({ cancelled: true }), onProgress() {}, onResult() {}, onLaunchRequest() {},
    onCallbackDelivery(listener) { onDelivery = listener; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  vm.runInNewContext(source, { window: { lightweaverBridge: bridge }, document: { querySelector: selector => elements.get(selector) } });
  onDelivery({ state: 'launch-expired', code: 'launch-expired', message: 'This website request expired. Return to Studio and try again.' });
  assert.match(elements.get('#state-message').textContent, /website request expired.*return to studio.*try again/i);
  assert.equal(elements.get('#primary-action').disabled, false);
  assert.equal(elements.get('#primary-action').textContent, 'Dismiss');
  await elements.get('#primary-action').listeners.get('click')();
  assert.equal(hardwareCalls, 0);
  assert.equal(dismissCalls, 1);
  assert.equal(elements.get('#state-title').textContent, 'Connect a Lightweaver card');
});
