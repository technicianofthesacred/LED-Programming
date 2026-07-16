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

function memoryLocks() {
  const tails = new Map();
  return {
    request(name, _options, callback) {
      const prior = tails.get(name) ?? Promise.resolve();
      const result = prior.catch(() => {}).then(callback);
      const tail = result.then(() => {}, () => {});
      tails.set(name, tail);
      tail.finally(() => { if (tails.get(name) === tail) tails.delete(name); });
      return result;
    },
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

test('two tabs keep same-operation commissioning results bound to their own flow and job without deep-link project data', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  const sessionA = memoryStorage();
  const sessionB = memoryStorage();
  let fill = 1;
  const crypto = { getRandomValues(bytes) { bytes.fill(fill++); return bytes; } };
  const correlationA = {
    flowId: 'flow-tab-a-1234567890',
    projectFingerprint: 'a'.repeat(16),
    expectedCardId: '',
  };
  const correlationB = {
    flowId: 'flow-tab-b-1234567890',
    projectFingerprint: 'b'.repeat(16),
    expectedCardId: '',
  };
  const launchA = createBridgeLaunch('install-current-release', {
    crypto, sessionStorage: sessionA, localStorage, now: () => 10, correlation: correlationA,
  });
  const launchB = createBridgeLaunch('install-current-release', {
    crypto, sessionStorage: sessionB, localStorage, now: () => 11, correlation: correlationB,
  });
  for (const launch of [launchA, launchB]) {
    assert.deepEqual([...new URL(launch).searchParams.keys()], ['operation', 'nonce', 'version']);
  }
  const callbackFor = (launch, cardId, receiptByte) => {
    const nonce = new URL(launch).searchParams.get('nonce');
    const receipt = Buffer.alloc(32, receiptByte).toString('base64url');
    return `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=flash-verified&cardId=${cardId}&firmwareVersion=1.2.3&buildId=${'a'.repeat(40)}&target=lightweaver-controller-esp32s3&verification=flash-verified&physicalOutput=unconfirmed&nonce=${nonce}&receipt=${receipt}&version=1`;
  };
  const resultA = await consumeBridgeCallback(callbackFor(launchA, 'lw-111111111111', 7), {
    currentOrigin: 'https://led.mandalacodes.com', localStorage, now: () => 20, history: { replaceState() {} },
  });
  const resultB = await consumeBridgeCallback(callbackFor(launchB, 'lw-222222222222', 8), {
    currentOrigin: 'https://led.mandalacodes.com', localStorage, now: () => 21, history: { replaceState() {} },
  });
  assert.deepEqual({
    flowId: resultA.flowId,
    projectFingerprint: resultA.projectFingerprint,
    expectedCardId: resultA.expectedCardId,
  }, { ...correlationA, expectedCardId: 'lw-111111111111' });
  assert.deepEqual({
    flowId: resultB.flowId,
    projectFingerprint: resultB.projectFingerprint,
    expectedCardId: resultB.expectedCardId,
  }, { ...correlationB, expectedCardId: 'lw-222222222222' });
  assert.notEqual(resultA.acceptedResultId, resultB.acceptedResultId);
});

test('Studio callback consumes matching pending state once and clears callback history', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const storage = memoryStorage();
  createBridgeLaunch('inspect-compatible-card', { crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } }, storage, now: () => 5_000 });
  const callback = `https://led.mandalacodes.com/#bridge-result?status=recoverable-failure&code=no-compatible-card&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${NONCE}&version=1`;
  const replaced = [];
  const result = await consumeBridgeCallback(callback, {
    currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 6_000,
    history: { replaceState: (...args) => replaced.push(args) },
  });
  assert.equal(result.operation, 'inspect-compatible-card');
  assert.equal(result.status, 'recoverable-failure');
  assert.deepEqual(replaced, [[null, '', '/']]);
  await assert.rejects(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 6_000 }), /pending|used/i);
});

