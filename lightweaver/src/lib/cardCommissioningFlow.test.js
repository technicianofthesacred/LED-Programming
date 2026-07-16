import test from 'node:test';
import assert from 'node:assert/strict';
import { getCardWiringStatus, normalizeCardWiringStatus } from './cardWiringSafety.js';

import {
  CARD_COMMISSIONING_STAGES,
  CARD_COMMISSIONING_STORAGE_KEY,
  adaptCardRestorationReadback,
  acknowledgeCommissionedCard,
  beginCardCommissioning,
  beginCardRestorationMutation,
  bindCardWiringActivationEvidence,
  cardIdFromEspMac,
  completeCardInstall,
  markCardProjectRestored,
  stageCardProjectForPhysicalCheck,
  readCardCommissioning,
  resumeInstalledCardAfterInterruption,
  writeCardCommissioning,
  claimCardRestoration,
  inspectCardCommissioning,
  verifyCardRestorationMutation,
} from './cardCommissioningFlow.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

const projectRecord = {
  id: 'project-record-7',
  updatedAt: 1770000000000,
  project: {
    version: 3,
    id: 'lotus-gate',
    name: 'Lotus Gate',
    layout: {
      strips: [{ id: 'outer', pixelCount: 88 }],
      wiring: { outputs: [{ id: 'out-a', gpio: 16 }] },
      patchBoard: { chains: [{ id: 'outer' }] },
    },
    devices: {
      standaloneController: {
        outputs: [{ id: 'out-a', pin: 16, pixels: 88 }],
        playlist: [{ id: 'aurora', type: 'pattern', patternId: 'aurora' }],
        controls: { encoder: { pinA: 4, pinB: 5 } },
      },
    },
  },
};

const installed = {
  operation: 'install-current-release',
  cardId: 'lw-aabbccddeeff',
  firmwareVersion: '1.2.3',
  buildId: 'a'.repeat(40),
};

function acceptedBridgeResult(flow, overrides = {}) {
  return {
    ...installed,
    flowId: flow.flowId,
    projectFingerprint: flow.project.fingerprint,
    expectedCardId: installed.cardId,
    acceptedResultId: `receipt-${flow.flowId}`.slice(0, 96),
    ...overrides,
  };
}

test('uses one exact four-stage commissioning vocabulary', () => {
  assert.deepEqual(CARD_COMMISSIONING_STAGES, [
    'connect-card',
    'install-safely',
    'set-up-card',
    'check-lights',
  ]);
  assert.equal(Object.isFrozen(CARD_COMMISSIONING_STAGES), true);
});

test('derives the same stable card identity from the ESP eFuse MAC', () => {
  assert.equal(cardIdFromEspMac('AA:BB:CC:DD:EE:FF'), 'lw-aabbccddeeff');
  assert.equal(cardIdFromEspMac('not-a-mac'), '');
});

test('captures an immutable acknowledged project revision before installation', () => {
  const mutableRecord = JSON.parse(JSON.stringify(projectRecord));
  const flow = beginCardCommissioning({
    source: 'web-serial',
    operation: 'install-current-release',
    strategy: 'clean-recovery',
    projectRecord: mutableRecord,
    projectRevision: 7,
    flowId: 'flow-1234567890abcdef',
    now: 1770000000100,
  });

  mutableRecord.project.layout.strips[0].pixelCount = 999;
  assert.equal(flow.stage, 'install-safely');
  assert.equal(flow.project.revision, 7);
  assert.equal(flow.project.recordId, 'project-record-7');
  assert.equal(flow.project.snapshot.layout.strips[0].pixelCount, 88);
  assert.match(flow.project.fingerprint, /^[a-f0-9]{16}$/);
  assert.equal(flow.project.restoredAt, null);
});

test('does not call browser persistence card restoration', () => {
  const flow = beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation,
    strategy: 'clean-recovery', projectRecord, projectRevision: 7,
    flowId: 'flow-1234567890abcdef', now: 1,
  });
  assert.equal(flow.project.savedInBrowser, true);
  assert.equal(flow.project.restoredAt, null);
  assert.equal(flow.stage, 'install-safely');
});

