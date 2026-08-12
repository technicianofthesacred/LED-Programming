export const FIRMWARE_UPDATE_CHUNK_BYTES = 32 * 1024;
export const FIRMWARE_UPDATE_SESSION_KEY = 'lw_firmware_update_session_v1';

const CARD_ID = /^lw-[A-Za-z0-9][A-Za-z0-9._:-]{0,60}$/;
const BUILD_ID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function text(value, max = 128) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function exactProjectHead(value) {
  if (value === '') return '';
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return SHA256.test(normalized) ? normalized : null;
}

function browserSessionStorage() {
  try { return globalThis.window?.sessionStorage || null; }
  catch { return null; }
}

function validRelease(release) {
  const manifest = release?.manifest;
  const imageBytes = release?.imageBytes;
  const ticketBytes = release?.ticketBytes;
  const ticketSignature = release?.ticketSignature;
  const ticketSha256 = text(release?.ticketSha256, 64).toLowerCase();
  const imageSize = Number(release?.ticket?.image?.size ?? imageBytes?.byteLength);
  if (!manifest || !BUILD_ID.test(text(manifest.buildId, 40).toLowerCase())
    || !text(manifest.firmwareVersion, 48)
    || !Number.isSafeInteger(manifest.buildNumber) || manifest.buildNumber < 1
    || !SHA256.test(ticketSha256)
    || !(imageBytes instanceof Uint8Array) || imageBytes.byteLength < 1
    || !(ticketBytes instanceof Uint8Array) || ticketBytes.byteLength < 1
    || !(ticketSignature instanceof Uint8Array) || ticketSignature.byteLength !== 64
    || imageSize !== imageBytes.byteLength) {
    throw new Error('The verified firmware update release is incomplete.');
  }
  return { manifest, ticketSha256, imageBytes, ticketBytes, ticketSignature };
}

function binding(authority, release, physicalConfirmation, softwareGrant) {
  const grantPayload = typeof softwareGrant?.grantPayload === 'string' ? softwareGrant.grantPayload : '';
  const grantSignature = text(softwareGrant?.grantSignature, 128);
  const softwareAuthorized = Boolean(grantPayload && grantSignature);
  const result = {
    cardId: text(authority?.cardId, 64),
    bootId: text(authority?.bootId, 96),
    ownerSessionId: text(authority?.ownerSessionId, 128),
    operationGeneration: Number(authority?.operationGeneration),
    expectedProjectHead: exactProjectHead(authority?.projectHead),
    capability: text(authority?.ownerCapability, 512),
    physicalConfirmationNonce: text(physicalConfirmation, 160),
    grantPayload,
    grantSignature,
    releaseBuildId: text(release.manifest.buildId, 40).toLowerCase(),
    ticketSha256: release.ticketSha256,
  };
  if (!authority?.request || authority.revoked || !CARD_ID.test(result.cardId)
    || !result.bootId || !result.ownerSessionId
    || !Number.isSafeInteger(result.operationGeneration) || result.operationGeneration <= 0
    || result.expectedProjectHead === null
    || (!softwareAuthorized && (!result.capability || !result.physicalConfirmationNonce))) {
    throw new Error('A current exact-card update authorization is required.');
  }
  if (!softwareAuthorized
    && text(authority.ownerCapabilityExpectedHead, 64).toLowerCase() !== result.expectedProjectHead) {
    throw new Error('Owner authority is bound to a different project head.');
  }
  return Object.freeze({ ...result, authorization: softwareAuthorized ? 'software-grant' : 'physical-owner' });
}

function mutationHeaders(value, additions = {}) {
  return {
    'X-Lightweaver-Card-Id': value.cardId,
    'X-Lightweaver-Boot-Id': value.bootId,
    'X-Lightweaver-Owner-Session': value.ownerSessionId,
    'X-Lightweaver-Operation-Generation': String(value.operationGeneration),
    'X-Lightweaver-Expected-Head': value.expectedProjectHead,
    'X-Lightweaver-Capability': value.capability,
    'X-Lightweaver-Release-Build': value.releaseBuildId,
    'X-Lightweaver-Ticket-Sha256': value.ticketSha256,
    ...additions,
  };
}

