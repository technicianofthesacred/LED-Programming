import { isBenchProjectEvidence } from './benchConfig.js';
import { normalizeUsbLedColorOrder } from './usbLedColorOrder.js';

// One rule for every "Install on card" button.
//
// All three of them (Layout -> Test & Install, Playlist, Patterns) end at the
// same place: pushConfigToCard -> POST /api/config. They used to carry three
// unrelated preconditions, so the same destination was reachable under three
// different amounts of proof. This module holds the single precondition; each
// screen supplies the facts it actually knows and reads the verdict.
//
// The safety-bearing part is `wiringAffecting`. An install that can rewrite
// the physical output layout must not go out without a bench test on the real
// LEDs and a confirmed colour order. Installs that cannot change wiring (the
// card refuses a layout change unless the caller passes allowLayoutChange)
// only need the ordinary preconditions.

export const CARD_INSTALL_BLOCK_MESSAGES = Object.freeze({
  'hardware-issue': 'Fix the hardware setup before installing on the card.',
  busy: 'An install is already running on this card.',
  'wiring-incomplete': 'Every strip needs a GPIO and a place in the first-to-last wiring order before this can be installed.',
  'not-commissioned': 'Run the LED check and confirm the colour order before installing a wiring change.',
  blank: 'This card has no project yet. Set up its LED strips, then install this Studio project.',
  'project-mismatch': 'Open Hardware and verify that this exact Studio project is still installed on this card.',
  disconnected: 'Connect the Lightweaver card first.',
});

// Commissioning proof: the wiring was checked against the real LEDs, and the
// colour order that was confirmed is still the colour order being sent. Both
// halves matter — a confirmed order for a different colour order proves
// nothing about what will light up.
export function readCardCommissioningVerification({ wiring, standaloneController } = {}) {
  const runs = Array.isArray(wiring?.runs) ? wiring.runs : [];
  const physicallyVerified = Boolean(wiring?.verified && runs.every(run => run?.verified));
  const colorOrder = normalizeUsbLedColorOrder(standaloneController?.led?.colorOrder || 'RGB');
  const colorConfirmed = Boolean(
    standaloneController?.led?.colorOrderConfirmed
    && normalizeUsbLedColorOrder(standaloneController?.led?.confirmedColorOrder || '') === colorOrder
  );
  return Object.freeze({
    physicallyVerified,
    colorConfirmed,
    verified: physicallyVerified && colorConfirmed,
  });
}

// The one producer of cardAccess:'bench'. Screens compute their own access
// verdict from the link, then run it through here so "the card is holding
// Studio's own discovery config" is decided from the CARD'S report in exactly
// one place.
//
// 'project' is deliberately upgradeable. That verdict means "this may not be
// the Studio project you think is installed", and it exists to stop an install
// clobbering somebody's artwork — but the bench config IS Studio's own
// scaffolding, and overwriting it with the owner's real project is the only way
// out of discovery. Link-state verdicts ('blank', 'recovery') are never
// upgraded: they describe whether the card is reachable and paired, which no
// amount of project evidence can prove.
export function readCardAccessLevel(cardAccess, ...projectEvidence) {
  if (cardAccess !== 'ready' && cardAccess !== 'project') return cardAccess;
  return projectEvidence.some(isBenchProjectEvidence) ? 'bench' : cardAccess;
}

function blocked(reason) {
  return Object.freeze({
    allowed: false,
    reason,
    message: CARD_INSTALL_BLOCK_MESSAGES[reason] || '',
  });
}

const ALLOWED = Object.freeze({ allowed: true, reason: '', message: '' });

/**
 * @param {object} input
 * @param {string} input.hardwareIssue   Non-empty when the runtime package cannot be built.
 * @param {boolean} input.busy           An install/sync/recovery is already in flight.
 * @param {'ready'|'bench'|'blank'|'project'|'recovery'|string} input.cardAccess
 *   'bench' means the card is holding the synthesized discovery bench config
 *   (see benchConfig.js). Callers derive it with readCardAccessLevel above,
 *   from the card's own project evidence.
 * @param {boolean} input.requiresLiveLink
 *   False only for the Layout push, which runs its own discovery and falls back
 *   to a bounded copy-paste/installer handoff for the exact paired card, so it
 *   is worth attempting while the ambient link reads disconnected.
 * @param {boolean} input.wiringAffecting  This install may carry a layout change.
 * @param {boolean} input.wiringSendReady  The compiled wiring is complete enough to send.
 * @param {boolean} input.commissioningVerified  See readCardCommissioningVerification.
 */
export function evaluateCardInstallGate({
  hardwareIssue = '',
  busy = false,
  cardAccess = 'ready',
  requiresLiveLink = true,
  wiringAffecting = false,
  wiringSendReady = true,
  commissioningVerified = false,
} = {}) {
  if (String(hardwareIssue || '').trim()) return blocked('hardware-issue');
  if (busy) return blocked('busy');
  // Checked before the link state so the reason a wiring install is refused is
  // always the missing bench proof, not a transient connection blip.
  if (wiringAffecting && !wiringSendReady) return blocked('wiring-incomplete');
  if (wiringAffecting && !commissioningVerified) return blocked('not-commissioned');
  if (requiresLiveLink) {
    if (cardAccess === 'blank') return blocked('blank');
    if (cardAccess === 'project') return blocked('project-mismatch');
    // A bench card is Ready, but the project on it is Studio's own synthesized
    // discovery config — not an owner's artwork. Installing the real project
    // over it is the intended way OUT of discovery, so it is never refused as a
    // mismatch. 'project-mismatch' stays for genuinely foreign projects, where
    // the warning is about clobbering somebody's work.
    if (!['ready', 'bench'].includes(cardAccess)) return blocked('disconnected');
  }
  return ALLOWED;
}