test('a production digest always requires an explicit matching production flow type', () => {
  assert.throws(() => beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-digest-123456789', now: 1, productionJobDigest: 'b'.repeat(64), flowType: 'studio-project' }), /production.*type|digest/i);
  assert.throws(() => beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-digest-223456789', now: 1, flowType: 'production-job' }), /production.*digest/i);
});

test('direct Web Serial and Bridge results converge on setup with the same exact expectations', () => {
  for (const source of ['web-serial', 'native-bridge']) {
    const initial = beginCardCommissioning({
      source, operation: installed.operation, strategy: 'clean-recovery',
      projectRecord, projectRevision: 7, flowId: `flow-${source}-1234567890`, now: 10,
    });
    const result = source === 'native-bridge' ? acceptedBridgeResult(initial) : installed;
    const next = completeCardInstall(initial, result, { now: 20 });
    assert.equal(next.stage, 'set-up-card');
    assert.deepEqual(next.expectedCard, {
      id: installed.cardId,
      firmwareVersion: installed.firmwareVersion,
      buildId: installed.buildId,
    });
    assert.equal(next.networkState, 'setup-required');
  }
});

test('a result from another operation cannot replace the active commissioning flow', () => {
  const flow = beginCardCommissioning({
    source: 'native-bridge', operation: 'recover-current-release', strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
  });
  assert.throws(() => completeCardInstall(flow, installed), /does not match/i);
});

test('a same-operation result from another tab and job fingerprint cannot advance this flow', () => {
  const flowA = beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-tab-a-1234567890', now: 10,
  });
  const otherJob = JSON.parse(JSON.stringify(projectRecord));
  otherJob.id = 'project-record-8';
  otherJob.project.id = 'other-job';
  otherJob.project.layout.strips[0].pixelCount = 89;
  const flowB = beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord: otherJob, projectRevision: 8, flowId: 'flow-tab-b-1234567890', now: 11,
  });

  const resultFromTabA = {
    ...installed,
    flowId: flowA.flowId,
    projectFingerprint: flowA.project.fingerprint,
    expectedCardId: installed.cardId,
    acceptedResultId: 'receipt-tab-a-1234567890abcdef',
  };

  assert.throws(() => completeCardInstall(flowB, resultFromTabA), /flow|fingerprint/i);
  const advancedA = completeCardInstall(flowA, resultFromTabA);
  assert.equal(advancedA.stage, 'set-up-card');
  assert.equal(advancedA.acceptedResultId, resultFromTabA.acceptedResultId);
});

test('an interrupted direct install resumes from exact card evidence without flashing again', () => {
  const interrupted = beginCardCommissioning({
    source: 'web-serial', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
    installTarget: { id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId },
  });
  assert.equal(resumeInstalledCardAfterInterruption(interrupted, {
    id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: 'b'.repeat(40),
  }).ok, false);
  const resumed = resumeInstalledCardAfterInterruption(interrupted, {
    id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId,
  }, { now: 30 });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.flow.stage, 'set-up-card');
  assert.equal(resumed.flow.expectedCard.id, installed.cardId);
});

test('rejects a wrong card, firmware version, or build before project restoration', () => {
  const initial = beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
  });
  const ready = completeCardInstall(initial, acceptedBridgeResult(initial), { now: 20 });

  const wrongCard = acknowledgeCommissionedCard(ready, {
    id: 'lw-ffffffffffff', firmwareVersion: installed.firmwareVersion, buildId: installed.buildId,
  });
  assert.deepEqual(wrongCard, { ok: false, reason: 'wrong-card' });

  const wrongVersion = acknowledgeCommissionedCard(ready, {
    id: installed.cardId, firmwareVersion: '1.2.2', buildId: installed.buildId,
  });
  assert.deepEqual(wrongVersion, { ok: false, reason: 'wrong-firmware-version' });

  const wrongBuild = acknowledgeCommissionedCard(ready, {
    id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: 'b'.repeat(40),
  });
  assert.deepEqual(wrongBuild, { ok: false, reason: 'wrong-firmware-build' });
});

test('a POST success or echoed expected values cannot mark a project restored', () => {
  const ready = completeCardInstall(beginCardCommissioning({
    source: 'web-serial', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
    productionJobDigest: 'b'.repeat(64),
  }), installed, { now: 20 });
  const acknowledgement = acknowledgeCommissionedCard(ready, {
    id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId,
  }, { now: 30 });

  assert.throws(() => markCardProjectRestored(acknowledgement.flow, { ok: true }), /independent|read-back/i);
  assert.throws(() => markCardProjectRestored(acknowledgement.flow, {
    source: 'post-response',
    cardId: installed.cardId,
    firmwareVersion: installed.firmwareVersion,
    buildId: installed.buildId,
    projectRevision: acknowledgement.flow.project.revision,
    projectFingerprint: acknowledgement.flow.project.fingerprint,
    productionJobDigest: acknowledgement.flow.project.productionJobDigest,
  }), /independent|read-back/i);
});

