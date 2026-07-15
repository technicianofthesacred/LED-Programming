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
    VALID.replace(NONCE, Buffer.alloc(16).toString('base64url')),
    VALID.replace(NONCE, Buffer.alloc(64).toString('base64url')),
    VALID.replace(NONCE, `${NONCE}=`),
    VALID.replace(NONCE, `${NONCE.slice(0, -1)}B`),
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

test('launch router clears expired active work before admitting a fresh request at and beyond expiry', () => {
  const { createLaunchRouter } = require('../src/deep-link-protocol');
  for (const timestamp of [300_000, 300_001]) {
    let now = 0;
    const consumed = [];
    const router = createLaunchRouter({ consumeNonce: value => consumed.push(value), deliver() {}, now: () => now });
    router.route(VALID);
    now = timestamp;
    const fresh = VALID.replace(NONCE, Buffer.alloc(32, 7).toString('base64url'));
    assert.doesNotThrow(() => router.route(fresh));
    assert.equal(router.active.nonce, Buffer.alloc(32, 7).toString('base64url'));
    assert.equal(consumed.length, 2);
  }
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

test('maintenance callbacks are bounded, unverified, and never claim physical proof', () => {
  const { buildCallbackUrl, validateCallbackUrl } = require('../src/deep-link-protocol');
  const url = buildCallbackUrl({ nonce: NONCE, version: 1 }, {
    status: 'awaiting-card-acknowledgement', code: 'operation-complete', cardId: 'lw-441bf681feb0',
    target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed',
  });
  assert.equal(validateCallbackUrl(url).verification, 'not-verified');
  assert.equal(url.includes('firmwareVersion'), false);
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

test('all five operations complete only their matching callback and release the router', async () => {
  const { createBoundedResultCoordinator, createLaunchRouter } = require('../src/deep-link-protocol');
  const opened = [];
  let index = 1;
  const router = createLaunchRouter({ consumeNonce() {}, deliver() {}, now: () => 0, createContext: () => `ctx-${index}` });
  const coordinator = createBoundedResultCoordinator({ launchRouter: router, openCallback: async (request, result) => opened.push([request, result]), now: () => 0 });
  for (const operation of ['install-current-release', 'recover-current-release', 'inspect-compatible-card', 'release-usb', 'restart-card']) {
    const nonce = Buffer.alloc(32, index++).toString('base64url');
    router.route(`lightweaver://run?operation=${operation}&nonce=${nonce}&version=1`);
    const context = router.claim(operation);
    const result = operation === 'install-current-release' || operation === 'recover-current-release'
      ? { status: 'awaiting-card-acknowledgement', code: 'flash-verified', cardId: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40), target: 'lightweaver-controller-esp32s3', verification: 'flash-verified', physicalOutput: 'unconfirmed' }
      : { status: 'awaiting-card-acknowledgement', code: 'operation-complete', target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed' };
    await coordinator.complete(operation, result, context);
    assert.equal(router.active, null);
  }
  assert.equal(opened.length, 5);
  router.route(`lightweaver://run?operation=restart-card&nonce=${Buffer.alloc(32, 9).toString('base64url')}&version=1`);
  const context = router.claim('restart-card');
  await assert.rejects(() => coordinator.complete('release-usb', { status: 'recoverable-failure' }, context), /match/i);
  assert.notEqual(router.active, null);
  await assert.rejects(() => coordinator.complete('restart-card', { status: 'recoverable-failure' }, 'unrelated-context'), /context/i);
  assert.notEqual(router.active, null);
});

test('busy local workflow is refused before replay admission or delivery', () => {
  const { createLaunchRouter } = require('../src/deep-link-protocol');
  let consumed = 0;
  const router = createLaunchRouter({ consumeNonce() { consumed += 1; }, deliver() {}, canAccept: () => false });
  assert.throws(() => router.route(VALID), /busy/i);
  assert.equal(consumed, 0);
  assert.equal(router.active, null);
});

test('callback delivery failure retains one validated result for retry without rerunning hardware', async () => {
  const { createBoundedResultCoordinator, createLaunchRouter } = require('../src/deep-link-protocol');
  let now = 0;
  let attempts = 0;
  const router = createLaunchRouter({ consumeNonce() {}, deliver() {}, now: () => now, createContext: () => 'a'.repeat(32) });
  router.route(VALID);
  const context = router.claim('install-current-release');
  const result = { status: 'recoverable-failure', code: 'inspection-failed', target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed' };
  const coordinator = createBoundedResultCoordinator({
    launchRouter: router, now: () => now,
    openCallback: async () => { attempts += 1; if (attempts === 1) throw new Error('browser unavailable'); },
  });
  await assert.rejects(() => coordinator.complete('install-current-release', result, context), error => error.code === 'callback-delivery-failed');
  assert.equal(router.active.operation, 'install-current-release');
  assert.equal(coordinator.hasPendingResult, true);
  await coordinator.retry();
  assert.equal(attempts, 2);
  assert.equal(router.active, null);
  assert.equal(coordinator.hasPendingResult, false);
});

test('concurrent callback retries share one delivery attempt and cannot produce a stale failure', async () => {
  const { createBoundedResultCoordinator, createLaunchRouter } = require('../src/deep-link-protocol');
  let attempts = 0;
  let finish;
  const router = createLaunchRouter({ consumeNonce() {}, deliver() {}, now: () => 0 });
  router.route(VALID);
  const context = router.claim('install-current-release');
  const result = { status: 'recoverable-failure', code: 'inspection-failed', target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed' };
  const coordinator = createBoundedResultCoordinator({
    launchRouter: router, now: () => 0,
    openCallback: () => { attempts += 1; return new Promise(resolve => { finish = resolve; }); },
  });
  const completion = coordinator.complete('install-current-release', result, context);
  const retry = coordinator.retry();
  assert.equal(attempts, 1);
  finish();
  assert.deepEqual(await Promise.all([completion, retry]), [true, true]);
  assert.equal(router.active, null);
});

test('callback completion and retry enforce expiry at the exact TTL boundary', async () => {
  const { createBoundedResultCoordinator, createLaunchRouter } = require('../src/deep-link-protocol');
  let now = 0;
  const router = createLaunchRouter({ consumeNonce() {}, deliver() {}, now: () => now, createContext: () => 'b'.repeat(32) });
  router.route(VALID);
  const context = router.claim('install-current-release');
  const coordinator = createBoundedResultCoordinator({ launchRouter: router, now: () => now, openCallback: async () => { throw new Error('offline'); } });
  const result = { status: 'recoverable-failure', code: 'inspection-failed', target: 'lightweaver-controller-esp32s3', verification: 'not-verified', physicalOutput: 'unconfirmed' };
  await assert.rejects(() => coordinator.complete('install-current-release', result, context));
  now = 300_000;
  await assert.rejects(() => coordinator.retry(), error => error.code === 'launch-expired');
  assert.equal(router.active, null);
  assert.equal(coordinator.hasPendingResult, false);

  now = 300_001;
  router.route(VALID);
  const secondContext = router.claim('install-current-release');
  now = 600_001;
  await assert.rejects(
    () => coordinator.complete('install-current-release', result, secondContext),
    error => error.code === 'launch-expired',
  );
  assert.equal(router.active, null);
  assert.equal(coordinator.hasPendingResult, false);
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
