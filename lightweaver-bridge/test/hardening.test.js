'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bridgeRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(bridgeRoot, 'src', 'renderer', 'index.html');
const rendererUrl = new URL(`file://${rendererPath}`).href;
const DEVICE_REDACTION_VECTORS = Object.freeze([
  ['/dev/ttyACM0', 'open failed: /dev/ttyACM0'],
  ['/dev/tty.usbmodem14101', '{"path":"/dev/tty.usbmodem14101","error":"denied"}'],
  ['/dev/cu.usbserial-0001', 'port=/dev/cu.usbserial-0001'],
  ['/dev/ttyUSB7', 'cannot access /dev/ttyUSB7: busy'],
  ['/dev/ttyS0', 'legacy UART failed at /dev/ttyS0'],
  ['/dev/ttyAMA0', '{"path":"/dev/ttyAMA0"}'],
  ['/dev/serial/by-id/usb-Espressif_ABC123-if00', '{"device":"/dev/serial/by-id/usb-Espressif_ABC123-if00"}'],
  ['/dev/serial/by-path/platform-3f980000.usb-usb-0:1.2:1.0-port0', 'error=/dev/serial/by-path/platform-3f980000.usb-usb-0:1.2:1.0-port0'],
  ['COM12', '{"port":"COM12","error":"busy"}'],
  ['\\\\.\\COM18', 'Windows device \\\\.\\COM18 unavailable'],
]);
const SERIAL_REDACTION_VECTORS = Object.freeze([
  ['ABC123', 'serial=ABC123'],
  ['CASE456', 'SeRiAl=CASE456'],
  ['JSON789', '{"serial":"JSON789"}'],
  ['UNDER012', '{"serial_number":"UNDER012"}'],
  ['CAMEL345', '{"serialNumber":"CAMEL345"}'],
]);

function trustedWindowAndEvent() {
  const mainFrame = { url: rendererUrl };
  const webContents = { mainFrame };
  return {
    window: { webContents, isDestroyed: () => false },
    event: { sender: webContents, senderFrame: mainFrame },
  };
}

test('operation state enforces compatible inspection and its transition graph', () => {
  const { createOperationState } = require('../src/operation-state');
  const operation = createOperationState();

  assert.throws(() => operation.startOperation(), /inspection/i);
  let inspection = operation.beginInspection();
  assert.throws(() => operation.startOperation(), /inspection/i);
  operation.completeInspection(inspection, false);
  assert.throws(() => operation.startOperation(), /compatible/i);

  inspection = operation.beginInspection();
  operation.completeInspection(inspection, true);
  assert.equal(operation.startOperation(), 'confirm');
  assert.equal(operation.enterCriticalSection(), 'installing');
  assert.throws(() => operation.beginInspection(), /transition/i);
  assert.throws(() => operation.startOperation(), /transition|inspection/i);
  assert.equal(operation.cancel(), false);
  assert.equal(operation.shouldPreventClose(), true);
  assert.equal(operation.advanceVerification(), 'verifying');
  assert.throws(() => operation.beginInspection(), /transition/i);
  assert.equal(operation.cancel(), false);
  assert.equal(operation.finishFlashVerified(), 'awaiting-card-acknowledgement');
  assert.equal(operation.shouldPreventClose(), false);
});

test('cancelled or superseded inspection results cannot authorize an operation', () => {
  const { createOperationState } = require('../src/operation-state');
  const operation = createOperationState();
  const staleInspection = operation.beginInspection();
  operation.cancel();
  const activeInspection = operation.beginInspection();

  assert.throws(() => operation.completeInspection(staleInspection, true), /stale/i);
  assert.throws(() => operation.startOperation(), /inspection/i);
  operation.completeInspection(activeInspection, true);
  assert.equal(operation.startOperation(), 'confirm');
});

