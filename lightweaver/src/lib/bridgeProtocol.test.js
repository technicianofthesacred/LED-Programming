import assert from 'node:assert/strict';
import test from 'node:test';

const NONCE = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('Studio generates a 32-byte Web Crypto nonce and stores one short-lived pending operation', async () => {
  const { createBridgeLaunch } = await import('./bridgeProtocol.js');
  const storage = memoryStorage();
  const crypto = { getRandomValues(bytes) { bytes.fill(1); return bytes; } };
  const launch = createBridgeLaunch('install-current-release', { crypto, storage, now: () => 1_000 });
  assert.equal(launch, `lightweaver://run?operation=install-current-release&nonce=${NONCE}&version=1`);
  assert.throws(() => createBridgeLaunch('recover-current-release', { crypto, storage, now: () => 1_001 }), /pending/i);
  assert.throws(() => createBridgeLaunch('shell-text', { crypto, storage, now: () => 1_001 }));
});

test('Studio callback consumes matching pending state once and clears callback history', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const storage = memoryStorage();
  createBridgeLaunch('inspect-compatible-card', { crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } }, storage, now: () => 5_000 });
  const callback = `https://led.mandalacodes.com/#bridge-result?status=recoverable-failure&code=no-compatible-card&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${NONCE}&version=1`;
  const replaced = [];
  const result = consumeBridgeCallback(callback, {
    currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 6_000,
    history: { replaceState: (...args) => replaced.push(args) },
  });
  assert.equal(result.operation, 'inspect-compatible-card');
  assert.equal(result.status, 'recoverable-failure');
  assert.deepEqual(replaced, [[null, '', '/']]);
  assert.throws(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 6_000 }), /pending|used/i);
});

test('Studio rejects wrong origin, nonce, expiry, malformed results, and physical-success claims', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=flash-verified&cardId=lw-441bf681feb0&firmwareVersion=1.2.3&buildId=${'a'.repeat(40)}&target=lightweaver-controller-esp32s3&verification=flash-verified&physicalOutput=unconfirmed&nonce=${NONCE}&version=1`;
  const setup = () => { const storage = memoryStorage(); createBridgeLaunch('install-current-release', { crypto: { getRandomValues(b) { b.fill(1); return b; } }, storage, now: () => 0 }); return storage; };
  assert.throws(() => consumeBridgeCallback(callback, { currentOrigin: 'https://preview.example', storage: setup(), now: () => 1 }));
  assert.throws(() => consumeBridgeCallback(callback.replace(NONCE, 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 1 }), /nonce/i);
  assert.throws(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 300_001 }), /expired/i);
  assert.throws(() => consumeBridgeCallback(callback.replace('physicalOutput=unconfirmed', 'physicalOutput=verified'), { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 1 }));
  assert.throws(() => consumeBridgeCallback(callback.replace('awaiting-card-acknowledgement', 'complete'), { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 1 }));
  assert.throws(() => consumeBridgeCallback(`${callback}&extra=1`, { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 1 }));
});

test('Bridge and Studio protocol constants cannot silently drift', async () => {
  const studio = await import('./bridgeProtocol.js');
  const bridge = await import('../../../lightweaver-bridge/src/deep-link-protocol.js');
  assert.deepEqual([...studio.BRIDGE_OPERATIONS], [...bridge.OPERATIONS]);
  assert.deepEqual([...studio.BRIDGE_RESULT_STATUSES], [...bridge.RESULT_STATUSES]);
  assert.equal(studio.BRIDGE_CALLBACK_ORIGIN, bridge.CALLBACK_ORIGIN);
});
