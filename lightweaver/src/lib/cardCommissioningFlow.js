import { isCardWiringCandidateReadback } from './cardWiringSafety.js';

export const CARD_COMMISSIONING_STAGES = Object.freeze([
  'connect-card',
  'install-safely',
  'set-up-card',
  'check-lights',
]);

export const CARD_COMMISSIONING_STORAGE_KEY = 'lw_card_commissioning_registry_v2';
export const CARD_COMMISSIONING_BACKUP_STORAGE_KEY = 'lw_card_commissioning_registry_v2_backup';
export const CARD_COMMISSIONING_ACTIVE_KEY = 'lw_card_commissioning_active_v2';
export const CARD_COMMISSIONING_CHANGED_EVENT = 'lightweaver-card-commissioning-changed';

const VERSION = 1;
const SOURCES = new Set(['web-serial', 'native-bridge']);
const OPERATIONS = new Set(['inspect-card', 'install-current-release', 'recover-current-release', 'release-usb', 'restart-card']);
const CARD_RESTORATION_READBACKS = new WeakSet();
const CARD_WIRING_ACTIVATION_EVIDENCE = new WeakSet();
const REGISTRY_VERSION = 2;
const MAX_FLOWS = 12;
const MAX_BYTES = 384 * 1024;
const FLOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESTORE_LEASE_MS = 2 * 60 * 1000;
const REGISTRY_LOCK_KEY = 'lw_card_commissioning_registry_v2_lock';
const REGISTRY_LOCK_MS = 5000;

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

