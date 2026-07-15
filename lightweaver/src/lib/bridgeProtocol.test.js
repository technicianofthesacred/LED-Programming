import assert from 'node:assert/strict';
import test from 'node:test';

const NONCE = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
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

test('Studio always clears callback fields but preserves pending state for wrong nonce or malformed results', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const storage = memoryStorage();
  const crypto = { getRandomValues(bytes) { bytes.fill(1); return bytes; } };
  createBridgeLaunch('restart-card', { crypto, storage, now: () => 0 });
  const valid = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&cardId=lw-441bf681feb0&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${NONCE}&version=1`;
  const historyCalls = [];
  const deps = { currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 1, history: { replaceState: (...args) => historyCalls.push(args) } };
  assert.throws(() => consumeBridgeCallback(valid.replace(NONCE, 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), deps), /nonce/i);
  assert.throws(() => consumeBridgeCallback(`${valid}&extra=1`, deps));
  assert.equal(historyCalls.length, 2);
  assert.equal(consumeBridgeCallback(valid, deps).operation, 'restart-card');
  assert.equal(historyCalls.length, 3);
});

test('Studio clears history for absent and expired pending state and rejects alternate nonce lengths', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=recoverable-failure&code=no-compatible-card&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${NONCE}&version=1`;
  const historyCalls = [];
  const history = { replaceState: (...args) => historyCalls.push(args) };
  assert.throws(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', storage: memoryStorage(), now: () => 0, history }), /pending/i);
  const storage = memoryStorage();
  createBridgeLaunch('release-usb', { crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } }, storage, now: () => 0 });
  assert.throws(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 300_000, history }), /expired/i);
  assert.equal(historyCalls.length, 2);
  for (const bytes of [16, 64]) {
    assert.throws(() => consumeBridgeCallback(callback.replace(NONCE, Buffer.alloc(bytes).toString('base64url')), {
      currentOrigin: 'https://led.mandalacodes.com', storage: memoryStorage(), now: () => 0, history,
    }));
  }
  assert.throws(() => consumeBridgeCallback(callback.replace(NONCE, `${NONCE.slice(0, -1)}B`), {
    currentOrigin: 'https://led.mandalacodes.com', storage: memoryStorage(), now: () => 0, history,
  }));
});

test('Bridge and Studio protocol constants cannot silently drift', async () => {
  const studio = await import('./bridgeProtocol.js');
  const bridge = await import('../../../lightweaver-bridge/src/deep-link-protocol.js');
  assert.deepEqual([...studio.BRIDGE_OPERATIONS], [...bridge.OPERATIONS]);
  assert.deepEqual([...studio.BRIDGE_RESULT_STATUSES], [...bridge.RESULT_STATUSES]);
  assert.equal(studio.BRIDGE_CALLBACK_ORIGIN, bridge.CALLBACK_ORIGIN);
});

test('callback tab consumes a pending operation created in another tab through bounded shared local storage', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  const originSession = memoryStorage();
  const callbackSession = memoryStorage();
  let fill = 1;
  const crypto = { getRandomValues(bytes) { bytes.fill(fill++); return bytes; } };
  const launch = createBridgeLaunch('restart-card', { crypto, sessionStorage: originSession, localStorage, now: () => 10 });
  const nonce = new URL(launch).searchParams.get('nonce');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${nonce}&version=1`;
  const result = consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: callbackSession, localStorage, now: () => 20, history: { replaceState() {} } });
  assert.equal(result.operation, 'restart-card');
  assert.throws(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: callbackSession, localStorage, now: () => 20, history: { replaceState() {} } }), /pending|used/i);
});

test('separate originating tabs retain independent active operations in one bounded registry', async () => {
  const { createBridgeLaunch } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  let fill = 1;
  const crypto = { getRandomValues(bytes) { bytes.fill(fill++); return bytes; } };
  assert.doesNotThrow(() => createBridgeLaunch('inspect-compatible-card', { crypto, sessionStorage: memoryStorage(), localStorage, now: () => 0 }));
  assert.doesNotThrow(() => createBridgeLaunch('release-usb', { crypto, sessionStorage: memoryStorage(), localStorage, now: () => 0 }));
});

test('wrong, malformed, and one expired tab callback preserve another tab pending record', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  let fill = 1;
  const crypto = { getRandomValues(bytes) { bytes.fill(fill++); return bytes; } };
  const first = createBridgeLaunch('restart-card', { crypto, sessionStorage: memoryStorage(), localStorage, now: () => 0 });
  const second = createBridgeLaunch('release-usb', { crypto, sessionStorage: memoryStorage(), localStorage, now: () => 100 });
  const firstNonce = new URL(first).searchParams.get('nonce');
  const secondNonce = new URL(second).searchParams.get('nonce');
  const callback = nonce => `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${nonce}&version=1`;
  const dependencies = { currentOrigin: 'https://led.mandalacodes.com', localStorage, now: () => 300_000, history: { replaceState() {} } };
  assert.throws(() => consumeBridgeCallback(`${callback(secondNonce)}&extra=1`, dependencies));
  assert.throws(() => consumeBridgeCallback(callback(firstNonce), dependencies), /expired/i);
  assert.throws(() => consumeBridgeCallback(callback(Buffer.alloc(32, 9).toString('base64url')), dependencies), /nonce/i);
  assert.equal(consumeBridgeCallback(callback(secondNonce), dependencies).operation, 'release-usb');
});

test('result semantics must match the pending operation before single-use consumption', async () => {
  const { createBridgeLaunch, consumeBridgeCallback, validateOperationResult } = await import('./bridgeProtocol.js');
  assert.equal(validateOperationResult('install-current-release', { status: 'awaiting-card-acknowledgement', verification: 'flash-verified', code: 'flash-verified' }), true);
  assert.equal(validateOperationResult('install-current-release', { status: 'awaiting-card-acknowledgement', verification: 'not-verified', code: 'operation-complete' }), false);
  assert.equal(validateOperationResult('restart-card', { status: 'awaiting-card-acknowledgement', verification: 'flash-verified', code: 'flash-verified' }), false);
  assert.equal(validateOperationResult('restart-card', { status: 'awaiting-card-acknowledgement', verification: 'not-verified', code: 'operation-complete' }), true);
  const localStorage = memoryStorage();
  let fill = 1;
  const crypto = { getRandomValues(bytes) { bytes.fill(fill++); return bytes; } };
  const launch = createBridgeLaunch('restart-card', { crypto, sessionStorage: memoryStorage(), localStorage, now: () => 0 });
  const nonce = new URL(launch).searchParams.get('nonce');
  const wrong = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=flash-verified&cardId=lw-441bf681feb0&firmwareVersion=1.2.3&buildId=${'a'.repeat(40)}&target=lightweaver-controller-esp32s3&verification=flash-verified&physicalOutput=unconfirmed&nonce=${nonce}&version=1`;
  assert.throws(() => consumeBridgeCallback(wrong, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: memoryStorage(), localStorage, now: () => 1, history: { replaceState() {} } }), /operation|semantic/i);
  const correct = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${nonce}&version=1`;
  assert.equal(consumeBridgeCallback(correct, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: memoryStorage(), localStorage, now: () => 1, history: { replaceState() {} } }).operation, 'restart-card');
});