test('IPC trust requires the active main frame at the exact packaged renderer URL', () => {
  const { isTrustedIpcEvent } = require('../src/security');
  const { window, event } = trustedWindowAndEvent();

  assert.equal(isTrustedIpcEvent(event, window, rendererPath), true);
  assert.equal(isTrustedIpcEvent({ ...event, senderFrame: { url: rendererUrl } }, window, rendererPath), false);
  assert.equal(isTrustedIpcEvent({ ...event, sender: {} }, window, rendererPath), false);
  assert.equal(isTrustedIpcEvent({ ...event, senderFrame: { ...window.webContents.mainFrame, url: 'file:///tmp/index.html' } }, window, rendererPath), false);
  assert.equal(isTrustedIpcEvent(event, { ...window, isDestroyed: () => true }, rendererPath), false);
});

test('every privileged IPC handler rejects untrusted senders before state mutation', async () => {
  const { createIpcHandlers } = require('../src/ipc-handlers');
  const { createOperationState } = require('../src/operation-state');
  const { window } = trustedWindowAndEvent();
  const operation = createOperationState();
  const handlers = createIpcHandlers({
    getActiveWindow: () => window,
    rendererPath,
    operation,
    runner: { inspect: async () => ({ compatible: true }), prepare: async () => ({}), execute: async () => ({}) },
  });
  const badEvent = { sender: window.webContents, senderFrame: { url: rendererUrl } };

  for (const [channel, handler] of Object.entries(handlers)) {
    const argument = channel === 'bridge:start-operation' ? 'install-current-release' : channel === 'bridge:confirm-destructive' ? 'a'.repeat(48) : undefined;
    await assert.rejects(Promise.resolve().then(() => handler(badEvent, argument)), /untrusted/i);
    assert.equal(operation.current, 'select-card');
  }
});

test('IPC handlers require a successful compatible inspection before start and lock critical state', async () => {
  const { createIpcHandlers } = require('../src/ipc-handlers');
  const { createOperationState } = require('../src/operation-state');
  const { window, event } = trustedWindowAndEvent();
  const operation = createOperationState();
  const handlers = createIpcHandlers({
    getActiveWindow: () => window,
    rendererPath,
    operation,
    runner: {
      inspect: async () => ({ compatible: true, productName: 'Lightweaver Card', cardId: 'lw-441bf681feb0' }),
      prepare: async () => ({ confirmationToken: 'b'.repeat(48), cardId: 'lw-441bf681feb0', warning: 'Factory install replaces card configuration.' }),
      execute: () => new Promise(() => {}),
    },
  });

  await assert.rejects(() => handlers['bridge:start-operation'](event, 'install-current-release'), /inspection/i);
  const inspection = await handlers['bridge:inspect'](event);
  assert.equal(inspection.compatible, true);
  const confirmation = await handlers['bridge:start-operation'](event, 'install-current-release');
  assert.equal(confirmation.state, 'confirm');
  await handlers['bridge:confirm-destructive'](event, confirmation.confirmationToken);
  assert.equal(operation.current, 'installing');
  await assert.rejects(() => handlers['bridge:inspect'](event), /transition/i);
  await assert.rejects(() => handlers['bridge:start-operation'](event, 'install-current-release'), /transition|inspection/i);
  assert.deepEqual(await handlers['bridge:cancel'](event), { cancelled: false, state: 'installing' });
});

