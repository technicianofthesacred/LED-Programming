'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const VALID = `lightweaver://run?operation=install-current-release&nonce=${NONCE}&version=1`;

test('launch parser accepts only the exact bounded canonical form', () => {
  const { parseLaunchUrl } = require('../src/deep-link-protocol');
  assert.deepEqual(parseLaunchUrl(VALID), {
    operation: 'install-current-release', nonce: NONCE, version: 1,
  });
  for (const value of [
    VALID.replace('lightweaver:', 'https:'), VALID.replace('//run', '//other'),
    VALID.replace('//run?', '//run/path?'), `${VALID}#x`, `${VALID}&extra=x`,
    VALID.replace('operation=', 'operation=x&operation='), VALID.replace('&nonce=', '&nonce=x&nonce='),
    VALID.replace('version=1', 'version=2'), VALID.replace('nonce=', 'nonce=%41'),
    VALID.replace('nonce=', 'nonce=+'), VALID.replace(NONCE, 'short'),
    VALID.replace('install-current-release', 'flash-file'), 'lightweaver://run',
    `lightweaver://run?nonce=${NONCE}&operation=install-current-release&version=1`,
    `${VALID}${'x'.repeat(300)}`,
  ]) assert.throws(() => parseLaunchUrl(value));
});

test('argv extraction interprets only one exact protocol argument on every platform', () => {
  const { findLaunchUrlInArgv } = require('../src/deep-link-protocol');
  assert.equal(findLaunchUrlInArgv(['/Applications/Bridge', VALID]), VALID);
  assert.equal(findLaunchUrlInArgv(['Bridge.exe', '--flag', VALID]), VALID);
  assert.equal(findLaunchUrlInArgv(['/opt/bridge', '--smoke-test']), null);
  assert.throws(() => findLaunchUrlInArgv(['Bridge', VALID, VALID.replace('install-', 'recover-')]));
  assert.throws(() => findLaunchUrlInArgv(['Bridge', 'lightweaver:garbage']));
});

test('launch router queues one request and rejects replay or concurrent launches', () => {
  const { createLaunchRouter } = require('../src/deep-link-protocol');
  const consumed = [];
  const delivered = [];
  const router = createLaunchRouter({ consumeNonce: request => consumed.push(request), deliver: request => delivered.push(request) });
  router.route(VALID);
  assert.equal(delivered.length, 0);
  assert.throws(() => router.route(VALID), /active|pending/i);
  router.setReady();
  assert.equal(delivered.length, 1);
  assert.equal(consumed.length, 1);
  assert.throws(() => router.route(VALID.replace('install-current-release', 'recover-current-release')), /active/i);
  router.complete();
  router.route(VALID.replace('install-current-release', 'recover-current-release').replace(NONCE, Buffer.alloc(32, 2).toString('base64url')));
  assert.equal(delivered.length, 2);
});

test('launch router never delivers a queued request after its five-minute expiry', () => {
  const { createLaunchRouter } = require('../src/deep-link-protocol');
  let timestamp = 0;
  const delivered = [];
  const router = createLaunchRouter({ consumeNonce() {}, deliver: value => delivered.push(value), now: () => timestamp });
  router.route(VALID);
  timestamp = 300_001;
  assert.throws(() => router.setReady(), /expired/i);
  assert.equal(delivered.length, 0);
  assert.equal(router.active, null);
});

test('nonce store persists only hashes and rejects replay across restart', () => {
  const { createNonceStore } = require('../src/deep-link-protocol');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-nonce-'));
  const now = 10_000;
  const request = { operation: 'install-current-release', nonce: NONCE, expiresAt: now + 300_000 };
  createNonceStore({ userDataPath: dir, now: () => now }).consume(request);
  const raw = fs.readFileSync(path.join(dir, 'launch-nonces.json'), 'utf8');
  assert.equal(raw.includes(NONCE), false);
  assert.match(raw, /[a-f0-9]{64}/);
  assert.throws(() => createNonceStore({ userDataPath: dir, now: () => now }).consume(request), /replay/i);
});