test('Studio rejects wrong origin, nonce, expiry, malformed results, and physical-success claims', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=flash-verified&cardId=lw-441bf681feb0&firmwareVersion=1.2.3&buildId=${'a'.repeat(40)}&target=lightweaver-controller-esp32s3&verification=flash-verified&physicalOutput=unconfirmed&nonce=${NONCE}&version=1`;
  const setup = () => { const storage = memoryStorage(); createBridgeLaunch('install-current-release', { crypto: { getRandomValues(b) { b.fill(1); return b; } }, storage, now: () => 0 }); return storage; };
  await assert.rejects(() => consumeBridgeCallback(callback, { currentOrigin: 'https://preview.example', storage: setup(), now: () => 1 }));
  await assert.rejects(() => consumeBridgeCallback(callback.replace(NONCE, 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 1 }), /nonce/i);
  await assert.rejects(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 300_001 }), /expired/i);
  await assert.rejects(() => consumeBridgeCallback(callback.replace('physicalOutput=unconfirmed', 'physicalOutput=verified'), { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 1 }));
  await assert.rejects(() => consumeBridgeCallback(callback.replace('awaiting-card-acknowledgement', 'complete'), { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 1 }));
  await assert.rejects(() => consumeBridgeCallback(`${callback}&extra=1`, { currentOrigin: 'https://led.mandalacodes.com', storage: setup(), now: () => 1 }));
});

test('Studio always clears callback fields but preserves pending state for wrong nonce or malformed results', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const storage = memoryStorage();
  const crypto = { getRandomValues(bytes) { bytes.fill(1); return bytes; } };
  createBridgeLaunch('restart-card', { crypto, storage, now: () => 0 });
  const valid = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&cardId=lw-441bf681feb0&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${NONCE}&version=1`;
  const historyCalls = [];
  const deps = { currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 1, history: { replaceState: (...args) => historyCalls.push(args) } };
  await assert.rejects(() => consumeBridgeCallback(valid.replace(NONCE, 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'), deps), /nonce/i);
  await assert.rejects(() => consumeBridgeCallback(`${valid}&extra=1`, deps));
  assert.equal(historyCalls.length, 2);
  assert.equal((await consumeBridgeCallback(valid, deps)).operation, 'restart-card');
  assert.equal(historyCalls.length, 3);
});

test('Studio clears history for absent and expired pending state and rejects alternate nonce lengths', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=recoverable-failure&code=no-compatible-card&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${NONCE}&version=1`;
  const historyCalls = [];
  const history = { replaceState: (...args) => historyCalls.push(args) };
  await assert.rejects(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', storage: memoryStorage(), now: () => 0, history }), /pending/i);
  const storage = memoryStorage();
  createBridgeLaunch('release-usb', { crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } }, storage, now: () => 0 });
  await assert.rejects(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 300_000, history }), /expired/i);
  assert.equal(historyCalls.length, 2);
  for (const bytes of [16, 64]) {
    await assert.rejects(() => consumeBridgeCallback(callback.replace(NONCE, Buffer.alloc(bytes).toString('base64url')), {
      currentOrigin: 'https://led.mandalacodes.com', storage: memoryStorage(), now: () => 0, history,
    }));
  }
  await assert.rejects(() => consumeBridgeCallback(callback.replace(NONCE, `${NONCE.slice(0, -1)}B`), {
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
  const result = await consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: callbackSession, localStorage, now: () => 20, history: { replaceState() {} } });
  assert.equal(result.operation, 'restart-card');
  await assert.rejects(() => consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: callbackSession, localStorage, now: () => 20, history: { replaceState() {} } }), /pending|used/i);
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
  await assert.rejects(() => consumeBridgeCallback(`${callback(secondNonce)}&extra=1`, dependencies));
  await assert.rejects(() => consumeBridgeCallback(callback(firstNonce), dependencies), /expired/i);
  await assert.rejects(() => consumeBridgeCallback(callback(Buffer.alloc(32, 9).toString('base64url')), dependencies), /nonce/i);
  assert.equal((await consumeBridgeCallback(callback(secondNonce), dependencies)).operation, 'release-usb');
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
  await assert.rejects(() => consumeBridgeCallback(wrong, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: memoryStorage(), localStorage, now: () => 1, history: { replaceState() {} } }), /operation|semantic/i);
  const correct = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${nonce}&version=1`;
  assert.equal((await consumeBridgeCallback(correct, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: memoryStorage(), localStorage, now: () => 1, history: { replaceState() {} } })).operation, 'restart-card');
});

