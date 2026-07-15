'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('unplug-replug guidance requires a deliberate acknowledgement before inspecting again', async () => {
  const elements = new Map();
  for (const id of ['state-marker', 'state-title', 'state-message', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
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
  for (const id of ['state-marker', 'state-title', 'state-message', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
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
  for (const id of ['state-marker', 'state-title', 'state-message', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
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

test('expired website request is noncritical and dismisses without calling hardware', async () => {
  const elements = new Map();
  for (const id of ['state-marker', 'state-title', 'state-message', 'primary-action', 'cancel-action', 'progress', 'progress-bar']) {
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
