'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const bridgeRoot = path.resolve(__dirname, '..');

test('BrowserWindow preferences isolate and sandbox the renderer', () => {
  const { createWindowOptions } = require('../src/security');
  const options = createWindowOptions('/tmp/preload.js');

  assert.deepEqual(options.webPreferences, {
    preload: '/tmp/preload.js',
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
  });
});

test('only the packaged renderer file is accepted as application content', () => {
  const { isAllowedApplicationUrl } = require('../src/security');
  const renderer = path.join(bridgeRoot, 'src', 'renderer', 'index.html');

  assert.equal(isAllowedApplicationUrl(new URL(`file://${renderer}`).href, renderer), true);
  assert.equal(isAllowedApplicationUrl('https://led.mandalacodes.com/', renderer), false);
  assert.equal(isAllowedApplicationUrl('file:///tmp/index.html', renderer), false);
  assert.equal(isAllowedApplicationUrl('javascript:alert(1)', renderer), false);
});

test('navigation, new windows, and permission requests are denied', () => {
  const { installWebContentsGuards } = require('../src/security');
  const listeners = {};
  let openHandler;
  let permissionHandler;
  let permissionCheckHandler;
  const webContents = {
    on(name, handler) { listeners[name] = handler; },
    setWindowOpenHandler(handler) { openHandler = handler; },
    session: {
      setPermissionRequestHandler(handler) { permissionHandler = handler; },
      setPermissionCheckHandler(handler) { permissionCheckHandler = handler; },
    },
  };

  installWebContentsGuards(webContents);

  let prevented = false;
  listeners['will-navigate']({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(openHandler({ url: 'https://example.com' }), { action: 'deny' });
  let permissionAllowed = true;
  permissionHandler(webContents, 'serial', (allowed) => { permissionAllowed = allowed; });
  assert.equal(permissionAllowed, false);
  assert.equal(permissionCheckHandler(webContents, 'serial'), false);
});

test('preload exposes only frozen typed methods and strips Electron events', async () => {
  const { createBridgeApi } = require('../src/bridge-api');
  const calls = [];
  const subscriptions = new Map();
  const api = createBridgeApi({
    invoke(channel, value) {
      calls.push([channel, value]);
      return Promise.resolve({ ok: true });
    },
    on(channel, listener) { subscriptions.set(channel, listener); },
    removeListener(channel, listener) {
      if (subscriptions.get(channel) === listener) subscriptions.delete(channel);
    },
  });

  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api).sort(), [
    'cancelBeforeCriticalSection',
    'confirmDestructiveAction',
    'inspectCompatibleCard',
    'onProgress',
    'onResult',
    'startOperation',
  ]);
  assert.equal('ipcRenderer' in api, false);
  assert.equal('serial' in api, false);
  assert.equal('filesystem' in api, false);
  assert.equal('shell' in api, false);
  assert.equal('openExternal' in api, false);

  await api.inspectCompatibleCard();
  await api.startOperation('install-firmware');
  await api.confirmDestructiveAction('a'.repeat(32));
  await api.cancelBeforeCriticalSection();
  assert.deepEqual(calls, [
    ['bridge:inspect', undefined],
    ['bridge:start-operation', 'install-firmware'],
    ['bridge:confirm-destructive', 'a'.repeat(32)],
    ['bridge:cancel', undefined],
  ]);

  let received;
  const unsubscribe = api.onProgress((value) => { received = value; });
  subscriptions.get('bridge:progress')({ sender: 'secret' }, { state: 'installing', message: 'safe' });
  assert.deepEqual(received, { state: 'installing', message: 'safe' });
  unsubscribe();
  assert.equal(subscriptions.has('bridge:progress'), false);
});

test('sandboxed preload is self-contained and signals readiness to the main process', () => {
  const preload = fs.readFileSync(path.join(bridgeRoot, 'src/preload.js'), 'utf8');
  assert.doesNotMatch(preload, /require\(['"]\.\//);
  assert.match(preload, /bridge:preload-ready/);
});

test('preload rejects arbitrary operations, invalid tokens, oversized messages, and non-functions', async () => {
  const { createBridgeApi } = require('../src/bridge-api');
  const api = createBridgeApi({ invoke: async () => ({}), on() {}, removeListener() {} });

  await assert.rejects(() => api.startOperation('erase-disk'), /operation/i);
  await assert.rejects(() => api.confirmDestructiveAction('../token'), /token/i);
  assert.throws(() => api.onProgress('not a callback'), /callback/i);

  let received;
  const listeners = new Map();
  const boundedApi = createBridgeApi({
    invoke: async () => ({}),
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener() {},
  });
  boundedApi.onResult((value) => { received = value; });
  listeners.get('bridge:result')({}, {
    state: 'complete',
    message: 'x'.repeat(10_000),
    extra: { secret: true },
  });
  assert.equal(received.message.length, 512);
  assert.equal('extra' in received, false);
  assert.equal(Object.isFrozen(received), true);
});

test('operation state permits cancellation only before the critical section and guards close during it', () => {
  const { createOperationState } = require('../src/operation-state');
  const operation = createOperationState();

  assert.equal(operation.cancel(), true);
  operation.reset();
  operation.transition('confirm');
  assert.equal(operation.cancel(), true);
  operation.reset();
  operation.transition('confirm');
  operation.transition('installing');
  assert.equal(operation.isCritical(), true);
  assert.equal(operation.cancel(), false);
  assert.equal(operation.shouldPreventClose(), true);
  operation.transition('verifying');
  assert.equal(operation.shouldPreventClose(), true);
  operation.transition('complete');
  assert.equal(operation.shouldPreventClose(), false);
});

test('renderer contains all local workflow states and a restrictive CSP', () => {
  const html = fs.readFileSync(path.join(bridgeRoot, 'src/renderer/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(bridgeRoot, 'src/renderer/app.js'), 'utf8');
  const combined = `${html}\n${app}`;

  for (const state of [
    'select-card',
    'inspect',
    'confirm',
    'installing',
    'verifying',
    'complete',
    'recovery-required',
  ]) {
    assert.match(combined, new RegExp(state));
  }
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /style-src 'self'/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<script[^>]*>\s*[^<\s]/);
});

test('builder metadata is local-only, hardened, and tightly scoped', () => {
  const config = fs.readFileSync(path.join(bridgeRoot, 'electron-builder.yml'), 'utf8');
  assert.match(config, /appId: com\.mandalacodes\.lightweaver\.bridge/);
  assert.match(config, /hardenedRuntime: true/);
  assert.match(config, /entitlements: entitlements\.mac\.plist/);
  assert.match(config, /src\/\*\*\/\*/);
  assert.doesNotMatch(config, /lightweaver\/src/);
});
