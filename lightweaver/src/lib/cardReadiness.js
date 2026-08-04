export const CARD_READINESS_CONTRACT_VERSION = 1;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function explicitBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function hasBoundedText(value, maxLength) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength;
}

export function normalizeCardReadiness(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const app = cleanText(source.app, 32);
  const cardId = cleanText(source.cardId ?? source.id, 64);
  const firmwareVersion = cleanText(source.firmwareVersion, 48);
  const buildId = cleanText(source.buildId, 96);
  const bootId = cleanText(source.bootId, 96);
  const runtimePhase = cleanText(source.runtimePhase, 32).toLowerCase();
  const mode = cleanText(source.mode, 32).toLowerCase();
  const runtimeSource = cleanText(source.source ?? source.runtimeSource, 32).toLowerCase();
  const projectId = cleanText(source.projectId ?? source.piece?.id, 128);
  const projectFingerprint = cleanText(source.projectFingerprint, 64).toLowerCase();
  const contractVersion = Number.isSafeInteger(source.provisioningContractVersion)
    ? source.provisioningContractVersion
    : null;
  const contractSupported = contractVersion === CARD_READINESS_CONTRACT_VERSION;
  const rawCardId = source.cardId ?? source.id;
  const identityValid = app === 'Lightweaver'
    && hasBoundedText(rawCardId, 64)
    && /^lw-[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(cardId)
    && hasBoundedText(source.firmwareVersion, 48)
    && hasBoundedText(source.buildId, 96);
  const commandReady = explicitBoolean(source.commandReady);
  const playbackReady = explicitBoolean(source.playbackReady) ?? commandReady;
  const mutationReady = explicitBoolean(source.mutationReady) ?? commandReady;

  return Object.freeze({
    app,
    provisioningContractVersion: contractVersion,
    contractVersion,
    contractSupported,
    identityValid,
    cardId,
    firmwareVersion,
    buildId,
    bootId,
    runtimePhase,
    mode,
    source: runtimeSource,
    projectId,
    projectFingerprint,
    knownGoodProject: explicitBoolean(source.knownGoodProject),
    commandReady,
    playbackReady,
    mutationReady,
    outputReady: explicitBoolean(source.outputReady),
  });
}

function classifiedResult(state, normalized, reason, additions = {}) {
  // Playback evidence is meaningful only after the contract, identity, full
  // envelope, and boot checks have succeeded. A checking, mismatched, or
  // boot-changed envelope must never unlock card patterns even if its raw
  // playbackReady bit is true.
  const playbackAccess = (state === 'connected' || state === 'not-ready')
    && normalized.knownGoodProject === true
    && normalized.outputReady === true
    && normalized.playbackReady === true;
  return Object.freeze({
    ...normalized,
    state,
    patternAccess: state === 'blank' ? 'blank' : playbackAccess ? 'ready' : 'recovery',
    connected: false,
    blank: null,
    reason,
    ...additions,
  });
}

export function classifyCardReadiness(raw = {}, {
  expectedCardId = '',
  expectedCard = null,
  previousBootId = '',
} = {}) {
  const normalized = normalizeCardReadiness(raw);
  if (!normalized.contractSupported) {
    return classifiedResult('checking', normalized, 'unsupported-contract');
  }
  if (!normalized.identityValid) {
    return classifiedResult('checking', normalized, 'identity-invalid');
  }
  if (
    normalized.knownGoodProject === null
    || normalized.commandReady === null
    || normalized.outputReady === null
    || !normalized.bootId
  ) {
    return classifiedResult('checking', normalized, 'evidence-incomplete');
  }
  const expected = cleanText(expectedCard?.id ?? expectedCard?.cardId ?? expectedCardId, 64);
  if (expected && normalized.cardId !== expected) {
    return classifiedResult('identity-mismatch', normalized, 'unexpected-card', {
      blank: null,
    });
  }
  const expectedFirmwareVersion = cleanText(expectedCard?.firmwareVersion, 48);
  if (expectedFirmwareVersion && normalized.firmwareVersion !== expectedFirmwareVersion) {
    return classifiedResult('identity-mismatch', normalized, 'unexpected-firmware-version');
  }
  const expectedBuildId = cleanText(expectedCard?.buildId, 96);
  if (expectedBuildId && normalized.buildId !== expectedBuildId) {
    return classifiedResult('identity-mismatch', normalized, 'unexpected-firmware-build');
  }
  if (
    normalized.knownGoodProject === false
    && !normalized.projectId
    && !normalized.projectFingerprint
    && (normalized.mode === 'factory-flash' || normalized.source === 'defaults')
  ) {
    return classifiedResult('blank', normalized, 'factory', { blank: true });
  }
  const previousBoot = cleanText(previousBootId, 96);
  if (previousBoot && normalized.bootId !== previousBoot) {
    return classifiedResult('revalidating', normalized, 'boot-changed', { blank: false });
  }
  if (
    normalized.runtimePhase !== 'ready'
    || normalized.knownGoodProject !== true
    || !normalized.commandReady
    || !normalized.outputReady
  ) {
    return classifiedResult('not-ready', normalized, 'runtime-not-ready', { blank: false });
  }
  return classifiedResult('connected', normalized, '', { connected: true, blank: false });
}
