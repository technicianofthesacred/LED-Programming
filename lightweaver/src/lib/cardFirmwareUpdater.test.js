import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIRMWARE_UPDATE_CHUNK_BYTES,
  clearFirmwareUpdateSessionIfMatches,
  correlateFirmwareUpdateRecovery,
  correlateFirmwareUpdateReconnect,
  createCardFirmwareUpdater,
  readFirmwareUpdateSession,
  readFirmwareUpdateStatus,
  saveFirmwareUpdateSession,
} from './cardFirmwareUpdater.js';

const CARD_ID = 'lw-b0fe81f61b44';
const OLD_BOOT = 'boot-old';
const OLD_HEAD = 'a'.repeat(64);
const OLD_FINGERPRINT = 'b'.repeat(64);
const TARGET_BUILD = 'c'.repeat(40);
const TICKET_DIGEST = 'd'.repeat(64);

function release(byteLength = FIRMWARE_UPDATE_CHUNK_BYTES + 7) {
  return {
    manifest: { firmwareVersion: '1.2.0', buildId: TARGET_BUILD, buildNumber: 1300 },
    ticket: { image: { size: byteLength, sha256: 'e'.repeat(64) } },
    ticketBytes: new Uint8Array([1, 2, 3]),
    ticketSignature: new Uint8Array(64).fill(4),
    ticketSha256: TICKET_DIGEST,
    imageBytes: new Uint8Array(byteLength).fill(9),
  };
}

function authority(calls, responses = {}) {
  return {
    connected: true,
    cardId: CARD_ID,
    bootId: OLD_BOOT,
    ownerSessionId: 'owner-session',
    operationGeneration: 8,
    projectHead: OLD_HEAD,
    ownerCapability: 'owner-capability-secret',
    ownerCapabilityExpectedHead: OLD_HEAD,
    revoked: false,
    async request(path, init = {}) {
      calls.push({ path, init });
      const response = responses[path] || responses[path.split('?')[0]];
      return response?.shift?.() || response || { ok: true };
    },
    watch() { return () => {}; },
  };
}

test('Wi-Fi updater binds preflight and monotonic 32 KiB chunks to exact authority and release', async () => {
  const calls = [];
  const progress = [];
  const updater = createCardFirmwareUpdater({
    authority: authority(calls, {
      '/api/update/preflight': { ok: true, chunkSize: FIRMWARE_UPDATE_CHUNK_BYTES },
      '/api/update/begin': { ok: true, leaseId: 'update-1', receivedBytes: 0 },
      '/api/update/chunk': [{ ok: true, receivedBytes: FIRMWARE_UPDATE_CHUNK_BYTES }, { ok: true, receivedBytes: FIRMWARE_UPDATE_CHUNK_BYTES + 7 }],
    }),
    release: release(),
    physicalConfirmation: 'owner-confirmed-physical-control',
    onProgress: event => progress.push(event),
  });

  await updater.preflight();
  await updater.begin();
  await updater.send();

  assert.deepEqual(calls.map(call => call.path.split('?')[0]), [
    '/api/update/preflight', '/api/update/begin', '/api/update/chunk', '/api/update/chunk',
  ]);
  const preflight = calls[0].init.body;
  assert.deepEqual({
    cardId: preflight.cardId,
    bootId: preflight.bootId,
    ownerSessionId: preflight.ownerSessionId,
    operationGeneration: preflight.operationGeneration,
    expectedProjectHead: preflight.expectedProjectHead,
    releaseBuildId: preflight.releaseBuildId,
    ticketSha256: preflight.ticketSha256,
  }, {
    cardId: CARD_ID,
    bootId: OLD_BOOT,
    ownerSessionId: 'owner-session',
    operationGeneration: 8,
    expectedProjectHead: OLD_HEAD,
    releaseBuildId: TARGET_BUILD,
    ticketSha256: TICKET_DIGEST,
  });
  assert.equal(preflight.capability, 'owner-capability-secret');
  assert.equal(preflight.physicalConfirmationNonce, 'owner-confirmed-physical-control');
  assert.equal(Buffer.from(preflight.ticket, 'base64').byteLength, 3);
  assert.match(preflight.signature, /^[A-Za-z0-9_-]{86}$/);
  assert.deepEqual(calls.slice(2).map(call => ({
    sequence: call.init.body.sequence,
    offset: call.init.body.offset,
    bytes: Buffer.from(call.init.body.data, 'base64').byteLength,
  })), [
    { sequence: 1, offset: 0, bytes: FIRMWARE_UPDATE_CHUNK_BYTES },
    { sequence: 2, offset: FIRMWARE_UPDATE_CHUNK_BYTES, bytes: 7 },
  ]);
  assert.equal(progress.at(-1).acknowledgedBytes, FIRMWARE_UPDATE_CHUNK_BYTES + 7);
});

