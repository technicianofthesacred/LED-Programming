export const CARD_COMMISSIONING_STAGES = Object.freeze([
  'connect-card',
  'install-safely',
  'set-up-card',
  'check-lights',
]);

export const CARD_COMMISSIONING_STORAGE_KEY = 'lw_card_commissioning_v1';
export const CARD_COMMISSIONING_BACKUP_STORAGE_KEY = 'lw_card_commissioning_v1_backup';
export const CARD_COMMISSIONING_CHANGED_EVENT = 'lightweaver-card-commissioning-changed';

const VERSION = 1;
const SOURCES = new Set(['web-serial', 'native-bridge']);
const OPERATIONS = new Set(['inspect-card', 'install-current-release', 'recover-current-release', 'release-usb', 'restart-card']);

function text(value, max = 128) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function cardIdFromEspMac(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/:/g, '');
  return /^[0-9a-f]{12}$/.test(normalized) ? `lw-${normalized}` : '';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cardRestoreSnapshot(project = {}) {
  return clone({
    version: project.version,
    id: project.id,
    name: project.name,
    layout: {
      strips: project.layout?.strips || [],
      patchBoard: project.layout?.patchBoard || null,
      wiring: project.layout?.wiring || null,
    },
    devices: {
      standaloneController: project.devices?.standaloneController || {},
    },
  });
}

function defaultStorage() {
  try { return globalThis?.window?.localStorage || globalThis?.localStorage || null; }
  catch { return null; }
}