test('nonce store prunes expired records, remains bounded, and fails closed on corrupt or oversized state', () => {
  const { createNonceStore, NONCE_STORE_MAX_BYTES } = require('../src/deep-link-protocol');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-nonce-'));
  const file = path.join(dir, 'launch-nonces.json');
  fs.writeFileSync(file, '{broken', { mode: 0o600 });
  assert.throws(() => createNonceStore({ userDataPath: dir, now: () => 50 }).consume({ operation: 'release-usb', nonce: NONCE, expiresAt: 100 }), /unavailable|invalid/i);
  fs.writeFileSync(file, 'x'.repeat(NONCE_STORE_MAX_BYTES + 1), { mode: 0o600 });
  assert.throws(() => createNonceStore({ userDataPath: dir, now: () => 50 }).consume({ operation: 'release-usb', nonce: NONCE, expiresAt: 100 }), /large|unavailable/i);
  fs.writeFileSync(file, JSON.stringify({ version: 1, records: [{ hash: 'a'.repeat(64), operation: 'restart-card', expiresAt: 999 }] }), { mode: 0o600 });
  const store = createNonceStore({ userDataPath: dir, now: () => 1_000 });
  for (let i = 0; i < 70; i += 1) {
    const nonce = Buffer.alloc(32, i + 1).toString('base64url');
    store.consume({ operation: 'restart-card', nonce, expiresAt: 2_000 + i });
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed.records.length <= 64);
  assert.deepEqual(Object.keys(parsed).sort(), ['records', 'version']);
  assert.ok(parsed.records.every(record => Object.keys(record).sort().join(',') === 'expiresAt,hash,operation'));
});

test('fixed callback includes only bounded truthful fields and round-trips through validation', () => {
  const { buildCallbackUrl, validateCallbackUrl } = require('../src/deep-link-protocol');
  const result = {
    status: 'awaiting-card-acknowledgement', code: 'flash-verified', cardId: 'lw-441bf681feb0',
    firmwareVersion: '1.2.3+build.1', buildId: 'a'.repeat(40), target: 'lightweaver-controller-esp32s3',
    verification: 'flash-verified', physicalOutput: 'unconfirmed',
  };
  const url = buildCallbackUrl({ nonce: NONCE, version: 1 }, result);
  assert.ok(url.startsWith('https://led.mandalacodes.com/#bridge-result?'));
  assert.deepEqual(validateCallbackUrl(url), { ...result, nonce: NONCE, version: 1 });
  assert.throws(() => buildCallbackUrl({ nonce: NONCE, version: 1 }, { ...result, physicalOutput: 'verified' }));
  assert.throws(() => buildCallbackUrl({ nonce: NONCE, version: 1 }, { ...result, status: 'complete' }));
  assert.throws(() => validateCallbackUrl(url.replace('led.mandalacodes.com', 'evil.example')));
  assert.equal(url.includes('/dev/cu.secret'), false);
});

test('failure callbacks omit identity and never include raw card errors', () => {
  const { buildCallbackUrl } = require('../src/deep-link-protocol');
  const url = buildCallbackUrl({ nonce: NONCE, version: 1 }, {
    status: 'recoverable-failure', code: 'inspection-failed-/dev/cu.secret',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed',
  });
  assert.equal(url.includes('/dev/'), false);
  assert.equal(url.includes('cardId'), false);
});

test('protocol registration uses packaged and development Electron arguments correctly', () => {
  const { registerProtocolClient } = require('../src/deep-link-protocol');
  const calls = [];
  const app = { setAsDefaultProtocolClient: (...args) => { calls.push(args); return true; } };
  assert.equal(registerProtocolClient(app, { defaultApp: false }), true);
  assert.deepEqual(calls.pop(), ['lightweaver']);
  assert.equal(registerProtocolClient(app, { defaultApp: true, execPath: '/electron', entryPath: '/app/main.js' }), true);
  assert.deepEqual(calls.pop(), ['lightweaver', '/electron', ['/app/main.js']]);
});

test('safe callback opener builds and immediately revalidates its own fixed URL', async () => {
  const { createSafeCallbackOpener } = require('../src/deep-link-protocol');
  const opened = [];
  const opener = createSafeCallbackOpener({ openExternal: async url => opened.push(url) });
  await opener.open({ nonce: NONCE, version: 1 }, {
    status: 'recoverable-failure', code: 'no-compatible-card', target: 'lightweaver-controller-esp32s3',
    verification: 'not-verified', physicalOutput: 'unconfirmed',
  });
  assert.equal(opened.length, 1);
  assert.ok(opened[0].startsWith('https://led.mandalacodes.com/#bridge-result?'));
  assert.equal('openUrl' in opener, false);
  await assert.rejects(() => opener.open({ nonce: NONCE, version: 1 }, { status: 'complete' }));
});

test('packaging declares the Lightweaver scheme and main wires every native launch route', () => {
  const builder = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(builder, /protocols:[\s\S]*schemes:[\s\S]*- lightweaver/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /open-url/);
  assert.match(main, /second-instance/);
  assert.match(main, /findLaunchUrlInArgv\(process\.argv\)/);
  assert.match(main, /bridge:launch-request/);
});