test('software grant is consumed once and only its update capability authorizes later mutations', async () => {
  const calls = [];
  const softwareAuthority = {
    ...authority(calls, {
      '/api/update/preflight': { ok: true, updateCapability: 'update-only-secret' },
      '/api/update/begin': { ok: true, leaseId: 'update-1', receivedBytes: 0 },
      '/api/update/chunk': { ok: true, receivedBytes: 8 },
      '/api/update/commit': { ok: true },
    }),
    ownerCapability: '',
    ownerCapabilityExpectedHead: null,
  };
  const updater = createCardFirmwareUpdater({
    authority: softwareAuthority,
    release: release(8),
    softwareGrant: { grantPayload: '{"exact":"card-challenge"}', grantSignature: 'A'.repeat(86) },
  });

  await updater.preflight();
  await updater.begin();
  await updater.send();
  await updater.commit();

  assert.equal(calls[0].init.body.grantPayload, '{"exact":"card-challenge"}');
  assert.equal(calls[0].init.body.grantSignature, 'A'.repeat(86));
  assert.equal(calls[0].init.body.updateCapability, undefined);
  for (const call of calls.slice(1)) {
    assert.equal(call.init.body.updateCapability, 'update-only-secret');
    assert.equal(call.init.body.grantPayload, undefined);
    assert.equal(call.init.body.grantSignature, undefined);
    assert.equal(call.init.body.capability, '');
    assert.equal(call.init.body.physicalConfirmationNonce, '');
  }
});

test('reload state is redacted and reconnect succeeds only for same card, new boot, target build, and unchanged project', async () => {
  const storage = new Map();
  const storageAdapter = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const updater = createCardFirmwareUpdater({
    authority: authority([]), release: release(8),
    physicalConfirmation: 'owner-confirmed-physical-control', storage: storageAdapter,
    projectFingerprint: OLD_FINGERPRINT,
  });
  await updater.preflight();
  const persisted = readFirmwareUpdateSession({ storage: storageAdapter });
  assert.deepEqual(persisted, {
    version: 1,
    cardId: CARD_ID,
    previousBootId: OLD_BOOT,
    expectedProjectHead: OLD_HEAD,
    expectedProjectFingerprint: OLD_FINGERPRINT,
    targetFirmwareVersion: '1.2.0',
    targetBuildId: TARGET_BUILD,
    targetBuildNumber: 1300,
    ticketSha256: TICKET_DIGEST,
    phase: 'preflight',
    acknowledgedBytes: 0,
  });
  assert.doesNotMatch(JSON.stringify(persisted), /owner-capability-secret|owner-session/);

  const status = {
    cardId: CARD_ID, bootId: 'boot-new', firmwareVersion: '1.2.0', buildId: TARGET_BUILD,
    projectHead: OLD_HEAD, projectFingerprint: OLD_FINGERPRINT,
  };
  assert.equal(correlateFirmwareUpdateReconnect(persisted, status).ok, true);
  assert.equal(correlateFirmwareUpdateReconnect(persisted, { ...status, cardId: 'lw-wrong' }).reason, 'wrong-card');
  assert.equal(correlateFirmwareUpdateReconnect(persisted, { ...status, bootId: OLD_BOOT }).reason, 'boot-unchanged');
  assert.equal(correlateFirmwareUpdateReconnect(persisted, { ...status, projectHead: 'f'.repeat(64) }).reason, 'project-changed');
});

