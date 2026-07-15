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

test('sandboxed preload is self-contained and signals readiness to the main process', () => {
  const preload = fs.readFileSync(path.join(bridgeRoot, 'src/preload.js'), 'utf8');
  assert.doesNotMatch(preload, /require\(['"]\.\//);
  assert.match(preload, /bridge:preload-ready/);
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
