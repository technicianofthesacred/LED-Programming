// One projection of "what may this screen do with the card right now".
//
// Three gates existed, computed inline where each was needed: the COMMAND gate
// (isCardLinkConnected — closes during a WiFi reassociation, guards config,
// wiring, and credential writes), the PLAYBACK gate (lw-pattern's
// patternCardAccess — deliberately looser, because a lit matching card keeps
// serving patterns, brightness, and scenes while its radio reassociates), and
// the INSTALL verdict (readCardAccessLevel — upgrades a 'project' mismatch to
// 'bench' when the card is holding Studio's own discovery config). This module
// is a verbatim extraction of those three, so screens consume one derived
// object instead of re-deriving the trio with slightly different inputs.
//
// ZERO new semantics live here. The playback branch is byte-equivalent to the
// patternCardAccess memo it replaced in lw-pattern.jsx; do not tighten it —
// its looseness is the feature (see the WiFi-transition comments below).

import { classifyCardReadiness } from './cardReadiness.js';
import { isCardLinkConnected, isCardLinkPlaybackReady } from './cardConnectionFlow.js';
import { readCardAccessLevel } from './cardInstallGate.js';

/**
 * @param {object} link  The ambient card link (cardLink).
 * @param {object} [opts]
 * @param {boolean} [opts.connected]  The command gate as the caller already
 *   knows it (the shell passes isCardLinkConnected(cardLink) down as the
 *   `connected` prop). Defaults to deriving it from the link.
 * @param {boolean} [opts.authorized]  Whether a current card-edit authorization
 *   binds this project to the card (lw-pattern's projectAuthorizationCurrent).
 *   Without it, a playback-ready card is demoted to 'project' before the
 *   install upgrade runs — exactly the pre-extraction behaviour.
 * @param {Array} [opts.projectEvidence]  The card's own project evidence for
 *   readCardAccessLevel's bench upgrade. Defaults to [link.readiness].
 * @returns {{ command: boolean, playback: string, install: string }}
 *   command  — the strict gate for config/wiring/credential writes.
 *   playback — 'ready' | 'blank' | 'recovery'; stays 'ready' through a WiFi
 *              reassociation on a lit, exact-paired card.
 *   install  — playback run through the authorization demotion and
 *              readCardAccessLevel's bench upgrade ('ready' | 'bench' |
 *              'blank' | 'project' | 'recovery').
 */
export function deriveCardAccess(link, {
  connected = isCardLinkConnected(link || {}),
  authorized = true,
  projectEvidence,
} = {}) {
  const playback = derivePlaybackAccess(link, connected);
  const evidence = projectEvidence === undefined ? [link?.readiness] : projectEvidence;
  const install = readCardAccessLevel(
    playback === 'ready' && !authorized ? 'project' : playback,
    ...evidence,
  );
  return { command: connected, playback, install };
}

// Verbatim from lw-pattern.jsx's patternCardAccess memo (phase 6 extraction).
function derivePlaybackAccess(link, connected) {
  const expectedCard = link?.expectedCard || null;
  const readiness = classifyCardReadiness(link?.readiness || {}, { expectedCard });
  const expectedCardId = String(expectedCard?.id || expectedCard?.cardId || '').trim().toLowerCase();
  const exactPair = Boolean(expectedCardId) && readiness.cardId.toLowerCase() === expectedCardId;
  if (!exactPair) return 'recovery';
  // Playback access, not command access: this gate only covers patterns,
  // brightness, and scenes, which the card keeps serving across a WiFi
  // transition. Installs re-check the command gate themselves.
  if (readiness.playbackAccess === 'blank') return 'blank';
  // `connected` is the command gate (isCardLinkConnected), which closes
  // during a WiFi transition. Use its playback sibling so a lit, matching
  // card does not lose pattern control while the radio reassociates.
  const playbackLinkReady = isCardLinkPlaybackReady(link || {}, { expectedCard })
    && !link?.cardBlank;
  return readiness.playbackAccess === 'ready' && (connected || playbackLinkReady) ? 'ready' : 'recovery';
}