function makeFlowId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintCommissioningProject(project) {
  const source = stableJson(project);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function validProjectRecord(record) {
  return Boolean(record && typeof record === 'object' && text(record.id, 128) && record.project && typeof record.project === 'object');
}

export function beginCardCommissioning({
  source,
  operation,
  strategy = 'clean-recovery',
  compatibilityVerified = false,
  routineUpdate = false,
  projectRecord,
  projectRevision,
  installTarget = null,
  flowId = makeFlowId(),
  now = Date.now(),
} = {}) {
  if (!SOURCES.has(source)) throw new Error('A supported commissioning source is required');
  if (!OPERATIONS.has(operation)) throw new Error('A supported card operation is required');
  if (!validProjectRecord(projectRecord)) throw new Error('Save the Studio project before changing card firmware');
  const snapshot = cardRestoreSnapshot(projectRecord.project);
  const preserve = strategy === 'preserve-in-place' && compatibilityVerified === true && routineUpdate === true && operation === 'install-current-release';
  return {
    version: VERSION,
    flowId: text(flowId, 96),
    source,
    operation,
    strategy: preserve ? 'preserve-in-place' : 'clean-recovery',
    stage: 'install-safely',
    createdAt: Number(now),
    updatedAt: Number(now),
    networkState: preserve ? 'preserved' : 'unknown',
    installTarget: installTarget ? {
      id: text(installTarget.id || installTarget.cardId, 64),
      firmwareVersion: text(installTarget.firmwareVersion, 48),
      buildId: text(installTarget.buildId, 96),
    } : null,
    expectedCard: null,
    cardAcknowledgedAt: null,
    lastConnectionIssue: '',
    project: {
      recordId: text(projectRecord.id, 128),
      recordUpdatedAt: Number(projectRecord.updatedAt) || Number(now),
      revision: Math.max(0, Number(projectRevision) || 0),
      fingerprint: fingerprintCommissioningProject(snapshot),
      snapshot,
      savedInBrowser: true,
      restoredAt: null,
      restoredFingerprint: '',
      pendingActivationId: '',
    },
  };
}

export function completeCardInstall(flow, result = {}, { now = Date.now() } = {}) {
  requireFlow(flow);
  if (flow.stage !== 'install-safely' && flow.stage !== 'set-up-card') throw new Error('Card installation is not awaiting a verified result');
  if (result.operation && result.operation !== flow.operation) throw new Error('The install result does not match the active commissioning operation');
  const expectedCard = {
    id: text(result.cardId || result.expectedCardId, 64),
    firmwareVersion: text(result.firmwareVersion, 48),
    buildId: text(result.buildId, 96),
  };
  if (!expectedCard.id || !expectedCard.firmwareVersion || !expectedCard.buildId) {
    throw new Error('The verified install result is missing exact card or firmware identity');
  }
  return {
    ...clone(flow),
    stage: 'set-up-card',
    updatedAt: Math.max(Number(now), Number(flow.updatedAt)),
    networkState: flow.strategy === 'preserve-in-place' ? 'preserved' : 'setup-required',
    expectedCard,
    cardAcknowledgedAt: null,
  };
}

export function acknowledgeCommissionedCard(flow, card = {}, { now = Date.now() } = {}) {
  requireFlow(flow);
  if (flow.stage !== 'set-up-card') return { ok: false, reason: 'not-awaiting-card' };
  if (!flow.expectedCard?.id || text(card.id || card.cardId, 64) !== flow.expectedCard.id) return { ok: false, reason: 'wrong-card' };
  if (text(card.firmwareVersion, 48) !== flow.expectedCard.firmwareVersion) return { ok: false, reason: 'wrong-firmware-version' };
  if (text(card.buildId || card.firmwareBuild || card.build, 96) !== flow.expectedCard.buildId) return { ok: false, reason: 'wrong-firmware-build' };
  return {
    ok: true,
    flow: {
      ...clone(flow),
      updatedAt: Math.max(Number(now), Number(flow.updatedAt)),
      cardAcknowledgedAt: Math.max(Number(now), Number(flow.updatedAt)),
      networkState: 'connected',
      lastConnectionIssue: '',
    },
  };
}

export function resumeInstalledCardAfterInterruption(flow, card = {}, { now = Date.now() } = {}) {
  requireFlow(flow);
  if (flow.source !== 'web-serial' || flow.stage !== 'install-safely' || !flow.installTarget) {
    return { ok: false, reason: 'not-resumable' };
  }
  const actual = {
    id: text(card.id || card.cardId, 64),
    firmwareVersion: text(card.firmwareVersion, 48),
    buildId: text(card.buildId || card.firmwareBuild || card.build, 96),
  };
  if (actual.id !== flow.installTarget.id) return { ok: false, reason: 'wrong-card' };
  if (actual.firmwareVersion !== flow.installTarget.firmwareVersion) return { ok: false, reason: 'wrong-firmware-version' };
  if (actual.buildId !== flow.installTarget.buildId) return { ok: false, reason: 'wrong-firmware-build' };
  return { ok: true, flow: completeCardInstall(flow, {
    operation: flow.operation,
    cardId: actual.id,
    firmwareVersion: actual.firmwareVersion,
    buildId: actual.buildId,
  }, { now }) };
}

export function markCardProjectRestored(flow, acknowledgement = {}, { now = Date.now() } = {}) {
  requireFlow(flow);
  if (flow.stage !== 'set-up-card' || !flow.cardAcknowledgedAt) throw new Error('The exact installed card must acknowledge its firmware before restoration');
  if (text(acknowledgement.cardId, 64) !== flow.expectedCard.id) throw new Error('Project restoration was not acknowledged by the expected card');
  if (text(acknowledgement.projectFingerprint, 32) !== flow.project.fingerprint) throw new Error('The card did not acknowledge the saved Studio project revision');
  return {
    ...clone(flow),
    stage: 'check-lights',
    updatedAt: Math.max(Number(now), Number(flow.updatedAt)),
    project: {
      ...clone(flow.project),
      restoredAt: Math.max(Number(now), Number(flow.updatedAt)),
      restoredFingerprint: flow.project.fingerprint,
    },
  };
}

export function stageCardProjectForPhysicalCheck(flow, acknowledgement = {}, { now = Date.now() } = {}) {
  requireFlow(flow);
  if (flow.stage !== 'set-up-card' || !flow.cardAcknowledgedAt) throw new Error('The exact installed card must acknowledge its firmware before restoration');
  if (text(acknowledgement.cardId, 64) !== flow.expectedCard.id) throw new Error('Project restoration was not staged on the expected card');
  if (text(acknowledgement.projectFingerprint, 32) !== flow.project.fingerprint) throw new Error('The staged project is not the saved Studio revision');
  const activationId = text(acknowledgement.activationId, 128);
  if (!activationId) throw new Error('The card did not return a wiring activation identifier');
  return {
    ...clone(flow),
    stage: 'check-lights',
    updatedAt: Math.max(Number(now), Number(flow.updatedAt)),
    project: { ...clone(flow.project), pendingActivationId: activationId },
  };
}

function requireFlow(flow) {
  if (!flow || flow.version !== VERSION || !CARD_COMMISSIONING_STAGES.includes(flow.stage)) {
    throw new Error('Invalid card commissioning progress');
  }
  if (!/^[A-Za-z0-9_-]{16,96}$/.test(flow.flowId || '') || !SOURCES.has(flow.source) || !OPERATIONS.has(flow.operation)
    || !['clean-recovery', 'preserve-in-place'].includes(flow.strategy)
    || !Number.isSafeInteger(flow.createdAt) || !Number.isSafeInteger(flow.updatedAt)
    || flow.createdAt < 0 || flow.updatedAt < flow.createdAt
    || !['unknown', 'preserved', 'setup-required', 'connected'].includes(flow.networkState)
    || !flow.project || !text(flow.project.recordId, 128)
    || !Number.isSafeInteger(flow.project.revision) || flow.project.revision < 0
    || !/^[a-f0-9]{16}$/.test(flow.project.fingerprint || '')) {
    throw new Error('Invalid card commissioning progress');
  }
  if (!flow.project?.snapshot || fingerprintCommissioningProject(flow.project.snapshot) !== flow.project.fingerprint) {
    throw new Error('The saved commissioning project revision is invalid');
  }
  if (flow.stage !== 'install-safely') {
    const expected = flow.expectedCard || {};
    if (!/^lw-[a-f0-9]{12}$/.test(expected.id || '') || !text(expected.firmwareVersion, 48)
      || !/^[a-f0-9]{40}$/.test(expected.buildId || '')) throw new Error('Invalid card commissioning identity');
  }
  if (flow.stage === 'check-lights' && !flow.project.restoredAt && !text(flow.project.pendingActivationId, 128)) {
    throw new Error('Invalid card commissioning restoration');
  }
  return flow;
}

function notify(flow) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(CARD_COMMISSIONING_CHANGED_EVENT, { detail: { flowId: flow?.flowId || '' } }));
  }
}

export function writeCardCommissioning(flow, { storage = defaultStorage() } = {}) {
  if (!storage?.setItem) return false;
  requireFlow(flow);
  const serializable = clone(flow);
  const encoded = JSON.stringify(serializable);
  storage.setItem(CARD_COMMISSIONING_STORAGE_KEY, encoded);
  try { storage.setItem(CARD_COMMISSIONING_BACKUP_STORAGE_KEY, encoded); } catch {}
  notify(serializable);
  return true;
}

export function readCardCommissioning({ storage = defaultStorage() } = {}) {
  if (!storage?.getItem) return null;
  for (const key of [CARD_COMMISSIONING_STORAGE_KEY, CARD_COMMISSIONING_BACKUP_STORAGE_KEY]) {
    try {
      const parsed = JSON.parse(storage.getItem(key) || 'null');
      requireFlow(parsed);
      return parsed;
    } catch {}
  }
  return null;
}

export function clearCardCommissioning({ storage = defaultStorage() } = {}) {
  if (!storage?.removeItem) return false;
  storage.removeItem(CARD_COMMISSIONING_STORAGE_KEY);
  storage.removeItem(CARD_COMMISSIONING_BACKUP_STORAGE_KEY);
  notify(null);
  return true;
}
