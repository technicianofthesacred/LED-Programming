'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('native runtime derives card id, restores application boot, then releases USB', async () => {
  const calls = [];
  const transport = { async disconnect() { calls.push('disconnect'); } };
  const loader = {
    chip: { CHIP_NAME: 'ESP32-S3', async readMac() { return '44:1B:F6:81:FE:B0'; } },
    async detectFlashSize() { return '16MB'; },
  };
  const { createEsptoolRuntime } = require('../src/esptool-runtime');
  const runtime = createEsptoolRuntime({
    selectPort: async () => ({ path: '/dev/cu.secret', vendorId: 0x303a, productId: 0x1001, serialNumber: 'SECRET' }),
    connect: async () => ({ loader, transport }),
    reset: async () => calls.push('reset'),
  });
  const identity = await runtime.inspectOne();
  assert.equal(identity.cardId, 'lw-441bf681feb0');
  assert.equal(identity.chipName, 'ESP32-S3');
  assert.equal(identity.flashSize, '16MB');
  assert.match(identity.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(identity).includes('/dev/'), false);
  assert.equal(JSON.stringify(identity).includes('SECRET'), false);
  assert.deepEqual(calls, ['reset', 'disconnect']);
});

test('inspection failure skips reset but still releases USB', async () => {
  const calls = [];
  const { createEsptoolRuntime } = require('../src/esptool-runtime');
  const runtime = createEsptoolRuntime({
    selectPort: async () => ({}),
    connect: async () => ({
      loader: { async detectFlashSize() { calls.push('identify'); throw new Error('identity failed'); } },
      transport: { async disconnect() { calls.push('disconnect'); } },
    }),
    reset: async () => calls.push('reset'),
  });
  await assert.rejects(() => runtime.inspectOne(), /identity failed/);
  assert.deepEqual(calls, ['identify', 'disconnect']);
});

test('inspection reset failure is structured and still releases USB', async () => {
  const calls = [];
  const { createEsptoolRuntime } = require('../src/esptool-runtime');
  const runtime = createEsptoolRuntime({
    selectPort: async () => ({}),
    connect: async () => ({
      loader: {
        chip: { CHIP_NAME: 'ESP32-S3', async readMac() { return '44:1B:F6:81:FE:B0'; } },
        async detectFlashSize() { return '16MB'; },
      },
      transport: { async disconnect() { calls.push('disconnect'); } },
    }),
    reset: async () => { calls.push('reset'); throw new Error('hard reset failed'); },
  });
  await assert.rejects(() => runtime.inspectOne(), error => {
    assert.equal(error.code, 'card-restoration-failed');
    assert.equal(error.phase, 'inspection-restoration');
    return true;
  });
  assert.deepEqual(calls, ['reset', 'disconnect']);
});

test('USB ownership uncertainty takes precedence when reset and release both fail', async () => {
  const calls = [];
  const { createEsptoolRuntime } = require('../src/esptool-runtime');
  const runtime = createEsptoolRuntime({
    selectPort: async () => ({}),
    connect: async () => ({
      loader: {
        chip: { CHIP_NAME: 'ESP32-S3', async readMac() { return '44:1B:F6:81:FE:B0'; } },
        async detectFlashSize() { return '16MB'; },
      },
      transport: { async disconnect() { calls.push('disconnect'); throw new Error('close failed'); } },
    }),
    reset: async () => { calls.push('reset'); throw new Error('hard reset failed'); },
  });
  await assert.rejects(() => runtime.inspectOne(), error => error.code === 'usb-release-failed' && error.phase === 'usb-release');
  assert.deepEqual(calls, ['reset', 'disconnect']);
});

test('native runtime reports uncertain USB ownership when cleanup fails, even after identity failure', async () => {
  const { createEsptoolRuntime } = require('../src/esptool-runtime');
  const runtime = createEsptoolRuntime({
    selectPort: async () => ({ path: '/dev/cu.secret', vendorId: 0x303a, productId: 0x1001 }),
    connect: async () => ({
      loader: { async detectFlashSize() { throw new Error('identity failed'); } },
      transport: { async disconnect() { throw new Error('close failed'); } },
    }),
    reset: async () => {},
  });
  await assert.rejects(() => runtime.inspectOne(), /USB release failed/i);
});

test('reset retries fail closed when an earlier transport could not release USB', async () => {
  const { connectWithTrackedCleanup } = require('../src/esptool-runtime');
  let created = 0;
  const transports = [];
  const core = {
    async connectEspWithResetSequence({ createTransport }) {
      const failed = createTransport({});
      await failed.disconnect().catch(() => {});
      return { transport: createTransport({}), loader: {} };
    },
  };
  await assert.rejects(() => connectWithTrackedCleanup({
    core,
    port: {},
    createTransport: () => {
      const index = created++;
      const transport = { async disconnect() { if (index === 0) throw new Error('close failed'); } };
      transports.push(transport);
      return transport;
    },
    createLoader: () => ({}),
  }), /USB release failed/i);
  assert.equal(created, 2);
});

test('production dependency source pins bundle, NativeSerialTransport, reset sequence, and Node release mode', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/esptool-runtime.js'), 'utf8');
  assert.match(source, /esptool-js\/bundle\.js/);
  assert.match(source, /NativeSerialTransport/);
  assert.match(source, /connectEspWithResetSequence/);
  assert.match(source, /runtime:\s*['"]node['"]/);
  assert.doesNotMatch(source, /\bconnectESP\b|webserial|github|latest/);
});
