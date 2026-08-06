// The blank-card port probe: "click port 18, and if a strip is on 18 it lights."
//
// A freshly flashed card runs nothing but the factory beacon, which sweeps its
// ports on a timer. That answers "is this card alive" but not "which port is my
// strip on" — the owner has to wait for their port to come round and trust they
// read the timing right. This lets Studio point the beacon at ONE named port and
// hold it there, so the question becomes a click and a look.
//
// Three facts make this need no config and no reboot, and they are the whole
// reason this module is thin:
//   1. setupFactoryBeaconOutputs already registers a FastLED controller for
//      EVERY approved GPIO a control has not claimed. All the ports are bound
//      before Studio says anything.
//   2. handleLightweaverWeb() runs before the beacon's early return in loop(),
//      so the HTTP API is live on a card with no project at all.
//   3. Pinning only changes which already-bound slice the beacon frame fills.
//
// So the card is not being asked to do something new — it is being asked to
// stop choosing the port by the clock.
//
// LIMIT, and it is the card's, not ours: a pinned port lights the beacon's
// bench-safe 8 pixels at low brightness under a 100mA cap. The card does not yet
// know the strip length or the supply, so it will not drive hard into an unknown
// load. That is enough to answer "is something plugged in here", which is the
// question this screen asks. Full-length lighting comes after the bench config
// lands and the ordinary frame path takes over.

import { sendCardBridgeRequest } from './cardBridge.js';
import { canPushDirectlyToCard, cardHostToUrl } from './cardConnection.js';
import { guardDirectCardMutation } from './cardIdentity.js';

// The firmware releases a pin on its own after LW_FACTORY_BEACON_PIN_HOLD_MS so
// a closed tab cannot leave the card parked on one port looking like a fault.
// Studio re-asserts well inside that window while the grid is open. Kept
// comfortably under the firmware's hold rather than equal to it: a renewal that
// races the expiry would drop the card back to sweeping mid-inspection, which
// reads to the owner as "the light moved, so this is the wrong port".
export const BEACON_PIN_RENEW_MS = 6000;

function requestTimeout() {
  return 4000;
}

async function directBeacon(host, { method = 'GET', body = null } = {}) {
  // A probe lights real LEDs, so it carries the same identity guard as any other
  // direct card mutation: a mis-targeted probe would light a stranger's piece.
  if (method !== 'GET') await guardDirectCardMutation(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout());
  try {
    const response = await fetch(`${cardHostToUrl(host)}/api/beacon/port`, {
      method,
      cache: 'no-store',
      signal: controller.signal,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return await response.json().catch(() => ({ ok: false }));
  } finally {
    clearTimeout(timer);
  }
}

function normalizePorts(payload) {
  const ports = Array.isArray(payload?.ports) ? payload.ports : [];
  return Object.freeze({
    // `available` false means the card is not in beacon mode — it already has a
    // project, so the grid does not apply and Studio should not render one.
    available: payload?.available === true,
    ports: Object.freeze(ports.filter(pin => Number.isSafeInteger(pin) && pin >= 0 && pin <= 255)),
    pixelsPerPort: Number.isSafeInteger(payload?.pixelsPerPort) ? payload.pixelsPerPort : 0,
  });
}

/**
 * Which ports this card can light right now.
 *
 * Read from the CARD rather than from Studio's own hardware contract, because
 * the two legitimately disagree: a control pin claims its GPIO, and the control
 * assignment lives in the card's config. Rendering the contract's list would
 * offer buttons for ports this particular card cannot drive.
 */
export async function readBeaconPorts(host, { bridgeVersion = 0 } = {}) {
  if (canPushDirectlyToCard()) return normalizePorts(await directBeacon(host));
  // Feature-detected: the relay type landed in bridge v4. On an older card the
  // grid simply does not appear, and the sweep remains the only signal.
  if (bridgeVersion < 4) return normalizePorts(null);
  return normalizePorts(await sendCardBridgeRequest('beacon-ports', {}, { host, timeoutMs: requestTimeout() }));
}

/**
 * Light one port and hold it. Resolves { ok, litPixels } — ok false means this
 * card cannot drive that GPIO, which is a real answer worth showing (the port is
 * claimed by a control), not an error to retry.
 */
export async function pinBeaconPort(host, gpio, { bridgeVersion = 0 } = {}) {
  const payload = { gpio };
  const response = canPushDirectlyToCard()
    ? await directBeacon(host, { method: 'POST', body: payload })
    : bridgeVersion < 4
      ? { ok: false }
      : await sendCardBridgeRequest('beacon-port', payload, { host, timeoutMs: requestTimeout() });
  return Object.freeze({
    ok: response?.ok === true && response?.pinned === true,
    litPixels: Number.isSafeInteger(response?.litPixels) ? response.litPixels : 0,
  });
}

/**
 * Hand the card back to sweeping. Called when the grid closes or the owner
 * deselects, so a card that nobody is looking at returns to advertising itself
 * immediately rather than waiting out the firmware's hold.
 *
 * Failure is deliberately swallowed: the firmware pin lapses on its own, so a
 * missed release costs at most one hold window and must never surface as an
 * error while the owner is walking away.
 */
export async function releaseBeaconPort(host, { bridgeVersion = 0 } = {}) {
  try {
    if (canPushDirectlyToCard()) {
      await directBeacon(host, { method: 'POST', body: { release: true } });
      return true;
    }
    if (bridgeVersion < 4) return false;
    await sendCardBridgeRequest('beacon-port', { release: true }, { host, timeoutMs: requestTimeout() });
    return true;
  } catch {
    return false;
  }
}