test('confirmation returns installing promptly while async runner drives verified completion to only the active frame', async () => {
  const { createIpcHandlers } = require('../src/ipc-handlers');
  const { createOperationState } = require('../src/operation-state');
  const { window, event } = trustedWindowAndEvent();
  const sent = [];
  window.webContents.send = (channel, payload) => sent.push([channel, payload]);
  let finish;
  const operation = createOperationState();
  const handlers = createIpcHandlers({
    getActiveWindow: () => window,
    rendererPath,
    operation,
    runner: {
      inspect: async () => ({ compatible: true, cardId: 'lw-441bf681feb0' }),
      prepare: async () => ({ confirmationToken: 'd'.repeat(48), cardId: 'lw-441bf681feb0', warning: 'Factory install replaces card configuration.' }),
      execute: ({ onEvent }) => new Promise(resolve => {
        finish = () => {
          onEvent({ checkpoint: 'erase-started', progress: 1 });
          onEvent({ checkpoint: 'flash-verification-completed', progress: 100 });
          resolve({
            state: 'awaiting-card-acknowledgement', pipelineComplete: false,
            cardId: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40),
            target: 'lightweaver-controller-esp32s3', verification: 'flash-verified',
            physicalOutput: 'unconfirmed', expectedCardId: 'lw-441bf681feb0',
            nextCheckpoint: 'stable-card-identity-acknowledged', message: 'Reconnect in Studio and confirm lights.',
          });
        };
      }),
    },
  });
  await handlers['bridge:inspect'](event);
  const confirmation = await handlers['bridge:start-operation'](event, 'install-current-release');
  const installing = await handlers['bridge:confirm-destructive'](event, confirmation.confirmationToken);
  assert.equal(installing.state, 'installing');
  assert.equal(operation.current, 'installing');
  await new Promise(resolve => setImmediate(resolve));
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operation.current, 'awaiting-card-acknowledgement');
  assert.deepEqual(sent.map(([channel]) => channel), ['bridge:progress', 'bridge:progress', 'bridge:result']);
  const result = sent.at(-1)[1];
  assert.equal(result.verification, 'flash-verified');
  assert.equal(result.physicalOutput, 'unconfirmed');
  assert.equal(result.pipelineComplete, false);
  assert.equal(result.state, 'awaiting-card-acknowledgement');
});

test('IPC preserves structured failure classifications and truthful distinct result states', async () => {
  const { createIpcHandlers } = require('../src/ipc-handlers');
  const { createOperationState } = require('../src/operation-state');
  for (const [classification, expectedState, expectedGuidance] of [
    ['recoverable-failure', 'operation-failed', /inspect again/i],
    ['needs-safe-recovery', 'recovery-required', /recover/i],
    ['usb-ownership-uncertain', 'usb-ownership-uncertain', /restart.*bridge/i],
  ]) {
    const { window, event } = trustedWindowAndEvent();
    const sent = [];
    window.webContents.send = (channel, payload) => sent.push([channel, payload]);
    const error = Object.assign(new Error('failed /dev/cu.secret'), {
      code: 'structured-failure', classification, phase: 'before-erase', nextAction: classification,
    });
    const operation = createOperationState();
    const handlers = createIpcHandlers({
      getActiveWindow: () => window, rendererPath, operation,
      runner: {
        inspect: async () => ({ compatible: true, cardId: 'lw-441bf681feb0' }),
        prepare: async () => ({ confirmationToken: 'f'.repeat(48), cardId: 'lw-441bf681feb0', warning: 'Replace config.' }),
        execute: async () => { throw error; },
      },
    });
    await handlers['bridge:inspect'](event);
    const confirmation = await handlers['bridge:start-operation'](event, 'install-current-release');
    await handlers['bridge:confirm-destructive'](event, confirmation.confirmationToken);
    await new Promise(resolve => setImmediate(resolve));
    const payload = sent.at(-1)[1];
    assert.equal(payload.state, expectedState);
    assert.equal(payload.classification, classification);
    assert.equal(payload.code, 'structured-failure');
    assert.equal(payload.message.includes('/dev/'), false);
    assert.match(payload.message, expectedGuidance);
  }
});

test('synchronous IPC errors return bounded structured codes without raw paths', async () => {
  const { createIpcHandlers } = require('../src/ipc-handlers');
  const { createOperationState } = require('../src/operation-state');
  const { window, event } = trustedWindowAndEvent();
  const handlers = createIpcHandlers({
    getActiveWindow: () => window, rendererPath, operation: createOperationState(),
    runner: { inspect: async () => { throw Object.assign(new Error('No card /dev/cu.secret'), {
      code: 'no-compatible-card', classification: 'recoverable-failure', phase: 'inspection', nextAction: 'inspect-again',
    }); } },
  });
  const result = await handlers['bridge:inspect'](event);
  assert.equal(result.code, 'no-compatible-card');
  assert.equal(result.classification, 'recoverable-failure');
  assert.equal(result.message.includes('/dev/'), false);
});