test('two callback tabs racing under the same-origin lock accept exactly once', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  const locks = memoryLocks();
  const launch = createBridgeLaunch('release-usb', {
    crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } },
    sessionStorage: memoryStorage(), localStorage, now: () => 0,
  });
  const nonce = new URL(launch).searchParams.get('nonce');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${nonce}&version=1`;
  const dependencies = { currentOrigin: 'https://led.mandalacodes.com', localStorage, locks, now: () => 1, history: { replaceState() {} } };
  const settled = await Promise.allSettled([
    consumeBridgeCallback(callback, { ...dependencies, sessionStorage: memoryStorage() }),
    consumeBridgeCallback(callback, { ...dependencies, sessionStorage: memoryStorage() }),
  ]);
  assert.deepEqual(settled.map(item => item.status).sort(), ['fulfilled', 'rejected']);
});

test('fallback callback lease recovers stale claims and still accepts only one concurrent consumer', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  let fill = 1;
  const crypto = { getRandomValues(bytes) { bytes.fill(fill++); return bytes; } };
  const launch = createBridgeLaunch('restart-card', { crypto, sessionStorage: memoryStorage(), localStorage, now: () => 0 });
  const nonce = new URL(launch).searchParams.get('nonce');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${nonce}&version=1`;
  const claimKey = `lightweaver.bridge.callback-claim.v1.${nonce}`;
  localStorage.setItem(claimKey, JSON.stringify({ owner: Buffer.alloc(16, 9).toString('base64url'), createdAt: 0, expiresAt: 2_000 }));
  const dependencies = {
    currentOrigin: 'https://led.mandalacodes.com', localStorage, locks: null, crypto,
    now: () => 3_000, delay: () => Promise.resolve(), history: { replaceState() {} },
  };
  const settled = await Promise.allSettled([consumeBridgeCallback(callback, dependencies), consumeBridgeCallback(callback, dependencies)]);
  assert.deepEqual(settled.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(localStorage.getItem(claimKey), null);
});

