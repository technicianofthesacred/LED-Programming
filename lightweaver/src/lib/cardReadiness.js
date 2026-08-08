export const CARD_READINESS_CONTRACT_VERSION = 1;

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function explicitBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function hasBoundedText(value, maxLength) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength;
}

// The one place the installed project id is read out of a card status
// envelope. Both ends of a card-edit authorization must derive it the same
// way: the card screen issues the binding, and Patterns re-derives it to claim
// that binding. They used to read it from different payloads — the card from
// /api/firmware-info, which carries `piece.id`, and Patterns from the status
// envelope, which carries `projectId` and no `piece.id` at all. Firmware only
// began sending `projectId` on /api/status in 2026-08, so against a card
// flashed before that the card issued an authorization Patterns could never
// claim, and the handoff looped instead of opening.
export function installedProjectIdFromCardStatus(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return cleanText(source.projectId ?? source.piece?.id, 128);
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
  const projectId = installedProjectIdFromCardStatus(source);
  const projectFingerprint = cleanText(source.projectFingerprint, 64).toLowerCase();
  const contractVersion = Number.isSafeInteger(source.provisioningContractVersion)
    ? source.provisioningContractVersion
    : null;
  const contractSupported = contractVersion === CARD_READINESS_CONTRACT_VERSION;
  const limits = source.limits && typeof source.limits === 'object' ? source.limits : {};
  // The firmware publishes this as `safeMode` on both /api/status and
  // /api/firmware-info (runtimeSafeModeActive, LightweaverRuntimeApi.h). Cards
  // flashed before that omit it entirely, and their silence must keep
  // classifying exactly as it did — see the note on `safeMode` below.
  const safeModeClaim = source.safeMode;
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
    // The card's OWN pixel ceiling, from the `limits` block both /api/status
    // (LightweaverStorage.cpp) and /api/firmware-info (main.cpp) publish. It is
    // not a constant across the field: a card flashed before LW_MAX_PIXELS was
    // raised still answers 1024, and a config built past what it answers comes
    // back refused. Null when the card did not say, so a caller falls back to
    // its own contract bound instead of quietly adopting this Studio build's
    // ceiling as if the card had claimed it.
    maxPixels: positiveInteger(limits.pixels),
    // True only when the card explicitly says it booted safe defaults because
    // it could not READ a project it still holds (RuntimeLoadResult.safeMode,
    // LightweaverStorage.h — the same state /api/wiring/status already reports
    // as 'safe-mode'). Such a card publishes exactly the absence a freshly
    // erased one does, so this flag is the only thing that tells "nothing to
    // lose" apart from "the owner's artwork is still in NVS, just unread".
    // Absence is not damage: every card in the field today omits the field, and
    // its silence has to keep classifying exactly as it did before.
    safeMode: safeModeClaim === true,
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
  // A safe-mode card still HOLDS the owner's project — the read failed, the
  // stored config did not vanish — but it reports the same absence an erased
  // card does (knownGoodProject false, defaults source, no project identity),
  // so the blank branch below would match it. Blank is the one classification
  // that unlocks strip discovery's one-shot config write, which the firmware
  // exempts from wiring staging precisely because a blank card has no layout to
  // protect. Letting a damaged card through would overwrite stored artwork with
  // the bench sentinel, with no probation and no warning. Recovery is the only
  // honest destination until somebody has looked at it.
  if (normalized.safeMode) {
    return classifiedResult('not-ready', normalized, 'safe-mode', {
      blank: false,
      // Playback is not a write. A card sitting on safe defaults can still be
      // lit, and refusing that would report a card as dead when it is only
      // unread.
      ...(normalized.playbackReady === true ? { playbackAccess: 'ready' } : {}),
    });
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