test('window recreation cannot inherit destructive confirmation authority', async () => {
  const { createIpcHandlers } = require('../src/ipc-handlers');
  const { createOperationState } = require('../src/operation-state');
  const first = trustedWindowAndEvent();
  let activeWindow = first.window;
  const handlers = createIpcHandlers({
    getActiveWindow: () => activeWindow,
    rendererPath,
    operation: createOperationState(),
    runner: {
      inspect: async () => ({ compatible: true, cardId: 'lw-441bf681feb0' }),
      prepare: async () => ({ confirmationToken: 'e'.repeat(48), cardId: 'lw-441bf681feb0', warning: 'Factory install replaces card configuration.' }),
      execute: async () => ({}),
    },
  });
  await handlers['bridge:inspect'](first.event);
  const confirmation = await handlers['bridge:start-operation'](first.event, 'install-current-release');
  const replacement = trustedWindowAndEvent();
  activeWindow = replacement.window;
  await assert.rejects(
    () => handlers['bridge:confirm-destructive'](replacement.event, confirmation.confirmationToken),
    /expired|match|window/i,
  );
});

test('privileged messages and logs redact device paths and raw USB serial identifiers', () => {
  const { createRendererResult, redactSensitiveText } = require('../src/protocol');
  const sensitive = 'ports /dev/cu.usbmodem14101 /dev/ttyUSB0 COM12 serialNumber=ABC123 USB Serial Number: ZX-99';
  const redacted = redactSensitiveText(sensitive);

  for (const secret of ['/dev/cu.usbmodem14101', '/dev/ttyUSB0', 'COM12', 'ABC123', 'ZX-99']) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /\[redacted-device\]/);
  assert.match(redacted, /\[redacted-serial\]/);

  const result = createRendererResult('inspect', sensitive, {
    compatible: true,
    productName: 'Lightweaver Card',
    rawSerialNumber: 'SECRET',
    path: '/dev/cu.secret',
  });
  assert.deepEqual(Object.keys(result).sort(), ['compatible', 'message', 'productName', 'state']);
  assert.equal(result.message.includes('/dev/'), false);
  assert.equal(Object.isFrozen(result), true);
});

test('redaction handles JSON-shaped and abbreviated USB serial identifiers', () => {
  const { redactSensitiveText } = require('../src/protocol');
  const redacted = redactSensitiveText('{"serialNumber":"JSON123","usbSerialNumber":"USB456","SN":"SHORT789"}');
  for (const secret of ['JSON123', 'USB456', 'SHORT789']) assert.equal(redacted.includes(secret), false);
});

test('main-process redaction removes complete serial device tokens from text, JSON, and errors', () => {
  const { redactSensitiveText } = require('../src/protocol');
  for (const [secret, message] of DEVICE_REDACTION_VECTORS) {
    const redacted = redactSensitiveText(message);
    assert.equal(redacted.includes(secret), false, `leaked ${secret}: ${redacted}`);
    if (secret.includes('ABC123')) assert.equal(redacted.includes('ABC123'), false);
    assert.match(redacted, /\[redacted-device\]/);
  }
  for (const [secret, message] of SERIAL_REDACTION_VECTORS) {
    const redacted = redactSensitiveText(message);
    assert.equal(redacted.includes(secret), false, `leaked serial ${secret}: ${redacted}`);
    assert.match(redacted, /\[redacted-serial\]/);
  }
});

test('privileged handler errors are redacted before crossing IPC', async () => {
  const { createIpcHandlers } = require('../src/ipc-handlers');
  const { createOperationState } = require('../src/operation-state');
  const { window, event } = trustedWindowAndEvent();
  const handlers = createIpcHandlers({
    getActiveWindow: () => window,
    rendererPath,
    operation: createOperationState(),
    runner: { inspect: async () => { throw new Error('Failed /dev/cu.usbmodem1 serialNumber=LEAK123'); } },
  });
  await assert.rejects(
    () => handlers['bridge:inspect'](event),
    (error) => !error.message.includes('/dev/cu') && !error.message.includes('LEAK123'),
  );
});