function base64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64url(bytes) {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function safeSession(value) {
  const usb = value?.mode === 'usb';
  const expectedProjectHead = exactProjectHead(value?.expectedProjectHead);
  const session = {
    version: 1,
    cardId: text(value?.cardId, 64),
    previousBootId: text(value?.previousBootId, 96),
    expectedProjectHead,
    expectedProjectFingerprint: text(value?.expectedProjectFingerprint, 64).toLowerCase(),
    targetFirmwareVersion: text(value?.targetFirmwareVersion, 48),
    targetBuildId: text(value?.targetBuildId, 40).toLowerCase(),
    targetBuildNumber: Number(value?.targetBuildNumber),
    ticketSha256: text(value?.ticketSha256, 64).toLowerCase(),
    phase: text(value?.phase, 32),
    acknowledgedBytes: Number(value?.acknowledgedBytes || 0),
  };
  if (session.version !== 1 || !CARD_ID.test(session.cardId)
    || (!usb && !session.previousBootId)
    || session.expectedProjectHead === null || !BUILD_ID.test(session.targetBuildId)
    || !Number.isSafeInteger(session.targetBuildNumber) || session.targetBuildNumber < 1
    || !SHA256.test(session.ticketSha256)
    || !Number.isSafeInteger(session.acknowledgedBytes) || session.acknowledgedBytes < 0) return null;
  return Object.freeze({ ...(usb ? { mode: 'usb' } : {}), ...session });
}

export function readFirmwareUpdateSession({ storage = browserSessionStorage() } = {}) {
  try { return safeSession(JSON.parse(storage?.getItem?.(FIRMWARE_UPDATE_SESSION_KEY) || 'null')); }
  catch { return null; }
}

export function clearFirmwareUpdateSession({ storage = browserSessionStorage() } = {}) {
  try { storage?.removeItem?.(FIRMWARE_UPDATE_SESSION_KEY); return true; }
  catch { return false; }
}

const RECOVERY_IDENTITY_FIELDS = Object.freeze([
  'cardId',
  'previousBootId',
  'targetFirmwareVersion',
  'targetBuildId',
  'targetBuildNumber',
  'expectedProjectHead',
  'expectedProjectFingerprint',
]);

export function clearFirmwareUpdateSessionIfMatches(expected, { storage = browserSessionStorage() } = {}) {
  const safeExpected = safeSession(expected);
  const current = readFirmwareUpdateSession({ storage });
  if (!safeExpected || !current
    || RECOVERY_IDENTITY_FIELDS.some(field => current[field] !== safeExpected[field])) return false;
  return clearFirmwareUpdateSession({ storage });
}

function persistSession(session, storage) {
  const safe = safeSession(session);
  if (!safe) throw new Error('Firmware update recovery state is incomplete.');
  storage?.setItem?.(FIRMWARE_UPDATE_SESSION_KEY, JSON.stringify(safe));
  return safe;
}

export function saveFirmwareUpdateSession(value, { storage = browserSessionStorage() } = {}) {
  return persistSession({ version: 1, ...value }, storage);
}

export function correlateFirmwareUpdateReconnect(rawSession, status = {}) {
  const session = safeSession(rawSession);
  if (!session) return { ok: false, reason: 'session-invalid' };
  if (text(status.cardId ?? status.id, 64) !== session.cardId) return { ok: false, reason: 'wrong-card' };
  const bootId = text(status.bootId, 96);
  if (!bootId) return { ok: false, reason: 'boot-missing' };
  if (bootId === session.previousBootId) return { ok: false, reason: 'boot-unchanged' };
  if (text(status.firmwareVersion, 48) !== session.targetFirmwareVersion
    || text(status.buildId, 40).toLowerCase() !== session.targetBuildId) {
    return { ok: false, reason: 'target-mismatch' };
  }
  if (exactProjectHead(status.projectHead) !== session.expectedProjectHead
    || (session.expectedProjectFingerprint
      && text(status.projectFingerprint, 64).toLowerCase() !== session.expectedProjectFingerprint)) {
    return { ok: false, reason: 'project-changed' };
  }
  return { ok: true, reason: '', status };
}

export function correlateFirmwareUpdateRecovery(rawSession, updateStatus = {}, readiness = {}) {
  const session = safeSession(rawSession);
  if (!session) return { ok: false, terminal: false, phase: '', reason: 'session-invalid' };
  if (text(readiness.cardId ?? readiness.id, 64) !== session.cardId) {
    return { ok: false, terminal: false, phase: '', reason: 'wrong-card' };
  }
  const bootId = text(readiness.bootId, 96);
  if (!bootId) return { ok: false, terminal: false, phase: '', reason: 'boot-missing' };
  if (session.previousBootId && bootId === session.previousBootId) {
    return { ok: false, terminal: false, phase: '', reason: 'boot-unchanged' };
  }
  const projectHeadMustMatch = session.mode !== 'usb' || Boolean(session.expectedProjectHead);
  if ((projectHeadMustMatch
      && exactProjectHead(readiness.projectHead) !== session.expectedProjectHead)
    || (session.expectedProjectFingerprint
      && text(readiness.projectFingerprint, 64).toLowerCase() !== session.expectedProjectFingerprint)) {
    return { ok: false, terminal: false, phase: '', reason: 'project-changed' };
  }
  const phase = text(updateStatus.phase, 32);
  if (phase === 'rolled-back') {
    const reportedRestoredBuild = Number(updateStatus.restoredBuildNumber);
    return {
      ok: false, terminal: true, phase, reason: text(updateStatus.rollbackReason, 96) || 'health-check-failed',
      restoredBuildNumber: Number.isSafeInteger(reportedRestoredBuild) && reportedRestoredBuild > 0
        ? reportedRestoredBuild
        : Number.isSafeInteger(Number(readiness.buildNumber)) ? Number(readiness.buildNumber) : null,
    };
  }
  if (text(readiness.firmwareVersion, 48) !== session.targetFirmwareVersion
    || text(readiness.buildId, 40).toLowerCase() !== session.targetBuildId) {
    return { ok: false, terminal: false, phase, reason: 'target-mismatch' };
  }
  if (phase === 'probation') return { ok: false, terminal: false, phase, reason: '' };
  if (!phase || phase === 'idle') {
    const runtimeKnownGood = readiness.runtimePhase === 'ready'
      && readiness.knownGoodProject === true
      && readiness.commandReady === true
      && readiness.outputReady === true
      && readiness.playbackReady === true
      && readiness.provisionalSetup !== true;
    // The health proof answers one question: did the project this update promised
    // to PRESERVE survive the write? A session that recorded no project head made
    // no such promise — a blank card, or the USB bootstrap, which resets the chip
    // without arming an OTA handoff and so can only ever read back `idle`. Demanding
    // wiring-dependent evidence from a card that was never wired rejects a perfectly
    // good update forever, and `runtime-not-known-good` is non-terminal, so the
    // owner gets the 45-second retry cycle with no way out.
    if (session.expectedProjectHead && !runtimeKnownGood) {
      return { ok: false, terminal: false, phase, reason: 'runtime-not-known-good' };
    }
    return {
      ok: true,
      terminal: true,
      phase: 'valid',
      reason: '',
      evidence: runtimeKnownGood ? 'runtime-known-good' : 'exact-target-readback',
    };
  }
  if (phase !== 'valid') return { ok: false, terminal: false, phase, reason: 'update-not-valid' };
  const capability = readiness?.capabilities?.firmwareUpdate;
  if (capability?.version !== 1 || capability.network !== true) {
    return { ok: false, terminal: false, phase, reason: 'update-capability-missing' };
  }
  return { ok: true, terminal: true, phase, reason: '' };
}

export async function readFirmwareUpdateStatus(authority) {
  if (typeof authority?.request !== 'function') throw new Error('The card update status route is unavailable.');
  const result = await authority.request('/api/update/status', { method: 'GET' });
  if (!result || result.ok === false) throw new Error(result?.message || 'The card update status could not be read.');
  return result;
}

export function createCardFirmwareUpdater({
  authority,
  release: rawRelease,
  physicalConfirmation,
  softwareGrant,
  projectFingerprint = authority?.readiness?.projectFingerprint || '',
  storage = browserSessionStorage(),
  onProgress,
} = {}) {
  const release = validRelease(rawRelease);
  const exactBinding = binding(authority, release, physicalConfirmation, softwareGrant);
  let phase = 'idle';
  let leaseId = '';
  let acknowledgedBytes = 0;
  let revoked = false;
  let updateCapability = '';
  const stopWatching = authority.watch?.(() => { revoked = true; }) || (() => {});
  const assertCurrent = () => {
    if (revoked || authority.revoked
      || text(authority.cardId, 64) !== exactBinding.cardId
      || text(authority.bootId, 96) !== exactBinding.bootId
      || Number(authority.operationGeneration) !== exactBinding.operationGeneration
      || text(authority.projectHead, 64).toLowerCase() !== exactBinding.expectedProjectHead) {
      throw new Error('Firmware update authority changed. Reconnect and confirm the exact card again.');
    }
  };
  const session = nextPhase => persistSession({
    cardId: exactBinding.cardId,
    previousBootId: exactBinding.bootId,
    expectedProjectHead: exactBinding.expectedProjectHead,
    expectedProjectFingerprint: text(projectFingerprint, 64).toLowerCase(),
    targetFirmwareVersion: release.manifest.firmwareVersion,
    targetBuildId: release.manifest.buildId,
    targetBuildNumber: release.manifest.buildNumber,
    ticketSha256: release.ticketSha256,
    phase: nextPhase,
    acknowledgedBytes,
  }, storage);
  const request = async (path, init = {}) => {
    assertCurrent();
    const result = await authority.request(path, init);
    assertCurrent();
    if (result?.ok === false) {
      const error = new Error(result.message || `Card refused firmware update at ${path}.`);
      error.reason = result.reason || 'update-refused';
      throw error;
    }
    return result || {};
  };
  const body = additions => {
    const { authorization: _authorization, grantPayload: _grantPayload, grantSignature: _grantSignature, ...common } = exactBinding;
    return { ...common, ...additions };
  };

  return Object.freeze({
    get phase() { return phase; },
    get acknowledgedBytes() { return acknowledgedBytes; },
    async preflight() {
      const result = await request('/api/update/preflight', {
        method: 'POST', headers: mutationHeaders(exactBinding),
        body: body({
          imageSize: release.imageBytes.byteLength,
          targetFirmwareVersion: release.manifest.firmwareVersion,
          ticket: base64(release.ticketBytes),
          signature: base64url(release.ticketSignature),
          ...(exactBinding.authorization === 'software-grant' ? {
            grantPayload: exactBinding.grantPayload,
            grantSignature: exactBinding.grantSignature,
          } : {}),
        }),
      });
      if (exactBinding.authorization === 'software-grant') {
        updateCapability = text(result.updateCapability, 160);
        if (!updateCapability) throw new Error('The card did not issue an update-only capability.');
      }
      phase = 'preflight'; session(phase); return result;
    },
    async begin() {
      const result = await request('/api/update/begin', {
        method: 'POST', headers: mutationHeaders(exactBinding), body: body({ imageSize: release.imageBytes.byteLength, updateCapability }),
      });
      leaseId = text(result.leaseId, 128);
      acknowledgedBytes = Number(result.receivedBytes || 0);
      if (!leaseId || acknowledgedBytes !== 0) throw new Error('Card returned an invalid update lease.');
      phase = 'sending'; session(phase); return result;
    },
    async send() {
      if (!leaseId) throw new Error('Firmware update has not begun.');
      for (let offset = acknowledgedBytes, sequence = Math.floor(offset / FIRMWARE_UPDATE_CHUNK_BYTES) + 1;
        offset < release.imageBytes.byteLength; sequence += 1) {
        const chunk = release.imageBytes.slice(offset, Math.min(offset + FIRMWARE_UPDATE_CHUNK_BYTES, release.imageBytes.byteLength));
        const result = await request('/api/update/chunk', {
          method: 'POST',
          headers: mutationHeaders(exactBinding),
          body: body({ leaseId, sequence, offset, data: base64(chunk), updateCapability }),
        });
        const next = Number(result.receivedBytes);
        if (next !== offset + chunk.byteLength) throw new Error('Card update acknowledgement did not match the sent bytes.');
        acknowledgedBytes = next;
        offset = next;
        session('sending');
        onProgress?.({ phase: 'sending', acknowledgedBytes, totalBytes: release.imageBytes.byteLength });
      }
      return { ok: true, receivedBytes: acknowledgedBytes };
    },
    async commit() {
      if (!leaseId || acknowledgedBytes !== release.imageBytes.byteLength) throw new Error('Firmware update is not fully acknowledged.');
      const result = await request('/api/update/commit', {
        method: 'POST', headers: mutationHeaders(exactBinding), body: body({ leaseId, updateCapability }),
      });
      phase = 'restarting'; session(phase); return result;
    },
    async readStatus() {
      const result = await readFirmwareUpdateStatus(authority);
      if (Number.isSafeInteger(result.receivedBytes) && result.receivedBytes >= acknowledgedBytes) {
        acknowledgedBytes = result.receivedBytes;
      }
      phase = text(result.phase, 32) || phase;
      session(phase);
      onProgress?.({ phase, acknowledgedBytes, totalBytes: release.imageBytes.byteLength });
      return result;
    },
    async cancel() {
      try {
        const result = await request('/api/update/cancel', {
          method: 'POST', headers: mutationHeaders(exactBinding), body: body({ leaseId, updateCapability }),
        });
        phase = 'cancelled'; session(phase); return result;
      } finally { stopWatching(); }
    },
    reconnect(status) {
      const result = correlateFirmwareUpdateReconnect(readFirmwareUpdateSession({ storage }), status);
      if (result.ok) { phase = 'reconnected'; session(phase); stopWatching(); }
      return result;
    },
  });
}