test('fallback callback claim namespace prunes stale entries and rejects a bounded active cap', async () => {
  const { createBridgeLaunch, consumeBridgeCallback } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  let fill = 1;
  const crypto = { getRandomValues(bytes) { bytes.fill(fill++); return bytes; } };
  const launch = createBridgeLaunch('restart-card', { crypto, sessionStorage: memoryStorage(), localStorage, now: () => 0 });
  const nonce = new URL(launch).searchParams.get('nonce');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${nonce}&version=1`;
  const prefix = 'lightweaver.bridge.callback-claim.v1.';
  for (let index = 0; index < 16; index += 1) {
    localStorage.setItem(`${prefix}${Buffer.alloc(32, index + 20).toString('base64url')}`, JSON.stringify({
      owner: Buffer.alloc(16, index + 20).toString('base64url'), createdAt: 0, expiresAt: 2_000,
    }));
  }
  const dependencies = {
    currentOrigin: 'https://led.mandalacodes.com', localStorage, locks: null, crypto,
    now: () => 1_000, delay: () => Promise.resolve(), history: { replaceState() {} },
  };
  await assert.rejects(() => consumeBridgeCallback(callback, dependencies), /claim|pending|busy|many/i);
  assert.equal([...Array(localStorage.length).keys()].map(index => localStorage.key(index)).filter(key => key.startsWith(prefix)).length, 16);
  for (let index = 0; index < 16; index += 1) {
    localStorage.setItem(`${prefix}${Buffer.alloc(32, index + 60).toString('base64url')}`, JSON.stringify({
      owner: Buffer.alloc(16, index + 60).toString('base64url'), createdAt: 0, expiresAt: 2_000,
    }));
  }
  dependencies.now = () => 3_000;
  assert.equal((await consumeBridgeCallback(callback, dependencies)).operation, 'restart-card');
  assert.equal([...Array(localStorage.length).keys()].map(index => localStorage.key(index)).filter(key => key.startsWith(prefix)).length, 0);
});

test('Safari launch with Chrome default, a separate profile, and refresh resume only through the originating profile once', async () => {
  const { claimBridgeResultReceipt, confirmBridgeResultReceipt, consumeBridgeReturnCode, createBridgeLaunch } = await import('./bridgeProtocol.js');
  const originalLocal = memoryStorage();
  const originalSession = memoryStorage();
  const otherProfile = memoryStorage();
  const launch = createBridgeLaunch('restart-card', {
    crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } },
    sessionStorage: originalSession, localStorage: originalLocal, now: () => 0,
  });
  const nonce = new URL(launch).searchParams.get('nonce');
  const receipt = Buffer.alloc(32, 4).toString('base64url');
  const payload = new URLSearchParams([
    ['status', 'awaiting-card-acknowledgement'], ['code', 'operation-complete'],
    ['target', 'lightweaver-controller-esp32s3'], ['verification', 'not-verified'],
    ['physicalOutput', 'unconfirmed'], ['nonce', nonce], ['receipt', receipt], ['version', '1'],
  ]).toString();
  const code = `LW1-${Buffer.from(payload).toString('base64url')}`;
  await assert.rejects(() => consumeBridgeReturnCode(code, { currentOrigin: 'https://led.mandalacodes.com', localStorage: otherProfile, now: () => 1 }), /pending|profile|operation/i);
  const result = await consumeBridgeReturnCode(code, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: originalSession, localStorage: originalLocal, now: () => 1 });
  assert.equal(result.operation, 'restart-card');
  assert.equal(result.ackReceipt, receipt);
  const ownerToken = Buffer.alloc(16, 5).toString('base64url');
  const confirmation = { localStorage: originalLocal, operation: result.operation, targetTabId: result.originTabId, ownerToken, now: () => 2 };
  assert.equal(claimBridgeResultReceipt(receipt, confirmation), true);
  assert.equal(confirmBridgeResultReceipt(receipt, confirmation), true);
  await assert.rejects(() => consumeBridgeReturnCode(code, { currentOrigin: 'https://led.mandalacodes.com', sessionStorage: originalSession, localStorage: originalLocal, now: () => 1 }), /pending|used/i);
});

test('automatic callback keeps Studio correlation until the actual target tab confirms receipt', async () => {
  const { claimBridgeResultReceipt, confirmBridgeResultReceipt, consumeBridgeCallback, createBridgeLaunch } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  const originSession = memoryStorage();
  const launch = createBridgeLaunch('restart-card', {
    crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } }, sessionStorage: originSession, localStorage, now: () => 0,
  });
  const nonce = new URL(launch).searchParams.get('nonce');
  const receipt = Buffer.alloc(32, 4).toString('base64url');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${nonce}&receipt=${receipt}&version=1`;
  const result = await consumeBridgeCallback(callback, {
    currentOrigin: 'https://led.mandalacodes.com', sessionStorage: memoryStorage(), localStorage, now: () => 1,
  });
  assert.equal(result.originTabId, originSession.getItem('lightweaver.bridge.origin-tab.v1'));
  assert.equal(result.ackReceipt, receipt);
  const ownerToken = Buffer.alloc(16, 6).toString('base64url');
  const confirmation = { localStorage, operation: result.operation, targetTabId: result.originTabId, ownerToken, now: () => 2 };
  assert.equal(confirmBridgeResultReceipt(Buffer.alloc(32, 5).toString('base64url'), confirmation), false);
  assert.equal(claimBridgeResultReceipt(receipt, confirmation), true);
  assert.equal(confirmBridgeResultReceipt(receipt, { ...confirmation, ownerToken: Buffer.alloc(16, 7).toString('base64url') }), false);
  assert.equal(confirmBridgeResultReceipt(receipt, confirmation), true);
  assert.equal(confirmBridgeResultReceipt(receipt, confirmation), false);
});