test('actual sandbox preload exposes only typed API and sanitizes real subscriptions', async () => {
  const preloadSource = fs.readFileSync(path.join(bridgeRoot, 'src', 'preload.js'), 'utf8');
  const listeners = new Map();
  const invokes = [];
  let exposed;
  const ipc = {
    invoke(channel, value) {
      invokes.push([channel, value]);
      return Promise.resolve({
        state: channel === 'bridge:cancel' ? 'select-card' : 'inspect',
        cancelled: true,
        message: '/dev/ttyUSB8 serialNumber=INVOKE123',
        extra: 'must not cross',
      });
    },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
    send() {},
  };
  const context = vm.createContext({
    require(specifier) {
      assert.equal(specifier, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'lightweaverBridge'); exposed = api; } },
        ipcRenderer: ipc,
      };
    },
    window: { location: { assign() {} } },
  });
  vm.runInContext(preloadSource, context, { filename: 'preload.js' });

  assert.deepEqual(Object.keys(exposed).sort(), [
    'cancelBeforeCriticalSection', 'confirmDestructiveAction', 'inspectCompatibleCard',
    'onProgress', 'onResult', 'startOperation',
  ]);
  assert.equal('ipcRenderer' in exposed, false);
  const inspected = await exposed.inspectCompatibleCard();
  assert.deepEqual(Object.keys(inspected).sort(), ['message', 'state']);
  assert.equal(inspected.message.includes('INVOKE123'), false);
  assert.equal(Object.isFrozen(inspected), true);
  await assert.rejects(() => exposed.startOperation('arbitrary'), /operation/i);
  await exposed.startOperation('install-current-release');
  assert.deepEqual(invokes.at(-1), ['bridge:start-operation', 'install-current-release']);

  let received;
  const unsubscribe = exposed.onProgress((payload) => { received = payload; });
  listeners.get('bridge:progress')({ sender: 'must not cross' }, {
    state: 'installing',
    message: '/dev/cu.usbmodem1 serialNumber=RAW123',
    path: '/dev/cu.hidden',
  });
  assert.deepEqual(Object.keys(received).sort(), ['message', 'state']);
  assert.equal(received.message.includes('usbmodem1'), false);
  assert.equal(received.message.includes('RAW123'), false);
  assert.equal(Object.isFrozen(received), true);
  for (const [secret, message] of DEVICE_REDACTION_VECTORS) {
    listeners.get('bridge:progress')({}, { state: 'installing', message });
    assert.equal(received.message.includes(secret), false, `preload leaked ${secret}: ${received.message}`);
    if (secret.includes('ABC123')) assert.equal(received.message.includes('ABC123'), false);
    assert.match(received.message, /\[redacted-device\]/);
  }
  for (const [secret, message] of SERIAL_REDACTION_VECTORS) {
    listeners.get('bridge:progress')({}, { state: 'installing', message });
    assert.equal(received.message.includes(secret), false, `preload leaked serial ${secret}: ${received.message}`);
    assert.match(received.message, /\[redacted-serial\]/);
  }
  unsubscribe();
  assert.equal(listeners.has('bridge:progress'), false);

  const cancelled = await exposed.cancelBeforeCriticalSection();
  assert.deepEqual(Object.keys(cancelled).sort(), ['cancelled', 'state']);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.state, 'select-card');
  assert.equal(Object.isFrozen(cancelled), true);
});

test('declared smoke command runs the packaged artifact helper', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.scripts.smoke, 'node scripts/smoke-artifact.js');
  const helper = fs.readFileSync(path.join(bridgeRoot, 'scripts', 'smoke-artifact.js'), 'utf8');
  assert.match(helper, /dist/);
  assert.match(helper, /--smoke-test/);
  const main = fs.readFileSync(path.join(bridgeRoot, 'src', 'main.js'), 'utf8');
  assert.match(main, /once\(['"]will-navigate/);
  assert.match(main, /new BrowserWindow[\s\S]{0,200}mainWindow = window/);
});

test('runtime USB dependencies are pinned exactly', () => {
  const pkg = require('../package.json');
  assert.deepEqual(pkg.dependencies, {
    '@lightweaver/installer-core': 'file:../packages/installer-core',
    'esptool-js': '0.6.0',
    serialport: '13.0.0',
  });
});
