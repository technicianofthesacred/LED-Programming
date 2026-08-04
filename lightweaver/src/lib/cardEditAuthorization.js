export const CARD_EDIT_AUTHORIZATION_TTL_MS = 120_000;

const CORE_FIELDS = Object.freeze([
  'cardId',
  'firmwareVersion',
  'buildId',
  'bootId',
  'installedProjectId',
  'installedProjectFingerprint',
  'studioProjectId',
  'studioProjectFingerprint',
  'projectGeneration',
]);

let activeAuthorization = null;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBinding(value = {}) {
  const binding = {
    intent: text(value.intent),
    cardId: text(value.cardId).toLowerCase(),
    firmwareVersion: text(value.firmwareVersion),
    buildId: text(value.buildId),
    bootId: text(value.bootId),
    installedProjectId: text(value.installedProjectId),
    installedProjectFingerprint: text(value.installedProjectFingerprint).toLowerCase(),
    studioProjectId: text(value.studioProjectId),
    studioProjectFingerprint: text(value.studioProjectFingerprint).toLowerCase(),
    projectGeneration: Number(value.projectGeneration),
  };
  const validIntent = binding.intent === '' || /^(?:pattern|look):[^\s:][^\s]*$/.test(binding.intent);
  const validFingerprint = fingerprint => /^[a-f0-9]{16,64}$/.test(fingerprint);
  const valid = validIntent
    && binding.cardId.length > 0
    && binding.firmwareVersion.length > 0
    && binding.buildId.length > 0
    && binding.bootId.length > 0
    && binding.installedProjectId.length > 0
    && validFingerprint(binding.installedProjectFingerprint)
    && binding.studioProjectId.length > 0
    && validFingerprint(binding.studioProjectFingerprint)
    && Number.isSafeInteger(binding.projectGeneration)
    && binding.projectGeneration >= 0;
  return valid ? binding : null;
}

function timestamp(options) {
  return Number.isFinite(options?.now) ? Number(options.now) : Date.now();
}

function hasExactCore(expected, actual) {
  return CORE_FIELDS.every(field => expected[field] === actual[field]);
}

function readCurrent(binding, options) {
  const normalized = normalizeBinding(binding);
  if (!normalized || !activeAuthorization) return null;
  const now = timestamp(options);
  if (now >= activeAuthorization.expiresAt) {
    activeAuthorization = null;
    return null;
  }
  return hasExactCore(activeAuthorization, normalized) ? normalized : null;
}

function rejectAuthorization() {
  activeAuthorization = null;
  return false;
}

function activateAuthorization(normalized, options) {
  if (!normalized) return rejectAuthorization();
  const issuedAt = timestamp(options);
  activeAuthorization = Object.freeze({
    ...normalized,
    issuedAt,
    expiresAt: issuedAt + CARD_EDIT_AUTHORIZATION_TTL_MS,
    intentConsumed: false,
  });
  return true;
}

export function issueCardEditAuthorization(binding, options) {
  const normalized = normalizeBinding(binding);
  if (!normalized
    || normalized.installedProjectId !== normalized.studioProjectId
    || normalized.installedProjectFingerprint !== normalized.studioProjectFingerprint) {
    return rejectAuthorization();
  }
  return activateAuthorization(normalized, options);
}

export function issueSignedProductionCardEditAuthorization(binding, signedProductionProject, options) {
  const normalized = normalizeBinding(binding);
  const signedProjectId = text(signedProductionProject?.projectId);
  const signedProjectFingerprint = text(signedProductionProject?.projectFingerprint).toLowerCase();
  const jobId = text(signedProductionProject?.jobId);
  const jobDigest = text(signedProductionProject?.jobDigest).toLowerCase();
  if (!normalized
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(jobId)
    || !/^[a-f0-9]{64}$/.test(jobDigest)
    || normalized.installedProjectId !== normalized.studioProjectId
    || normalized.installedProjectId !== signedProjectId
    || normalized.installedProjectFingerprint !== signedProjectFingerprint) {
    return rejectAuthorization();
  }
  return activateAuthorization(normalized, options);
}

export function consumeCardEditAuthorization(binding, options) {
  const normalized = readCurrent(binding, options);
  if (!normalized
    || !normalized.intent
    || activeAuthorization.intent !== normalized.intent
    || activeAuthorization.intentConsumed) return false;
  activeAuthorization = Object.freeze({ ...activeAuthorization, intentConsumed: true });
  return true;
}

export function hasCurrentCardProjectAuthorization(binding, options) {
  return Boolean(readCurrent(binding, options));
}

export function currentCardProjectAuthorizationExpiresAt(binding, options) {
  return readCurrent(binding, options) ? activeAuthorization.expiresAt : 0;
}

export function clearCardEditAuthorization() {
  activeAuthorization = null;
}
