// "Join the card's setup network" is an instruction the owner cannot obey the
// moment they read it, and Studio used to state it as if they could. The card
// raises its soft AP a second or two after boot (`startApMode()` runs before
// anything else), but the phone or laptop being asked to find it only refreshes
// its Wi-Fi scan every so often — commonly 15-30 s, and longer on a screen that
// is already showing a cached list. So there is a real window where the network
// is broadcasting and simply is not in the picker yet.
//
// Left unsaid, that window reads as failure: the owner looks, does not find the
// network, and concludes the card is broken or the instructions are wrong. This
// module is the software answer to that — Studio tracks how long the card has
// actually been broadcasting and says which of three things is true right now,
// instead of printing one static sentence that is wrong for the first half
// minute of its own life.
//
// A browser cannot enumerate Wi-Fi networks, so elapsed time is the honest
// maximum we can know. The phases are deliberately conservative: we would
// rather say "still coming" for a few extra seconds than tell someone to start
// troubleshooting a card that is working.

// The card is broadcasting almost immediately; this covers boot plus one
// typical client scan cycle. Before it elapses, "I can't see it" is expected.
export const SETUP_HOTSPOT_BROADCAST_MS = 25_000;
// Past this, every device that was going to notice on its own has had two scan
// cycles to do it. A missing network now means a stale list or no hotspot at
// all — both of which have actions attached, so stop waiting and offer them.
export const SETUP_HOTSPOT_RESCAN_MS = 60_000;

export const SETUP_HOTSPOT_PHASES = Object.freeze(['appearing', 'listed', 'overdue']);

function elapsedSince(startedAt, now) {
  const start = Number(startedAt);
  const at = Number(now);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(at)) return null;
  // A flow written on another device, or a clock that stepped backwards, must
  // not produce a countdown that grows. Treat "before the start" as "just now".
  return Math.max(0, at - start);
}

/**
 * Describe what the owner should currently believe about the card's setup
 * hotspot, given when the card started broadcasting it.
 *
 * - `appearing` the network is up but this device may not have scanned yet.
 *               `secondsRemaining` counts down the expected wait.
 * - `listed`    enough time has passed that it should be in the Wi-Fi list.
 * - `overdue`   it should have shown up and has not; the causes are knowable
 *               (stale scan list, or no hotspot because the card kept its
 *               Wi-Fi) and the caller should offer both escapes.
 *
 * `startedAt` unknown degrades to `listed`: we will not invent a countdown, and
 * "it should be there, here is what to do if it isn't" is true regardless.
 */
export function describeSetupHotspotWait({ startedAt, now = Date.now(), label = '' } = {}) {
  const network = String(label || '').trim() || 'the card’s setup network';
  const elapsed = elapsedSince(startedAt, now);
  const phase = elapsed === null
    ? 'listed'
    : elapsed < SETUP_HOTSPOT_BROADCAST_MS
      ? 'appearing'
      : elapsed < SETUP_HOTSPOT_RESCAN_MS ? 'listed' : 'overdue';
  const secondsRemaining = phase === 'appearing'
    ? Math.max(1, Math.ceil((SETUP_HOTSPOT_BROADCAST_MS - elapsed) / 1000))
    : 0;

  if (phase === 'appearing') {
    return {
      phase,
      secondsRemaining,
      headline: `Give the card about ${secondsRemaining} more ${secondsRemaining === 1 ? 'second' : 'seconds'} — ${network} may not be in this device’s Wi-Fi list yet.`,
      detail: 'The card starts broadcasting within a couple of seconds of powering up, but phones and laptops only rescan for new networks every so often. Not seeing it the instant you look is normal.',
    };
  }
  if (phase === 'listed') {
    return {
      phase,
      secondsRemaining,
      headline: `Open this device’s Wi-Fi settings and join ${network}.`,
      detail: 'The card has been broadcasting long enough for this device to have found it. The setup address only answers while that network is joined.',
    };
  }
  return {
    phase,
    secondsRemaining,
    headline: `Still cannot see ${network}?`,
    detail: 'Turn this device’s Wi-Fi off and back on — that forces a fresh scan, and a stale list is the usual reason a network that is broadcasting does not appear. If it is still missing, the card most likely kept the Wi-Fi it already had, so there is no hotspot to join and it is already on your network.',
  };
}