test('receipt lease rejects another receiver owner until the bounded claim expires', async () => {
  const { claimBridgeResultReceipt, consumeBridgeCallback, createBridgeLaunch } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  const launch = createBridgeLaunch('restart-card', {
    crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } }, sessionStorage, localStorage, now: () => 0,
  });
  const nonce = new URL(launch).searchParams.get('nonce');
  const receipt = Buffer.alloc(32, 4).toString('base64url');
  const callback = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${nonce}&receipt=${receipt}&version=1`;
  const result = await consumeBridgeCallback(callback, { currentOrigin: 'https://led.mandalacodes.com', localStorage, now: () => 1 });
  const base = { localStorage, operation: result.operation, targetTabId: result.originTabId };
  assert.equal(claimBridgeResultReceipt(receipt, { ...base, ownerToken: Buffer.alloc(16, 5).toString('base64url'), now: () => 2 }), true);
  assert.equal(claimBridgeResultReceipt(receipt, { ...base, ownerToken: Buffer.alloc(16, 6).toString('base64url'), now: () => 3 }), false);
  assert.equal(claimBridgeResultReceipt(receipt, { ...base, ownerToken: Buffer.alloc(16, 6).toString('base64url'), now: () => 2_003 }), true);
});

test('a new same-profile tab atomically takes over manual delivery when the original Studio tab was closed', async () => {
  const { consumeBridgeReturnCode, createBridgeLaunch } = await import('./bridgeProtocol.js');
  const sharedProfile = memoryStorage();
  const closedTabSession = memoryStorage();
  const launch = createBridgeLaunch('inspect-compatible-card', {
    crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } },
    sessionStorage: closedTabSession, localStorage: sharedProfile, now: () => 0,
  });
  const nonce = new URL(launch).searchParams.get('nonce');
  const payload = new URLSearchParams([
    ['status', 'recoverable-failure'], ['code', 'no-compatible-card'], ['target', 'lightweaver-controller-esp32s3'],
    ['verification', 'not-verified'], ['physicalOutput', 'unconfirmed'], ['nonce', nonce],
    ['receipt', Buffer.alloc(32, 4).toString('base64url')], ['version', '1'],
  ]).toString();
  const replacementSession = memoryStorage();
  const result = await consumeBridgeReturnCode(`LW1-${Buffer.from(payload).toString('base64url')}`, {
    currentOrigin: 'https://led.mandalacodes.com', sessionStorage: replacementSession, localStorage: sharedProfile,
    crypto: { getRandomValues(bytes) { bytes.fill(9); return bytes; } }, now: () => 1,
  });
  assert.equal(result.operation, 'inspect-compatible-card');
  assert.equal(result.originTabId, replacementSession.getItem('lightweaver.bridge.origin-tab.v1'));
  assert.notEqual(result.originTabId, closedTabSession.getItem('lightweaver.bridge.origin-tab.v1'));
  assert.equal(result.ackReceipt, Buffer.alloc(32, 4).toString('base64url'));
});

test('manual takeover rejects unchanged when the replacement tab already owns another pending launch', async () => {
  const { claimBridgeResultReceipt, confirmBridgeResultReceipt, consumeBridgeCallback, consumeBridgeReturnCode, createBridgeLaunch } = await import('./bridgeProtocol.js');
  const sharedProfile = memoryStorage();
  const closedRestartSession = memoryStorage();
  const replacementReleaseSession = memoryStorage();
  let fill = 1;
  const crypto = { getRandomValues(bytes) { bytes.fill(fill++); return bytes; } };
  const restartLaunch = createBridgeLaunch('restart-card', {
    crypto, sessionStorage: closedRestartSession, localStorage: sharedProfile, now: () => 0,
  });
  const releaseLaunch = createBridgeLaunch('release-usb', {
    crypto, sessionStorage: replacementReleaseSession, localStorage: sharedProfile, now: () => 0,
  });
  const restartNonce = new URL(restartLaunch).searchParams.get('nonce');
  const releaseNonce = new URL(releaseLaunch).searchParams.get('nonce');
  const restartReceipt = Buffer.alloc(32, 7).toString('base64url');
  const restartPayload = new URLSearchParams([
    ['status', 'awaiting-card-acknowledgement'], ['code', 'operation-complete'],
    ['target', 'lightweaver-controller-esp32s3'], ['verification', 'not-verified'],
    ['physicalOutput', 'unconfirmed'], ['nonce', restartNonce], ['receipt', restartReceipt], ['version', '1'],
  ]).toString();
  const before = [...Array(sharedProfile.length).keys()]
    .map(index => [sharedProfile.key(index), sharedProfile.getItem(sharedProfile.key(index))])
    .sort(([left], [right]) => left.localeCompare(right));

  await assert.rejects(() => consumeBridgeReturnCode(`LW1-${Buffer.from(restartPayload).toString('base64url')}`, {
    currentOrigin: 'https://led.mandalacodes.com', sessionStorage: replacementReleaseSession,
    localStorage: sharedProfile, crypto, now: () => 1,
  }), /pending|takeover|tab/i);
  const after = [...Array(sharedProfile.length).keys()]
    .map(index => [sharedProfile.key(index), sharedProfile.getItem(sharedProfile.key(index))])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(after, before);

  const restartCallback = `https://led.mandalacodes.com/#bridge-result?${restartPayload}`;
  const restartResult = await consumeBridgeCallback(restartCallback, {
    currentOrigin: 'https://led.mandalacodes.com', localStorage: sharedProfile, now: () => 1,
  });
  assert.equal(restartResult.originTabId, closedRestartSession.getItem('lightweaver.bridge.origin-tab.v1'));
  const ownerToken = Buffer.alloc(16, 8).toString('base64url');
  const confirmation = { localStorage: sharedProfile, operation: restartResult.operation, targetTabId: restartResult.originTabId, ownerToken, now: () => 2 };
  assert.equal(claimBridgeResultReceipt(restartReceipt, confirmation), true);
  assert.equal(confirmBridgeResultReceipt(restartReceipt, confirmation), true);
  const releaseCallback = `https://led.mandalacodes.com/#bridge-result?status=awaiting-card-acknowledgement&code=operation-complete&target=lightweaver-controller-esp32s3&verification=not-verified&physicalOutput=unconfirmed&nonce=${releaseNonce}&version=1`;
  assert.equal((await consumeBridgeCallback(releaseCallback, {
    currentOrigin: 'https://led.mandalacodes.com', localStorage: sharedProfile, now: () => 1,
  })).operation, 'release-usb');
});