test('only exact independent card read-back unlocks canonical project restoration', () => {
  const ready = completeCardInstall(beginCardCommissioning({
    source: 'web-serial', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
    productionJobDigest: 'b'.repeat(64),
  }), installed, { now: 20 });
  const acknowledged = acknowledgeCommissionedCard(ready, {
    id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId,
  }, { now: 30 }).flow;

  const evidence = adaptCardRestorationReadback({
    method: 'GET',
    endpoint: '/api/firmware-info',
    response: {
      cardId: installed.cardId,
      firmwareVersion: installed.firmwareVersion,
      buildId: installed.buildId,
      projectRevision: acknowledged.project.revision,
      projectFingerprint: acknowledged.project.fingerprint,
      productionJobDigest: acknowledged.project.productionJobDigest,
    },
  });
  const restored = markCardProjectRestored(acknowledged, evidence, { now: 40 });
  assert.equal(restored.stage, 'check-lights');
  assert.equal(restored.project.restoredAt, 40);
  assert.equal(restored.project.restoredFingerprint, restored.project.fingerprint);
});

test('canonical and staged production restoration reject the wrong job digest', async () => {
  const initial = beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-prod-digest-12345', now: 10, productionJobDigest: 'b'.repeat(64), flowType: 'production-job' });
  const ready = completeCardInstall(initial, installed, { now: 20 });
  const acknowledged = acknowledgeCommissionedCard(ready, { id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId }, { now: 30 }).flow;
  const wrongFirmwareEvidence = adaptCardRestorationReadback({ method: 'GET', endpoint: '/api/firmware-info', response: { cardId: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId, projectRevision: 7, projectFingerprint: acknowledged.project.fingerprint, productionJobDigest: 'c'.repeat(64) } });
  assert.throws(() => markCardProjectRestored(acknowledged, wrongFirmwareEvidence), /job digest/i);
  const status = normalizeCardWiringStatus({ ok: true, state: 'staged', activationId: 'candidate-prod-7', outputs: [] });
  const candidate = await getCardWiringStatus({ transport: 'bridge', bridgeRequestImpl: async () => ({ ok: true, state: 'staged', activationId: 'candidate-prod-7', outputs: [], cardId: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId, projectRevision: 7, projectFingerprint: acknowledged.project.fingerprint, productionJobDigest: 'c'.repeat(64) }) });
  const stagedEvidence = bindCardWiringActivationEvidence(status, candidate);
  assert.throws(() => stageCardProjectForPhysicalCheck(acknowledged, stagedEvidence), /job digest/i);
});

test('a safety-staged GPIO restore stays in the same flow and is not falsely called restored', async () => {
  const initial = beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
  });
  const ready = completeCardInstall(initial, acceptedBridgeResult(initial), { now: 20 });
  const acknowledged = acknowledgeCommissionedCard(ready, {
    id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId,
  }, { now: 30 }).flow;
  const status = normalizeCardWiringStatus({
    ok: true,
    state: 'staged',
    activationId: 'wiring-activation-7',
    outputs: [{ pin: 18, pixels: 88 }],
  });
  const candidateResponse = {
      ok: true, state: 'staged', activationId: status.activationId, outputs: status.outputs,
      cardId: installed.cardId,
      firmwareVersion: installed.firmwareVersion,
      buildId: installed.buildId,
      projectRevision: acknowledged.project.revision,
      projectFingerprint: acknowledged.project.fingerprint,
      productionJobDigest: '',
  };
  const readback = await getCardWiringStatus({ transport: 'bridge', bridgeRequestImpl: async () => candidateResponse });
  const staleReadback = await getCardWiringStatus({ transport: 'bridge', bridgeRequestImpl: async () => ({ ...candidateResponse, buildId: 'b'.repeat(40), projectRevision: acknowledged.project.revision - 1 }) });
  const staleEvidence = bindCardWiringActivationEvidence(status, staleReadback);
  assert.throws(() => stageCardProjectForPhysicalCheck(acknowledged, staleEvidence), /firmware build|project revision/i);
  const evidence = bindCardWiringActivationEvidence(status, readback);
  const staged = stageCardProjectForPhysicalCheck(acknowledged, evidence, { now: 40 });
  assert.equal(staged.stage, 'check-lights');
  assert.equal(staged.project.restoredAt, null);
  assert.equal(staged.project.pendingActivationId, 'wiring-activation-7');
});

