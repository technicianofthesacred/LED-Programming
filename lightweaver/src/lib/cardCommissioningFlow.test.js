import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_COMMISSIONING_STAGES,
  CARD_COMMISSIONING_STORAGE_KEY,
  acknowledgeCommissionedCard,
  beginCardCommissioning,
  cardIdFromEspMac,
  completeCardInstall,
  markCardProjectRestored,
  stageCardProjectForPhysicalCheck,
  readCardCommissioning,
  resumeInstalledCardAfterInterruption,
  writeCardCommissioning,
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

test('direct Web Serial and Bridge results converge on setup with the same exact expectations', () => {
  for (const source of ['web-serial', 'native-bridge']) {
    const initial = beginCardCommissioning({
      source, operation: installed.operation, strategy: 'clean-recovery',
      projectRecord, projectRevision: 7, flowId: `flow-${source}-1234567890`, now: 10,
    });
    const next = completeCardInstall(initial, installed, { now: 20 });
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
  const ready = completeCardInstall(beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
  }), installed, { now: 20 });

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

test('only an exact card acknowledgement unlocks canonical project restoration', () => {
  const ready = completeCardInstall(beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
  }), installed, { now: 20 });

  const acknowledgement = acknowledgeCommissionedCard(ready, {
    id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId,
  }, { now: 30 });
  assert.equal(acknowledgement.ok, true);
  assert.equal(acknowledgement.flow.cardAcknowledgedAt, 30);

  const restored = markCardProjectRestored(acknowledgement.flow, {
    cardId: installed.cardId,
    projectFingerprint: acknowledgement.flow.project.fingerprint,
  }, { now: 40 });
  assert.equal(restored.stage, 'check-lights');
  assert.equal(restored.project.restoredAt, 40);
  assert.equal(restored.project.restoredFingerprint, restored.project.fingerprint);
});

test('a safety-staged GPIO restore stays in the same flow and is not falsely called restored', () => {
  const ready = completeCardInstall(beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
  }), installed, { now: 20 });
  const acknowledged = acknowledgeCommissionedCard(ready, {
    id: installed.cardId, firmwareVersion: installed.firmwareVersion, buildId: installed.buildId,
  }, { now: 30 }).flow;
  const staged = stageCardProjectForPhysicalCheck(acknowledged, {
    cardId: installed.cardId,
    projectFingerprint: acknowledged.project.fingerprint,
    activationId: 'wiring-activation-7',
  }, { now: 40 });
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

test('progress survives refresh, new tabs, Wi-Fi switching, and recoverable disconnects without secrets', () => {
  const storage = memoryStorage();
  const recordWithUnrelatedPrivateFields = JSON.parse(JSON.stringify(projectRecord));
  recordWithUnrelatedPrivateFields.project.credentials = { password: 'never-copy-this' };
  const initial = completeCardInstall(beginCardCommissioning({
    source: 'native-bridge', operation: installed.operation, strategy: 'clean-recovery',
    projectRecord: recordWithUnrelatedPrivateFields, projectRevision: 7, flowId: 'flow-1234567890abcdef', now: 10,
  }), installed, { now: 20 });
  const resumable = { ...initial, lastConnectionIssue: 'card-page-closed' };
  assert.equal(writeCardCommissioning(resumable, { storage }), true);

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