test('duplicate persisted receipts fail closed without clearing either pending authority', async () => {
  const { confirmBridgeResultReceipt, createBridgeLaunch } = await import('./bridgeProtocol.js');
  const localStorage = memoryStorage();
  let fill = 1;
  const crypto = { getRandomValues(bytes) { bytes.fill(fill++); return bytes; } };
  createBridgeLaunch('restart-card', { crypto, sessionStorage: memoryStorage(), localStorage, now: () => 0 });
  createBridgeLaunch('release-usb', { crypto, sessionStorage: memoryStorage(), localStorage, now: () => 0 });
  const receipt = Buffer.alloc(32, 9).toString('base64url');
  const keys = [...Array(localStorage.length).keys()].map(index => localStorage.key(index));
  for (const key of keys) localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), receipt }));
  const before = keys.map(key => [key, localStorage.getItem(key)]);

  assert.throws(() => confirmBridgeResultReceipt(receipt, { localStorage }), /registry|invalid|receipt/i);
  assert.deepEqual(keys.map(key => [key, localStorage.getItem(key)]), before);
});

test('replacement write validation rolls back the original pending authority on storage corruption', async () => {
  const { consumeBridgeReturnCode, createBridgeLaunch } = await import('./bridgeProtocol.js');
  const underlying = memoryStorage();
  const originalSession = memoryStorage();
  const launch = createBridgeLaunch('restart-card', {
    crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } },
    sessionStorage: originalSession, localStorage: underlying, now: () => 0,
  });
  const nonce = new URL(launch).searchParams.get('nonce');
  const key = `lightweaver.bridge.pending.v1.${nonce}`;
  const original = underlying.getItem(key);
  let corruptReplacement = true;
  const corruptingStorage = {
    get length() { return underlying.length; },
    key: index => underlying.key(index),
    getItem: itemKey => underlying.getItem(itemKey),
    removeItem: itemKey => underlying.removeItem(itemKey),
    setItem(itemKey, value) {
      const record = itemKey === key ? JSON.parse(value) : null;
      if (record?.receipt && corruptReplacement) {
        corruptReplacement = false;
        underlying.setItem(itemKey, JSON.stringify({ ...record, tabId: 'invalid' }));
      } else underlying.setItem(itemKey, value);
    },
  };
  const receipt = Buffer.alloc(32, 6).toString('base64url');
  const payload = new URLSearchParams([
    ['status', 'awaiting-card-acknowledgement'], ['code', 'operation-complete'],
    ['target', 'lightweaver-controller-esp32s3'], ['verification', 'not-verified'],
    ['physicalOutput', 'unconfirmed'], ['nonce', nonce], ['receipt', receipt], ['version', '1'],
  ]).toString();

  await assert.rejects(() => consumeBridgeReturnCode(`LW1-${Buffer.from(payload).toString('base64url')}`, {
    currentOrigin: 'https://led.mandalacodes.com', sessionStorage: memoryStorage(),
    localStorage: corruptingStorage, crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } }, now: () => 1,
  }), /registry|invalid/i);
  assert.equal(underlying.getItem(key), original);
});