test('reload recovery distinguishes probation, valid, and rollback without weakening exact-card correlation', () => {
  const session = {
    version: 1, cardId: CARD_ID, previousBootId: OLD_BOOT,
    expectedProjectHead: OLD_HEAD, expectedProjectFingerprint: OLD_FINGERPRINT,
    targetFirmwareVersion: '1.2.0', targetBuildId: TARGET_BUILD, targetBuildNumber: 1300,
    ticketSha256: TICKET_DIGEST, phase: 'restarting', acknowledgedBytes: 8,
  };
  const readiness = {
    cardId: CARD_ID, bootId: 'boot-new', firmwareVersion: '1.2.0', buildId: TARGET_BUILD,
    projectHead: OLD_HEAD, projectFingerprint: OLD_FINGERPRINT,
    capabilities: { firmwareUpdate: { version: 1, network: true } },
  };
  assert.deepEqual(
    correlateFirmwareUpdateRecovery(session, { phase: 'probation', expectedBuildId: TARGET_BUILD }, readiness),
    { ok: false, terminal: false, phase: 'probation', reason: '' },
  );
  assert.deepEqual(
    correlateFirmwareUpdateRecovery(session, { phase: 'valid', expectedBuildId: TARGET_BUILD }, readiness),
    { ok: true, terminal: true, phase: 'valid', reason: '' },
  );
  assert.deepEqual(
    correlateFirmwareUpdateRecovery(session, {
      phase: 'rolled-back', rollbackReason: 'boot-health-failed', restoredBuildNumber: 1201,
    }, {
      ...readiness, firmwareVersion: '1.1.1', buildId: '1'.repeat(40), buildNumber: 1198,
    }),
    { ok: false, terminal: true, phase: 'rolled-back', reason: 'boot-health-failed', restoredBuildNumber: 1201 },
  );
  assert.equal(correlateFirmwareUpdateRecovery(session, { phase: 'valid' }, {
    ...readiness, projectFingerprint: 'f'.repeat(64),
  }).reason, 'project-changed');
  assert.equal(correlateFirmwareUpdateRecovery(session, { phase: 'valid' }, {
    ...readiness, capabilities: { firmwareUpdate: { version: 1, network: false } },
  }).reason, 'update-capability-missing');
});

test('reload recovery accepts idle or missing update status only with complete runtime-known-good evidence', () => {
  const session = {
    version: 1, cardId: CARD_ID, previousBootId: OLD_BOOT,
    expectedProjectHead: OLD_HEAD, expectedProjectFingerprint: OLD_FINGERPRINT,
    targetFirmwareVersion: '1.2.0', targetBuildId: TARGET_BUILD, targetBuildNumber: 1300,
    ticketSha256: TICKET_DIGEST, phase: 'restarting', acknowledgedBytes: 8,
  };
  const runtimeKnownGood = {
    cardId: CARD_ID, bootId: 'boot-new', firmwareVersion: '1.2.0', buildId: TARGET_BUILD,
    projectHead: OLD_HEAD, projectFingerprint: OLD_FINGERPRINT,
    runtimePhase: 'ready', knownGoodProject: true, commandReady: true,
    outputReady: true, playbackReady: true, provisionalSetup: false,
  };
  const accepted = {
    ok: true, terminal: true, phase: 'valid', reason: '', evidence: 'runtime-known-good',
  };

  assert.deepEqual(correlateFirmwareUpdateRecovery(session, { phase: 'idle' }, runtimeKnownGood), accepted);
  assert.deepEqual(correlateFirmwareUpdateRecovery(session, {}, {
    ...runtimeKnownGood, provisionalSetup: undefined,
  }), accepted);

  for (const [field, value] of [
    ['runtimePhase', 'recovering'],
    ['knownGoodProject', false],
    ['commandReady', false],
    ['outputReady', false],
    ['playbackReady', false],
    ['provisionalSetup', true],
  ]) {
    assert.equal(
      correlateFirmwareUpdateRecovery(session, { phase: 'idle' }, {
        ...runtimeKnownGood, [field]: value,
      }).reason,
      'runtime-not-known-good',
      `${field} must remain part of the runtime-known-good gate`,
    );
  }
  assert.equal(
    correlateFirmwareUpdateRecovery(session, {}, { ...runtimeKnownGood, playbackReady: undefined }).reason,
    'runtime-not-known-good',
  );
});

test('blank-card Wi-Fi update binds an exact empty project head without treating it as a wildcard', async () => {
  const storage = new Map();
  const storageAdapter = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const blankAuthority = {
    ...authority([]),
    projectHead: '',
    ownerCapabilityExpectedHead: '',
  };
  const updater = createCardFirmwareUpdater({
    authority: blankAuthority,
    release: release(8),
    physicalConfirmation: 'owner-confirmed-physical-control',
    storage: storageAdapter,
  });

  await updater.preflight();
  const session = readFirmwareUpdateSession({ storage: storageAdapter });
  assert.equal(session.expectedProjectHead, '');
  const readiness = {
    cardId: CARD_ID,
    bootId: 'boot-new',
    firmwareVersion: '1.2.0',
    buildId: TARGET_BUILD,
    projectHead: '',
    capabilities: { firmwareUpdate: { version: 1, network: true } },
  };
  assert.equal(correlateFirmwareUpdateRecovery(session, { phase: 'valid' }, readiness).ok, true);
  assert.equal(correlateFirmwareUpdateRecovery(session, { phase: 'valid' }, {
    ...readiness,
    projectHead: 'f'.repeat(64),
  }).reason, 'project-changed');
  assert.throws(() => createCardFirmwareUpdater({
    authority: { ...blankAuthority, projectHead: 'not-a-project-head', ownerCapabilityExpectedHead: 'not-a-project-head' },
    release: release(8),
    physicalConfirmation: 'owner-confirmed-physical-control',
  }), /exact-card update authorization/i);
});