test('preserve-in-place is allowed only for a verified compatible routine update', () => {
  const rejected = beginCardCommissioning({
    source: 'web-serial', operation: 'recover-current-release', strategy: 'preserve-in-place',
    compatibilityVerified: true, projectRecord, projectRevision: 7,
    flowId: 'flow-1234567890abcdef', now: 1,
  });
  assert.equal(rejected.strategy, 'clean-recovery');

  const accepted = beginCardCommissioning({
    source: 'web-serial', operation: 'install-current-release', strategy: 'preserve-in-place',
    compatibilityVerified: true, routineUpdate: true, projectRecord, projectRevision: 7,
    flowId: 'flow-fedcba0987654321', now: 1,
  });
  assert.equal(accepted.strategy, 'preserve-in-place');
  assert.equal(accepted.networkState, 'preserved');
});

test('progress survives refresh, new tabs, Wi-Fi switching, and recoverable disconnects without secrets', async () => {
  const storage = memoryStorage();
  const recordWithUnrelatedPrivateFields = JSON.parse(JSON.stringify(projectRecord));
  recordWithUnrelatedPrivateFields.project.credentials = { password: 'never-copy-this' };
  const started = beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord: recordWithUnrelatedPrivateFields, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
  });
  const initial = completeCardInstall(started, acceptedBridgeResult(started), { now: 20 });
  const resumable = { ...initial, lastConnectionIssue: 'card-page-closed' };
  assert.equal(await writeCardCommissioning(resumable, { storage, locks: null }), true);

  const raw = storage.getItem(CARD_COMMISSIONING_STORAGE_KEY);
  assert.doesNotMatch(raw, /password|credential|nonce|serialPath|firmwareUrl/i);
  assert.doesNotMatch(raw, /never-copy-this/i);
  assert.deepEqual(readCardCommissioning({ storage }), resumable);
});

test('corrupt or fingerprint-mismatched persisted state fails closed', () => {
  const storage = memoryStorage();
  storage.setItem(CARD_COMMISSIONING_STORAGE_KEY, '{bad json');
  assert.equal(readCardCommissioning({ storage }), null);

  const flow = beginCardCommissioning({
    source: 'web-serial', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
  });
  flow.project.snapshot.name = 'Tampered';
  storage.setItem(CARD_COMMISSIONING_STORAGE_KEY, JSON.stringify(flow));
  assert.equal(readCardCommissioning({ storage }), null);
});