function defaultSessionStorage() {
  try { return globalThis?.window?.sessionStorage || globalThis?.sessionStorage || null; }
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
  productionJobDigest = '',
  flowType = productionJobDigest ? 'production-job' : 'studio-project',
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
    flowType: flowType === 'production-job' ? 'production-job' : 'studio-project',
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
    acceptedResultId: '',
    cardAcknowledgedAt: null,
    lastConnectionIssue: '',
    project: {
      recordId: text(projectRecord.id, 128),
      recordUpdatedAt: Number(projectRecord.updatedAt) || Number(now),
      revision: Math.max(0, Number(projectRevision) || 0),
      fingerprint: fingerprintCommissioningProject(snapshot),
      productionJobDigest: text(productionJobDigest, 64).toLowerCase(),
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
  if (flow.source === 'native-bridge') {
    if (text(result.flowId, 96) !== flow.flowId) throw new Error('The Bridge result does not match the active commissioning flow');
    if (text(result.projectFingerprint, 32) !== flow.project.fingerprint) throw new Error('The Bridge result does not match the active project fingerprint');
    if (!/^[A-Za-z0-9_-]{16,96}$/.test(result.acceptedResultId || '')) throw new Error('The Bridge result is missing its accepted result identity');
  }
  const expectedCard = {
    id: text(result.cardId || result.expectedCardId, 64),
    firmwareVersion: text(result.firmwareVersion, 48),
    buildId: text(result.buildId, 96),
  };
  if (!expectedCard.id || !expectedCard.firmwareVersion || !expectedCard.buildId) {
    throw new Error('The verified install result is missing exact card or firmware identity');
  }
  if (result.expectedCardId && text(result.expectedCardId, 64) !== expectedCard.id) {
    throw new Error('The Bridge result does not match the expected card');
  }
  return {
    ...clone(flow),
    stage: 'set-up-card',
    updatedAt: Math.max(Number(now), Number(flow.updatedAt)),
    networkState: flow.strategy === 'preserve-in-place' ? 'preserved' : 'setup-required',
    expectedCard,
    acceptedResultId: flow.source === 'native-bridge' ? text(result.acceptedResultId, 96) : '',
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

export function adaptCardRestorationReadback({ method, endpoint, response } = {}) {
  if (method !== 'GET' || endpoint !== '/api/firmware-info' || !response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Project restoration requires an independent firmware-info GET read-back');
  }
  const evidence = Object.freeze({
    source: 'firmware-info-readback',
    method: 'GET',
    cardId: text(response.cardId || response.id, 64),
    firmwareVersion: text(response.firmwareVersion, 48),
    buildId: text(response.buildId || response.firmwareBuild || response.build, 96),
    projectRevision: Number(response.projectRevision),
    projectFingerprint: text(response.projectFingerprint, 64),
    productionJobDigest: text(response.productionJobDigest, 64).toLowerCase(),
  });
  CARD_RESTORATION_READBACKS.add(evidence);
  return evidence;
}

export function bindCardWiringActivationEvidence(status = {}, readback = {}) {
  if (!status || status.state !== 'staged' || status.ok !== true || !status.raw
    || text(status.raw.activationId, 128) !== text(status.activationId, 128)
    || !text(status.activationId, 128)) {
    throw new Error('The wiring candidate requires the normalized card-issued activation response');
  }
  if (!isCardWiringCandidateReadback(readback) || readback.state !== 'staged'
    || text(readback.activationId, 128) !== text(status.activationId, 128)) {
    throw new Error('The wiring candidate requires an independent exact candidate-status GET read-back');
  }
  const evidence = Object.freeze({
    source: 'card-activation-with-readback',
    activationId: text(status.activationId, 128),
    cardId: readback.cardId,
    firmwareVersion: readback.firmwareVersion,
    buildId: readback.buildId,
    projectRevision: readback.projectRevision,
    projectFingerprint: readback.projectFingerprint,
    productionJobDigest: readback.productionJobDigest,
  });
  CARD_WIRING_ACTIVATION_EVIDENCE.add(evidence);
  return evidence;
}

export function markCardProjectRestored(flow, acknowledgement = {}, { now = Date.now() } = {}) {
  requireFlow(flow);
  if (flow.stage !== 'set-up-card' || !flow.cardAcknowledgedAt) throw new Error('The exact installed card must acknowledge its firmware before restoration');
  if (!CARD_RESTORATION_READBACKS.has(acknowledgement)) {
    throw new Error('Project restoration requires an independent card read-back');
  }
  if (text(acknowledgement.cardId, 64) !== flow.expectedCard.id) throw new Error('Project restoration was not acknowledged by the expected card');
  if (text(acknowledgement.firmwareVersion, 48) !== flow.expectedCard.firmwareVersion) throw new Error('Project restoration read-back has the wrong firmware version');
  if (text(acknowledgement.buildId, 96) !== flow.expectedCard.buildId) throw new Error('Project restoration read-back has the wrong firmware build');
  if (Number(acknowledgement.projectRevision) !== flow.project.revision) throw new Error('The card did not acknowledge the saved Studio project revision');
  if (text(acknowledgement.projectFingerprint, 32) !== flow.project.fingerprint) throw new Error('The card did not acknowledge the saved Studio project revision');
  if (flow.flowType === 'production-job' && (!/^[a-f0-9]{64}$/.test(flow.project.productionJobDigest || '')
    || text(acknowledgement.productionJobDigest, 64).toLowerCase() !== flow.project.productionJobDigest)) {
    throw new Error('The card did not acknowledge the production job digest');
  }
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
  if (!CARD_WIRING_ACTIVATION_EVIDENCE.has(acknowledgement)) throw new Error('The wiring candidate requires card-issued activation evidence with independent read-back');
  if (text(acknowledgement.cardId, 64) !== flow.expectedCard.id) throw new Error('Project restoration was not staged on the expected card');
  if (text(acknowledgement.firmwareVersion, 48) !== flow.expectedCard.firmwareVersion) throw new Error('The staged project read-back has the wrong firmware version');
  if (text(acknowledgement.buildId, 96) !== flow.expectedCard.buildId) throw new Error('The staged project read-back has the wrong firmware build');
  if (Number(acknowledgement.projectRevision) !== flow.project.revision) throw new Error('The staged project read-back has the wrong project revision');
  if (text(acknowledgement.projectFingerprint, 32) !== flow.project.fingerprint) throw new Error('The staged project is not the saved Studio revision');
  if (flow.flowType === 'production-job'
    && text(acknowledgement.productionJobDigest, 64).toLowerCase() !== flow.project.productionJobDigest) {
    throw new Error('The staged project read-back has the wrong production job digest');
  }
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
  if (flow.flowType !== undefined && !['studio-project', 'production-job'].includes(flow.flowType)) throw new Error('Invalid card commissioning type');
  if (flow.flowType === 'production-job' && !/^[a-f0-9]{64}$/.test(flow.project?.productionJobDigest || '')) throw new Error('Invalid card commissioning production job');
  if (!/^[A-Za-z0-9_-]{16,96}$/.test(flow.flowId || '') || !SOURCES.has(flow.source) || !OPERATIONS.has(flow.operation)
    || !['clean-recovery', 'preserve-in-place'].includes(flow.strategy)
    || !Number.isSafeInteger(flow.createdAt) || !Number.isSafeInteger(flow.updatedAt)
    || flow.createdAt < 0 || flow.updatedAt < flow.createdAt
    || !['unknown', 'preserved', 'setup-required', 'connected'].includes(flow.networkState)
    || (flow.acceptedResultId !== undefined && flow.acceptedResultId !== '' && !/^[A-Za-z0-9_-]{16,96}$/.test(flow.acceptedResultId))
    || !flow.project || !text(flow.project.recordId, 128)
    || !Number.isSafeInteger(flow.project.revision) || flow.project.revision < 0
    || !/^[a-f0-9]{16}$/.test(flow.project.fingerprint || '')) {
    throw new Error('Invalid card commissioning progress');
  }
  if (flow.project.productionJobDigest !== undefined && flow.project.productionJobDigest !== ''
    && !/^[a-f0-9]{64}$/.test(flow.project.productionJobDigest)) throw new Error('Invalid card commissioning production job');
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

function emptyRegistry() { return { version: REGISTRY_VERSION, revision: 0, flows: {} }; }

function parseRegistry(storage, now = Date.now()) {
  let corrupt = false;
  for (const key of [CARD_COMMISSIONING_STORAGE_KEY, CARD_COMMISSIONING_BACKUP_STORAGE_KEY]) {
    const raw = storage?.getItem?.(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version !== REGISTRY_VERSION || !parsed.flows || typeof parsed.flows !== 'object') throw new Error('bad registry');
      const flows = {};
      for (const [flowId, entry] of Object.entries(parsed.flows).slice(0, MAX_FLOWS * 2)) {
        if (!entry?.flow || Number(entry.expiresAt) <= now || flowId !== entry.flow.flowId) continue;
        requireFlow(entry.flow);
        flows[flowId] = { flow: entry.flow, tabId: text(entry.tabId, 96), expiresAt: Number(entry.expiresAt), restoreLease: entry.restoreLease || null };
      }
      return { registry: { version: REGISTRY_VERSION, revision: Number(parsed.revision) || 0, flows }, error: '' };
    } catch { corrupt = true; }
  }
  return { registry: emptyRegistry(), error: corrupt ? 'corrupt' : 'missing' };
}

function activeFlowId(sessionStorage, explicitFlowId) {
  return text(explicitFlowId || sessionStorage?.getItem?.(CARD_COMMISSIONING_ACTIVE_KEY), 96);
}

function persistRegistry(storage, registry) {
  const encoded = JSON.stringify(registry);
  if (encoded.length > MAX_BYTES) throw new Error('Commissioning storage is full. Finish or clear an older card setup, then retry.');
  storage.setItem(CARD_COMMISSIONING_BACKUP_STORAGE_KEY, encoded);
  storage.setItem(CARD_COMMISSIONING_STORAGE_KEY, encoded);
}

function acquireRegistryLock(storage, now = Date.now()) {
  const token = makeFlowId();
  let current = null;
  try { current = JSON.parse(storage.getItem(REGISTRY_LOCK_KEY) || 'null'); } catch {}
  if (current?.token && Number(current.expiresAt) > now) throw new Error('Card setup is being updated in another tab. Retry in a moment.');
  storage.setItem(REGISTRY_LOCK_KEY, JSON.stringify({ token, expiresAt: now + REGISTRY_LOCK_MS }));
  let verified = null;
  try { verified = JSON.parse(storage.getItem(REGISTRY_LOCK_KEY) || 'null'); } catch {}
  if (verified?.token !== token) throw new Error('Card setup is being updated in another tab. Retry in a moment.');
  return () => {
    try {
      const owner = JSON.parse(storage.getItem(REGISTRY_LOCK_KEY) || 'null');
      if (owner?.token === token) storage.removeItem(REGISTRY_LOCK_KEY);
    } catch {}
  };
}

export function inspectCardCommissioning({ storage = defaultStorage(), sessionStorage = defaultSessionStorage(), flowId, now = Date.now() } = {}) {
  if (!storage?.getItem) return { flow: null, error: 'unavailable' };
  const parsed = parseRegistry(storage, now);
  const id = activeFlowId(sessionStorage, flowId) || (!sessionStorage?.getItem ? Object.keys(parsed.registry.flows)[0] : '');
  if (!id) return { flow: null, error: parsed.error === 'corrupt' ? 'corrupt' : 'missing' };
  return { flow: parsed.registry.flows[id]?.flow || null, error: parsed.registry.flows[id] ? '' : (parsed.error === 'corrupt' ? 'corrupt' : 'missing') };
}

export function writeCardCommissioning(flow, { storage = defaultStorage(), sessionStorage = defaultSessionStorage(), tabId = '', now = Date.now() } = {}) {
  if (!storage?.setItem) return false;
  requireFlow(flow);
  const unlock = acquireRegistryLock(storage, now);
  try {
    const serializable = clone(flow);
    const { registry } = parseRegistry(storage, now);
    registry.flows[flow.flowId] = { flow: serializable, tabId: text(tabId, 96), expiresAt: now + FLOW_TTL_MS, restoreLease: registry.flows[flow.flowId]?.restoreLease || null };
    const ordered = Object.entries(registry.flows).sort((a, b) => Number(b[1].flow.updatedAt) - Number(a[1].flow.updatedAt)).slice(0, MAX_FLOWS);
    registry.flows = Object.fromEntries(ordered);
    registry.revision += 1;
    persistRegistry(storage, registry);
    sessionStorage?.setItem?.(CARD_COMMISSIONING_ACTIVE_KEY, flow.flowId);
    notify(serializable);
    return true;
  } finally { unlock(); }
}

export function readCardCommissioning(options = {}) {
  return inspectCardCommissioning(options).flow;
}

export function claimCardRestoration(flow, { storage = defaultStorage(), sessionStorage = defaultSessionStorage(), ownerId = makeFlowId(), now = Date.now() } = {}) {
  requireFlow(flow);
  let unlock;
  try { unlock = acquireRegistryLock(storage, now); } catch { return { ok: false, reason: 'restore-in-progress' }; }
  try {
  const { registry } = parseRegistry(storage, now);
  const entry = registry.flows[flow.flowId];
  if (!entry || entry.flow.project.fingerprint !== flow.project.fingerprint || entry.flow.expectedCard?.id !== flow.expectedCard?.id) return { ok: false, reason: 'missing-flow' };
  if (entry.restoreLease && Number(entry.restoreLease.expiresAt) > now) return { ok: false, reason: 'restore-in-progress' };
  const lease = { id: ownerId, flowId: flow.flowId, cardId: flow.expectedCard.id, projectFingerprint: flow.project.fingerprint, expiresAt: now + RESTORE_LEASE_MS };
  entry.restoreLease = lease;
  registry.revision += 1;
  persistRegistry(storage, registry);
  sessionStorage?.setItem?.(CARD_COMMISSIONING_ACTIVE_KEY, flow.flowId);
  const verified = parseRegistry(storage, now).registry.flows[flow.flowId]?.restoreLease;
  return verified?.id === ownerId ? { ok: true, lease } : { ok: false, reason: 'restore-in-progress' };
  } finally { unlock(); }
}

export function releaseCardRestoration(flowId, leaseId, { storage = defaultStorage(), now = Date.now() } = {}) {
  const unlock = acquireRegistryLock(storage, now);
  try {
  const { registry } = parseRegistry(storage, now);
  const entry = registry.flows[text(flowId, 96)];
  if (!entry?.restoreLease || entry.restoreLease.id !== leaseId) return false;
  entry.restoreLease = null;
  registry.revision += 1;
  persistRegistry(storage, registry);
  return true;
  } finally { unlock(); }
}

export function clearCardCommissioning({ storage = defaultStorage(), sessionStorage = defaultSessionStorage(), flowId } = {}) {
  if (!storage?.removeItem) return false;
  const unlock = acquireRegistryLock(storage);
  try {
  const id = activeFlowId(sessionStorage, flowId);
  const { registry } = parseRegistry(storage);
  if (id) delete registry.flows[id];
  registry.revision += 1;
  persistRegistry(storage, registry);
  sessionStorage?.removeItem?.(CARD_COMMISSIONING_ACTIVE_KEY);
  notify(null);
  return true;
  } finally { unlock(); }
}
