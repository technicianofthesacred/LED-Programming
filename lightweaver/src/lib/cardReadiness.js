export const CARD_READINESS_CONTRACT_VERSION = 1;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function explicitBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

export function normalizeCardReadiness(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const app = cleanText(source.app, 32);
  const cardId = cleanText(source.cardId ?? source.id, 64);
  const firmwareVersion = cleanText(source.firmwareVersion, 48);
  const buildId = cleanText(source.buildId, 96);
  const bootId = cleanText(source.bootId, 96);
  const runtimePhase = cleanText(source.runtimePhase, 32).toLowerCase();
  const contractVersion = Number.isSafeInteger(source.provisioningContractVersion)
    ? source.provisioningContractVersion
    : null;
  const contractSupported = contractVersion === CARD_READINESS_CONTRACT_VERSION;
  const identityValid = app === 'Lightweaver'
    && /^lw-[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(cardId)
    && cardId.length <= 64
    && Boolean(firmwareVersion)
    && Boolean(buildId);

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
    knownGoodProject: explicitBoolean(source.knownGoodProject),
    commandReady: explicitBoolean(source.commandReady),
    outputReady: explicitBoolean(source.outputReady),
  });
}

function classifiedResult(state, normalized, reason, additions = {}) {
  return Object.freeze({
    ...normalized,
    state,
    connected: false,
    blank: null,
    reason,
    ...additions,
  });
}

export function classifyCardReadiness(raw = {}, {
  expectedCardId = '',
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
  const expected = cleanText(expectedCardId, 64);
  if (expected && normalized.cardId !== expected) {
    return classifiedResult('identity-mismatch', normalized, 'unexpected-card', {
      blank: !normalized.knownGoodProject || normalized.runtimePhase === 'factory',
    });
  }
  if (!normalized.knownGoodProject || normalized.runtimePhase === 'factory') {
    return classifiedResult('blank', normalized, 'factory', { blank: true });
  }
  const previousBoot = cleanText(previousBootId, 96);
  if (previousBoot && normalized.bootId !== previousBoot) {
    return classifiedResult('revalidating', normalized, 'boot-changed', { blank: false });
  }
  if (
    normalized.runtimePhase !== 'ready'
    || !normalized.commandReady
    || !normalized.outputReady
  ) {
    return classifiedResult('not-ready', normalized, 'runtime-not-ready', { blank: false });
  }
  return classifiedResult('connected', normalized, '', { connected: true, blank: false });
}