test('two tabs keep exact active flows and share one durable restore lease', async () => {
  const storage = memoryStorage();
  const tabA = memoryStorage();
  const tabB = memoryStorage();
  const a = completeCardInstall(beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-tab-a-1234567890', now: 10 }), installed, { now: 20 });
  const b = completeCardInstall(beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-tab-b-1234567890', now: 11 }), installed, { now: 21 });
  const clockA = () => 30;
  const clockB = () => 31;
  await writeCardCommissioning(a, { storage, sessionStorage: tabA, tabId: 'tab-a', now: clockA, locks: null, delay: async () => {} });
  await writeCardCommissioning(b, { storage, sessionStorage: tabB, tabId: 'tab-b', now: clockB, locks: null, delay: async () => {} });
  assert.equal(readCardCommissioning({ storage, sessionStorage: tabA, now: 32 }).flowId, a.flowId);
  assert.equal(readCardCommissioning({ storage, sessionStorage: tabB, now: 32 }).flowId, b.flowId);
  assert.equal((await claimCardRestoration(a, { storage, sessionStorage: tabA, ownerId: 'restore-tab-a-1234', now: () => 40, locks: null, delay: async () => {} })).ok, true);
  assert.deepEqual(await claimCardRestoration(a, { storage, sessionStorage: tabB, ownerId: 'restore-tab-b-1234', now: () => 41, locks: null, delay: async () => {} }), { ok: false, reason: 'restore-in-progress' });
  assert.equal((await claimCardRestoration(a, { storage, sessionStorage: tabB, ownerId: 'restore-tab-b-1234', now: () => 200000, locks: null, delay: async () => {} })).ok, true);
});

test('restore claim makes one durable fenced transition before card mutation', async () => {
  const storage = memoryStorage();
  const sessionStorage = memoryStorage();
  const ready = acknowledgeCommissionedCard(completeCardInstall(beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-fence-1234567890', now: 10 }), installed, { now: 20 }), { id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId }, { now: 30 }).flow;
  await writeCardCommissioning(ready, { storage, sessionStorage, locks: null });
  const claim = await claimCardRestoration(ready, { storage, sessionStorage, ownerId: 'restore-fence-123456', locks: null });
  const mutation = await beginCardRestorationMutation(ready, claim.lease, { storage, locks: null });
  assert.equal(mutation.ok, true);
  assert.equal(verifyCardRestorationMutation(ready, claim.lease.id, mutation.fencingToken, { storage }), true);
  assert.deepEqual(await beginCardRestorationMutation(ready, claim.lease, { storage, locks: null }), { ok: false, reason: 'restore-claim-lost' });
  assert.equal(verifyCardRestorationMutation(ready, claim.lease.id, 'wrong-fence-123456', { storage }), false);
});

test('corrupt registry reports a stable recovery state', () => {
  const storage = memoryStorage();
  const sessionStorage = memoryStorage();
  sessionStorage.setItem('lw_card_commissioning_active_v2', 'flow-missing-123456789');
  storage.setItem(CARD_COMMISSIONING_STORAGE_KEY, '{bad json');
  assert.deepEqual(inspectCardCommissioning({ storage, sessionStorage }), { flow: null, error: 'corrupt' });
});

test('storage quota failure is explicit and does not silently advance the primary registry', async () => {
  const storage = memoryStorage();
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === CARD_COMMISSIONING_STORAGE_KEY) throw new Error('QuotaExceededError');
    setItem(key, value);
  };
  const flow = beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-quota-1234567890', now: 10 });
  await assert.rejects(writeCardCommissioning(flow, { storage, sessionStorage: memoryStorage(), now: () => 20, locks: null, delay: async () => {} }), /QuotaExceededError/);
  assert.equal(storage.getItem(CARD_COMMISSIONING_STORAGE_KEY), null);
});

test('fallback claim settles concurrent writes without losing either flow', async () => {
  const storage = memoryStorage();
  const a = beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-race-a-123456789', now: 10 });
  const b = beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-race-b-123456789', now: 11 });
  const delay = ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)));
  await Promise.all([
    writeCardCommissioning(a, { storage, sessionStorage: memoryStorage(), locks: null, delay }),
    writeCardCommissioning(b, { storage, sessionStorage: memoryStorage(), locks: null, delay }),
  ]);
  const registry = JSON.parse(storage.getItem(CARD_COMMISSIONING_STORAGE_KEY));
  assert.deepEqual(Object.keys(registry.flows).sort(), [a.flowId, b.flowId].sort());
  assert.equal(registry.revision, 2);
});

test('partial backup data is never authoritative and far-future leases are cleared', async () => {
  const storage = memoryStorage();
  const sessionStorage = memoryStorage();
  const a = beginCardCommissioning({ source: 'web-serial', operation: installed.operation, projectRecord, projectRevision: 7, flowId: 'flow-commit-a-12345678', now: 10 });
  await writeCardCommissioning(a, { storage, sessionStorage, locks: null });
  const authoritative = storage.getItem(CARD_COMMISSIONING_STORAGE_KEY);
  storage.setItem('lw_card_commissioning_registry_v2_backup', JSON.stringify({ version: 2, revision: 99, flows: { hostile: {} } }));
  assert.equal(readCardCommissioning({ storage, sessionStorage }).flowId, a.flowId);
  const registry = JSON.parse(authoritative);
  const entry = registry.flows[a.flowId];
  entry.restoreLease = { id: 'restore-future-1234', state: 'claimed', flowId: a.flowId, cardId: '', projectFingerprint: a.project.fingerprint, expiresAt: Date.now() + 99_999_999 };
  storage.setItem(CARD_COMMISSIONING_STORAGE_KEY, JSON.stringify(registry));
  assert.equal(inspectCardCommissioning({ storage, sessionStorage }).error, 'invalid-lease');
  storage.setItem('lw_card_commissioning_registry_v2_lock', JSON.stringify({ owner: 'lock-future-123456', expiresAt: Date.now() + 99_999_999 }));
  await writeCardCommissioning(a, { storage, sessionStorage, locks: null, delay: async () => {} });
  assert.equal(inspectCardCommissioning({ storage, sessionStorage }).error, '');
});
