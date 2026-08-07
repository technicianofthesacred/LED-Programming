// What installing will actually DO to the card in front of you.
//
// The install screen used to state only the firmware it was about to write. That
// answers "what is this?" but not the question an owner is really asking, which
// is "am I changing anything, and in which direction?" — and installing is never
// free: it wipes the card's Wi-Fi, its piece and its settings every time, even
// when the firmware being written is the one already on it.
//
// Both numbers are the same quantity: the card compiles in LW_BUILD_NUMBER and
// the signed manifest carries buildNumber, each the commit count of the same
// build lineage. So they compare as plain integers. A 0 or missing number means
// the card predates numbered builds, and then only "is it the same build id"
// can honestly be answered.
//
// The one rule: never imply knowledge that is not there. A card this browser has
// never met has an UNKNOWN current firmware, and the screen must say so rather
// than quietly showing only the target and letting it read as the answer.

function buildNumberOf(source) {
  const value = Number(source?.buildNumber);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function buildIdOf(source) {
  return String(source?.buildId || '').trim().toLowerCase();
}

function versionOf(source) {
  return String(source?.firmwareVersion || '').trim();
}

/**
 * A short label for one firmware: "Build 1092", or the short revision when the
 * build predates numbered builds, or '' when nothing is known.
 */
export function firmwareLabel(source) {
  const number = buildNumberOf(source);
  if (number) return `Build ${number}`;
  const buildId = buildIdOf(source);
  return buildId ? `Build ${buildId.slice(0, 12)}` : '';
}

/**
 * Compare what the card is running with what is about to be installed.
 *
 *   state: 'unknown'  — this browser has never heard from this card
 *          'same'     — the card is already running this exact build
 *          'update'   — the available build is newer
 *          'downgrade'— the available build is older than the card's
 *          'sideways' — both known, neither number comparable, ids differ
 *
 * `installedLabel` / `availableLabel` are ready to print. `headline` is the one
 * sentence the install screen shows; `caution` is the part that must not be
 * lost — installing erases the card whichever direction it goes.
 */
export function describeFirmwareUpdate({ installed = null, available = null } = {}) {
  const availableLabel = firmwareLabel(available);
  const installedLabel = firmwareLabel(installed);
  const availableVersion = versionOf(available);
  const caution = 'Either way this erases the card\'s Wi-Fi, its piece and its settings.';

  if (!availableLabel) {
    return { state: 'unknown', installedLabel: '', availableLabel: '', headline: '', caution };
  }
  const target = availableVersion ? `${availableVersion} · ${availableLabel}` : availableLabel;

  if (!installedLabel) {
    return {
      state: 'unknown',
      installedLabel: '',
      availableLabel,
      headline: `This card has not been connected to Studio before, so what it is running now is unknown. This installs ${target}.`,
      caution,
    };
  }

  const installedNumber = buildNumberOf(installed);
  const availableNumber = buildNumberOf(available);
  const sameId = buildIdOf(installed) && buildIdOf(installed) === buildIdOf(available);

  if (sameId || (installedNumber && installedNumber === availableNumber)) {
    return {
      state: 'same',
      installedLabel,
      availableLabel,
      headline: `This card is already on ${target}. Installing again changes nothing about the firmware.`,
      caution,
    };
  }
  if (installedNumber && availableNumber) {
    const newer = availableNumber > installedNumber;
    return {
      state: newer ? 'update' : 'downgrade',
      installedLabel,
      availableLabel,
      headline: newer
        ? `This card is on ${installedLabel}. This updates it to ${target}.`
        : `This card is on ${installedLabel}, which is NEWER than the ${availableLabel} available here. Installing takes it backwards.`,
      caution,
    };
  }
  // One side has no number to compare — say what changes without claiming a
  // direction that cannot be proven.
  return {
    state: 'sideways',
    installedLabel,
    availableLabel,
    headline: `This card is on ${installedLabel}. This replaces it with ${target}.`,
    caution,
  };
}

/**
 * Pick the most trustworthy account of what the card is running.
 *
 * A live link beats a remembered one, and a remembered identity only counts when
 * it is the SAME card that is plugged in — otherwise the screen would report the
 * last card's firmware for the one on the desk, which is worse than saying
 * nothing. `hardware.cardId` comes from the USB inspection.
 */
export function resolveInstalledFirmware({ linkedCard = null, rememberedCard = null, hardware = null } = {}) {
  const plugged = String(hardware?.cardId || '').trim().toLowerCase();
  const matches = (candidate) => {
    if (!candidate || !firmwareLabel(candidate)) return false;
    if (!plugged) return true;
    const id = String(candidate.id || candidate.cardId || '').trim().toLowerCase();
    return !id || id === plugged;
  };
  if (matches(linkedCard)) return linkedCard;
  if (matches(rememberedCard)) return rememberedCard;
  return null;
}