test('manual return code expires with the original launch and cannot smuggle URL or project fields', async () => {
  const { consumeBridgeReturnCode, createBridgeLaunch } = await import('./bridgeProtocol.js');
  const storage = memoryStorage();
  const launch = createBridgeLaunch('release-usb', { crypto: { getRandomValues(bytes) { bytes.fill(1); return bytes; } }, storage, now: () => 0 });
  const nonce = new URL(launch).searchParams.get('nonce');
  const valid = new URLSearchParams([
    ['status', 'recoverable-failure'], ['code', 'release-failed'], ['target', 'lightweaver-controller-esp32s3'],
    ['verification', 'not-verified'], ['physicalOutput', 'unconfirmed'], ['nonce', nonce],
    ['receipt', Buffer.alloc(32, 4).toString('base64url')], ['version', '1'],
  ]).toString();
  await assert.rejects(() => consumeBridgeReturnCode(`LW1-${Buffer.from(valid).toString('base64url')}`, {
    currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 300_000,
  }), /expired/i);
  const smuggled = `${valid}&url=https%3A%2F%2Fevil.invalid&project=secret`;
  await assert.rejects(() => consumeBridgeReturnCode(`LW1-${Buffer.from(smuggled).toString('base64url')}`, {
    currentOrigin: 'https://led.mandalacodes.com', storage, now: () => 1,
  }));
});