test('Wi-Fi updater rejects a zero operation generation before any card mutation', () => {
  const calls = [];
  assert.throws(() => createCardFirmwareUpdater({
    authority: { ...authority(calls), operationGeneration: 0 },
    release: release(8),
    physicalConfirmation: 'owner-confirmed-physical-control',
  }), /exact-card update authorization/i);
  assert.deepEqual(calls, []);
});

test('USB bootstrap can save the same redacted correlation envelope without update authority secrets', () => {
  const storage = new Map();
  const storageAdapter = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };
  const saved = saveFirmwareUpdateSession({
    cardId: CARD_ID, previousBootId: OLD_BOOT, expectedProjectHead: OLD_HEAD,
    expectedProjectFingerprint: OLD_FINGERPRINT, targetFirmwareVersion: '1.2.0',
    targetBuildId: TARGET_BUILD, targetBuildNumber: 1300, ticketSha256: TICKET_DIGEST,
    phase: 'restarting', acknowledgedBytes: 8,
  }, { storage: storageAdapter });
  assert.equal(saved.cardId, CARD_ID);
  assert.deepEqual(readFirmwareUpdateSession({ storage: storageAdapter }), saved);
  assert.doesNotMatch(storage.get('lw_firmware_update_session_v1'), /capability|ownerSession/i);
});

test('correlated recovery cannot clear a newer firmware session', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const first = saveFirmwareUpdateSession({
    cardId: CARD_ID, previousBootId: OLD_BOOT, expectedProjectHead: OLD_HEAD,
    expectedProjectFingerprint: OLD_FINGERPRINT, targetFirmwareVersion: '1.2.0',
    targetBuildId: TARGET_BUILD, targetBuildNumber: 1300, ticketSha256: TICKET_DIGEST,
    phase: 'pending-reboot', acknowledgedBytes: 8,
  }, { storage });
  const newer = saveFirmwareUpdateSession({
    ...first,
    previousBootId: 'boot-newer-session',
    targetFirmwareVersion: '1.3.0',
    targetBuildId: 'f'.repeat(40),
    targetBuildNumber: 1301,
    phase: 'preflight',
  }, { storage });

  assert.equal(clearFirmwareUpdateSessionIfMatches(first, { storage }), false);
  assert.deepEqual(readFirmwareUpdateSession({ storage }), newer);
  assert.equal(clearFirmwareUpdateSessionIfMatches(newer, { storage }), true);
  assert.equal(readFirmwareUpdateSession({ storage }), null);
});

test('a no-LAN old card can resume USB correlation without inventing prior boot or project evidence', () => {
  const storage = new Map();
  const storageAdapter = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };
  const session = saveFirmwareUpdateSession({
    mode: 'usb', cardId: CARD_ID, previousBootId: '', expectedProjectHead: '',
    expectedProjectFingerprint: '', targetFirmwareVersion: '1.2.0',
    targetBuildId: TARGET_BUILD, targetBuildNumber: 1300, ticketSha256: TICKET_DIGEST,
    phase: 'restarting', acknowledgedBytes: 8,
  }, { storage: storageAdapter });
  assert.equal(session.mode, 'usb');
  assert.equal(session.previousBootId, '');
  assert.equal(session.expectedProjectHead, '');
  assert.deepEqual(correlateFirmwareUpdateRecovery(session, { phase: 'valid' }, {
    cardId: CARD_ID, bootId: 'boot-after-usb', firmwareVersion: '1.2.0', buildId: TARGET_BUILD,
    capabilities: { firmwareUpdate: { version: 1, network: true } },
  }), { ok: true, terminal: true, phase: 'valid', reason: '' });
});

test('reload status is read through the real card route without restoring mutation authority', async () => {
  const calls = [];
  const status = await readFirmwareUpdateStatus({
    async request(path, init) { calls.push({ path, init }); return { ok: true, phase: 'probation' }; },
  });
  assert.deepEqual(calls, [{ path: '/api/update/status', init: { method: 'GET' } }]);
  assert.equal(status.phase, 'probation');
});
