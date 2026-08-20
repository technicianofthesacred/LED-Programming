// One shared wrapper for every "Recover lights" action in Studio.
//
// Four surfaces send the safe recovery frame (Card overview, Patterns' LED
// repair, Playlist's physical recovery, and the light-check overlay). They
// used to call recoverCardLights directly with four hand-rolled copies of the
// surrounding ceremony; the card-overview variant additionally proved the
// card came back with an exact ready-state readback. This module carries the
// send plus that optional readback verifier, while every screen keeps its own
// payload, timing, and user-facing copy — those genuinely differ per surface
// (brightness, restart behavior, and the bench-card honesty message most of
// all).
import { recoverCardLights } from './cardLiveControl.js';
import { readCardStatusEnvelope } from './cardPushClient.js';

// Lifted verbatim from the card overview's readback verifier: the recovery is
// only proven when the EXPECTED card answers and reports a fully ready
// runtime with LED output up. Anything less throws, so a screen can never
// report "recovered" off a different card or a half-booted one.
export function requireExactReadyCardStatus(status, expectedCardId) {
  const expected = String(expectedCardId || '').trim();
  if (!status || status.cardId !== expected) throw new Error('A different card answered the hardware check. Reconnect the expected card.');
  if (status.runtimePhase !== 'ready' || status.knownGoodProject !== true || status.commandReady !== true || status.outputReady !== true) {
    throw new Error('The card answered, but its runtime or LED output is not ready. Open support before retrying.');
  }
  return status;
}

/**
 * Send the recovery frame, optionally proving the exact card's ready state
 * afterwards.
 *
 * @param {object} look     Passed through to recoverCardLights unchanged.
 * @param {object} options  recoverCardLights options (host, timeoutMs,
 *   restartCard, transport, …) plus:
 *   - verifyReadback: { expectedCardId } — after the recovery send, read the
 *     status envelope from the same host and require an exact ready answer
 *     from that card id. Omitted = send-only, exactly the old direct call.
 *   - recoverImpl / readStatusImpl — test seams.
 * @returns the recoverCardLights response (so callers can keep reading
 *   `response.restarted`).
 */
export async function recoverCardLightsVerified(look = {}, options = {}) {
  const {
    verifyReadback = null,
    recoverImpl = recoverCardLights,
    readStatusImpl = readCardStatusEnvelope,
    ...recoverOptions
  } = options;
  const response = await recoverImpl(look, recoverOptions);
  if (verifyReadback) {
    requireExactReadyCardStatus(
      await readStatusImpl({ host: recoverOptions.host }),
      verifyReadback.expectedCardId,
    );
  }
  return response;
}
