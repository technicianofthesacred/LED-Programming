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
    commandReady: explicitBoolean(source.commandReady),
    // Reported separately from `commandReady` by the firmware. Playback is
    // entirely on-card, so it stays admitted while the radio reassociates.
    // Firmware from before that split omits the field, which normalizes to
    // null and means "no separate claim" — never "not ready".
    playbackReady: explicitBoolean(source.playbackReady),
    outputReady: explicitBoolean(source.outputReady),
  });
}

function classifiedResult(state, normalized, reason, additions = {}) {
  const patternAccess = state === 'connected' ? 'ready' : state === 'blank' ? 'blank' : 'recovery';
  return Object.freeze({
    ...normalized,
    state,
    patternAccess,
    // Defaults to the command gate. Only the two terminal branches below —
    // reached after every contract, identity, blank, and boot check has
    // passed — may widen it, so an unexpected or unproven card is never
    // admitted for playback either.
    playbackAccess: patternAccess,
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
  // Patterns, brightness, and scenes run entirely on-card, so the firmware
  // admits them through `playbackReady` rather than `commandReady`. While the
  // radio reassociates, a lit and healthy card reports commandReady=false and
  // runtimePhase='recovering' (both fold in the WiFi transition) but keeps
  // playbackReady=true — and its own /json/state, /api/control, frame, and
  // recover-lights handlers keep answering off exactly that flag. So the
  // command gate below still governs config, wiring, and credential writes,
  // while playback follows the card's separate claim.
  //
  // playbackReady=true already implies configValid, knownGoodProject,
  // outputReady, a serving web stack, and no local transition, so it is a
  // complete statement and needs no extra conditions here. Firmware without
  // the field reports null and falls through to the command gate unchanged.
  if (
    normalized.runtimePhase !== 'ready'
    || normalized.knownGoodProject !== true
    || !normalized.commandReady
    || !normalized.outputReady
  ) {
    return classifiedResult('not-ready', normalized, 'runtime-not-ready', {
      blank: false,
      ...(normalized.playbackReady === true ? { playbackAccess: 'ready' } : {}),
    });
  }
  return classifiedResult('connected', normalized, '', {
    connected: true,
    blank: false,
    // Never wider than the command gate: an explicit playback refusal still
    // stops playback even when the command gate is open.
    ...(normalized.playbackReady === false ? { playbackAccess: 'recovery' } : {}),
  });
}
