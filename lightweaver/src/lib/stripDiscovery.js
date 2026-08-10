// Strip discovery — "what pixels are actually out there?"
//
// The owner's order of operations is: see what pixels exist -> identify which
// strips -> organize them -> put patterns on them. This module is the first
// step, and it is deliberately a pure, serializable state machine so the whole
// sequence can be unit-tested without a card, a browser, or a frame stream.
//
// The card is written exactly ONCE in this flow (the bench config, installed by
// the panel through the initial-config authority). Everything after that is
// live frames, which is why every function here either advances plain session
// state or returns a full logical frame — never performs I/O.
//
// Why the sequence is probe -> decade -> end-marker rather than "type in a
// number": the owner is standing at a physical strip whose length nobody knows.
// The expanding probe finds the right order of magnitude in a handful of taps
// (8 -> 16 -> 32 -> ...), the decade read-off turns the strip itself into a
// ruler so the exact count is read rather than guessed, and the end marker is
// the single yes/no that proves the number is the LAST pixel and not a pixel
// somewhere in the middle.

import { COLOR_ORDERS } from './usbLedColorOrder.js';

// First lit block per port. Small enough that a short strip is obvious at a
// glance, large enough to be visible across a room.
export const DISCOVERY_PROBE_START = 8;

// WS2812B is 800 kbps and 24 bits per pixel = 30 us/pixel, so a chain of about
// 1100 pixels already fills a 30 fps frame period. Past this the refresh rate
// degrades — it does not fail. Owner's standing instruction: warn, never block.
export const DISCOVERY_FRAME_RATE_WARN_PIXELS = 1100;

// Bench brightness is low by design (the bench look is dim warm white and the
// bench config caps current), so these are dim on purpose. They still read as
// four distinct hues on a real strip.
export const DISCOVERY_OFF_COLOR = '000000';
export const DISCOVERY_PROBE_COLOR = '281400'; // warm — "this pixel is lit"
export const DISCOVERY_DECADE_COLOR = '003C00'; // every 10th — green
export const DISCOVERY_FIFTY_COLOR = '00003C'; // every 50th — blue
export const DISCOVERY_HUNDRED_COLOR = '3C0000'; // every 100th — red
export const DISCOVERY_END_MARKER_COLOR = '3C003C'; // the last LED — magenta

export const DISCOVERY_PHASES = Object.freeze([
  'bench-install',
  'probe',
  'decade',
  'end-marker',
  'record',
  'done',
]);

const SESSION_VERSION = 1;

function intOrZero(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function normalizeLayout(benchLayout) {
  if (!Array.isArray(benchLayout)) return [];
  return benchLayout
    .map(entry => ({
      pin: Number(entry?.pin),
      start: Math.max(0, Number(entry?.start) || 0),
      count: intOrZero(entry?.count),
    }))
    .filter(entry => Number.isSafeInteger(entry.pin) && entry.pin >= 0 && entry.count > 0)
    .sort((a, b) => a.start - b.start);
}

// Full logical frames are sized to the bench layout's provisioned total, not to
// the pixels being lit: the card renders one contiguous buffer, so a short
// frame would leave whatever the previous frame wrote on the tail pixels.
export function benchLayoutTotalPixels(benchLayout) {
  return normalizeLayout(benchLayout).reduce((total, entry) => Math.max(total, entry.start + entry.count), 0);
}

function layoutEntry(benchLayout, pin) {
  return normalizeLayout(benchLayout).find(entry => entry.pin === Number(pin)) || null;
}

function blankFrame(total) {
  return new Array(Math.max(0, total)).fill(DISCOVERY_OFF_COLOR);
}

/**
 * Light pixels 0..litCount-1 on one port. Everything else is dark, so the only
 * thing glowing in the room is the strip currently being identified.
 */
export function buildExpandingProbeFrame({ benchLayout = [], pin, litCount = 0 } = {}) {
  const frame = blankFrame(benchLayoutTotalPixels(benchLayout));
  const entry = layoutEntry(benchLayout, pin);
  if (!entry) return frame;
  const lit = Math.min(Math.max(0, Math.trunc(Number(litCount) || 0)), entry.count);
  for (let index = 0; index < lit; index += 1) frame[entry.start + index] = DISCOVERY_PROBE_COLOR;
  return frame;
}

// Ordinals are 1-based: the 10th LED is green, the 50th blue, the 100th red.
// Precedence is 100 > 50 > 10 so the read-off protocol works by counting each
// tier only since the previous higher tier ("three reds, then one blue, then
// no greens, then four warm" = 3*100 + 1*50 + 0*10 + 4 = 354).
function decadeColorForOrdinal(ordinal) {
  if (ordinal % 100 === 0) return DISCOVERY_HUNDRED_COLOR;
  if (ordinal % 50 === 0) return DISCOVERY_FIFTY_COLOR;
  if (ordinal % 10 === 0) return DISCOVERY_DECADE_COLOR;
  return DISCOVERY_PROBE_COLOR;
}

/**
 * All probed ports at once, turned into rulers. `counts` is {[pin]: pixels} —
 * how far up each port to light.
 */
export function buildDecadeMarkerFrame({ benchLayout = [], counts = {} } = {}) {
  const layout = normalizeLayout(benchLayout);
  const frame = blankFrame(benchLayoutTotalPixels(benchLayout));
  for (const entry of layout) {
    const requested = Math.max(0, Math.trunc(Number(counts?.[entry.pin]) || 0));
    const lit = Math.min(requested, entry.count);
    for (let index = 0; index < lit; index += 1) {
      frame[entry.start + index] = decadeColorForOrdinal(index + 1);
    }
  }
  return frame;
}

/**
 * One magenta pixel and nothing else — the question "is that the last LED?"
 * has to be unambiguous, so no other pixel may be lit while it is asked.
 */
export function buildEndMarkerFrame({ benchLayout = [], pin, index = 0 } = {}) {
  const frame = blankFrame(benchLayoutTotalPixels(benchLayout));
  const entry = layoutEntry(benchLayout, pin);
  if (!entry) return frame;
  const local = Math.trunc(Number(index) || 0);
  if (local < 0 || local >= entry.count) return frame;
  frame[entry.start + local] = DISCOVERY_END_MARKER_COLOR;
  return frame;
}

function normalizePortSeed(raw, benchLayout) {
  const pin = Number(raw?.pin);
  const entry = layoutEntry(benchLayout, pin);
  return {
    pin,
    role: typeof raw?.role === 'string' ? raw.role : 'unused',
    controlKind: typeof raw?.controlKind === 'string' ? raw.controlKind : '',
    // Provisioned ceiling from the bench config. The probe can never light past
    // it; asking for more triggers a bench re-size instead of a silent clamp.
    provisioned: entry ? entry.count : 0,
    litCount: 0,
    probedCeiling: 0,
    count: 0,
    probed: false,
    confirmed: false,
    skipped: false,
    // True when the owner said "there's more" while the probe already covered
    // every provisioned pixel. The panel answers this with a larger bench
    // config (an ordinary commissioned write — the card is Ready by now).
    needsLargerBench: false,
  };
}

function discoverablePorts(session) {
  // A port carrying a control (knob, slider, button) is never probed — lighting
  // a control pin proves nothing and the firmware refuses the pin anyway.
  return session.ports.filter(port => port.role !== 'control' && port.provisioned > 0);
}

function nextProbePin(session, afterPin) {
  const candidates = discoverablePorts(session);
  const startIndex = candidates.findIndex(port => port.pin === afterPin);
  return candidates.slice(startIndex + 1).find(port => !port.probed && !port.skipped)?.pin ?? null;
}

function firstPendingConfirmPin(session) {
  return session.ports.find(port => port.probed && !port.skipped && !port.confirmed)?.pin ?? null;
}

/**
 * Create a discovery session. Plain data in, plain data out — the result is
 * JSON-serializable so a panel can hold it in React state or persist it.
 *
 * @param {object} input
 * @param {Array<{pin:number, role:string, controlKind?:string}>} input.portRoles
 *   Normalized port roles (see portRoles.js).
 * @param {Array<{pin:number, start:number, count:number}>} input.benchLayout
 *   The layout returned by buildBenchConfig.
 */
export function createStripDiscoverySession({ portRoles = [], benchLayout = [] } = {}) {
  const layout = normalizeLayout(benchLayout);
  const ports = (Array.isArray(portRoles) ? portRoles : [])
    .map(raw => normalizePortSeed(raw, layout))
    .filter(port => Number.isSafeInteger(port.pin) && port.pin >= 0);
  return Object.freeze({
    version: SESSION_VERSION,
    phase: 'bench-install',
    benchLayout: layout,
    ports,
    activePin: null,
    error: '',
  });
}

function withPorts(session, updater) {
  return Object.freeze({ ...session, ports: session.ports.map(updater) });
}

function patchPort(session, pin, patch) {
  return withPorts(session, port => (port.pin === pin ? { ...port, ...patch } : port));
}

function enterProbe(session, pin) {
  if (pin === null || pin === undefined) return Object.freeze({ ...session, phase: 'decade', activePin: null });
  const port = session.ports.find(item => item.pin === pin);
  const litCount = Math.min(
    Math.max(port?.litCount || 0, DISCOVERY_PROBE_START),
    port?.provisioned || DISCOVERY_PROBE_START,
  );
  return Object.freeze({
    ...patchPort(session, pin, { litCount, needsLargerBench: false }),
    phase: 'probe',
    activePin: pin,
  });
}

/**
 * advance(session, event) -> session'
 *
 * Unknown events return the same object, so a stray click never corrupts the
 * flow. Every transition is total: there is no state from which the owner
 * cannot move forward or back.
 */
export function advance(session, event = {}) {
  if (!session || typeof session !== 'object') return session;
  const type = String(event?.type || '');
  const pin = event?.pin === undefined || event?.pin === null ? session.activePin : Number(event.pin);

  switch (type) {
    case 'bench-installed': {
      if (session.phase !== 'bench-install') return session;
      const first = discoverablePorts(session).find(port => !port.skipped)?.pin ?? null;
      return enterProbe(Object.freeze({ ...session, error: '' }), first);
    }
    case 'bench-failed':
      return Object.freeze({ ...session, error: String(event?.error || 'The bench setup could not be installed on the card.') });
    case 'bench-resized': {
      // A larger bench config landed: re-read the provisioned ceilings and let
      // the probe keep doubling from where the owner left off.
      const layout = normalizeLayout(event?.benchLayout);
      const resized = Object.freeze({
        ...withPorts(session, port => {
          const entry = layout.find(item => item.pin === port.pin);
          return { ...port, provisioned: entry ? entry.count : port.provisioned, needsLargerBench: false };
        }),
        benchLayout: layout.length ? layout : session.benchLayout,
      });
      return resized;
    }
    case 'probe-more': {
      if (session.phase !== 'probe' || pin === null) return session;
      const port = session.ports.find(item => item.pin === pin);
      if (!port) return session;
      // Doubling has NO maximum of its own — the only ceiling is what the bench
      // config provisioned, and hitting it asks for a bigger bench rather than
      // telling the owner their strip is too long.
      const wanted = Math.max(DISCOVERY_PROBE_START, port.litCount * 2);
      if (port.litCount >= port.provisioned) {
        return patchPort(session, pin, { needsLargerBench: true });
      }
      return patchPort(session, pin, {
        litCount: Math.min(wanted, port.provisioned),
        needsLargerBench: false,
      });
    }
    case 'probe-enough': {
      if (session.phase !== 'probe' || pin === null) return session;
      const port = session.ports.find(item => item.pin === pin);
      if (!port) return session;
      const marked = patchPort(session, pin, {
        probed: true,
        probedCeiling: port.litCount,
        // Seed the read-off input with the probe ceiling so the owner edits a
        // number that is already the right order of magnitude.
        count: port.count > 0 ? port.count : port.litCount,
        role: 'strip',
        needsLargerBench: false,
      });
      return enterProbe(marked, nextProbePin(marked, pin));
    }
    case 'probe-skip': {
      if (session.phase !== 'probe' || pin === null) return session;
      // Nothing lit up: this port has no strip on it today. It stays available
      // for a knob, a slider, or a strip added later.
      const marked = patchPort(session, pin, {
        skipped: true, probed: false, count: 0, litCount: 0, role: 'unused', needsLargerBench: false,
      });
      return enterProbe(marked, nextProbePin(marked, pin));
    }
    case 'set-count': {
      if (pin === null) return session;
      const port = session.ports.find(item => item.pin === pin);
      if (!port) return session;
      const count = Math.min(port.provisioned, Math.max(0, Math.trunc(Number(event?.count) || 0)));
      return patchPort(session, pin, { count, confirmed: false });
    }
    case 'counts-entered': {
      if (session.phase !== 'decade') return session;
      const next = firstPendingConfirmPin(session);
      if (next === null) return Object.freeze({ ...session, phase: 'record', activePin: null });
      return Object.freeze({ ...session, phase: 'end-marker', activePin: next });
    }
    case 'end-marker-yes': {
      if (session.phase !== 'end-marker' || pin === null) return session;
      const port = session.ports.find(item => item.pin === pin);
      if (!port || port.count < 1 || port.count > port.provisioned) return session;
      const confirmed = patchPort(session, pin, { confirmed: true });
      const next = firstPendingConfirmPin(confirmed);
      if (next === null) return Object.freeze({ ...confirmed, phase: 'record', activePin: null });
      return Object.freeze({ ...confirmed, phase: 'end-marker', activePin: next });
    }
    case 'end-marker-no': {
      if (session.phase !== 'end-marker' || pin === null) return session;
      // The marked pixel was not the end, so the count is wrong. Go back to the
      // probe for THIS port only — the other ports keep their confirmed work.
      const reopened = patchPort(session, pin, { probed: false, confirmed: false });
      return enterProbe(reopened, pin);
    }
    case 'recorded':
      return Object.freeze({ ...session, phase: 'done', activePin: null, error: '' });
    case 'reset':
      return createStripDiscoverySession({ portRoles: session.ports, benchLayout: session.benchLayout });
    default:
      return session;
  }
}

/**
 * The frame the card should be showing for the session's current phase, or null
 * when the phase is not a lighting phase. Keeping this here (rather than in the
 * panel) means the probe/decade/end-marker visuals are covered by unit tests.
 */
export function discoveryFrame(session) {
  if (!session || typeof session !== 'object') return null;
  if (session.phase === 'probe' && session.activePin !== null) {
    const port = session.ports.find(item => item.pin === session.activePin);
    return buildExpandingProbeFrame({ benchLayout: session.benchLayout, pin: session.activePin, litCount: port?.litCount || 0 });
  }
  if (session.phase === 'decade') {
    const counts = Object.fromEntries(session.ports
      .filter(port => port.probed && !port.skipped)
      .map(port => [port.pin, port.probedCeiling]));
    return buildDecadeMarkerFrame({ benchLayout: session.benchLayout, counts });
  }
  if (session.phase === 'end-marker' && session.activePin !== null) {
    const port = session.ports.find(item => item.pin === session.activePin);
    return buildEndMarkerFrame({ benchLayout: session.benchLayout, pin: session.activePin, index: Math.max(0, (port?.count || 0) - 1) });
  }
  return null;
}

/**
 * Non-blocking advisories. Nothing here ever stops the flow — the owner's
 * standing instruction is "the quantity shouldn't matter; if I need more power
 * I will wire more power."
 */
export function discoveryWarnings(session) {
  if (!session || !Array.isArray(session.ports)) return [];
  const warnings = [];
  for (const port of session.ports) {
    if (port.count > DISCOVERY_FRAME_RATE_WARN_PIXELS) {
      warnings.push({
        pin: port.pin,
        kind: 'frame-rate',
        blocking: false,
        message: `GPIO ${port.pin} has ${port.count} LEDs. Past about ${DISCOVERY_FRAME_RATE_WARN_PIXELS} LEDs on one output the strip refreshes slower than 30 frames a second. It still works — split the run across outputs if you want the extra speed.`,
      });
    }
    if (port.needsLargerBench) {
      warnings.push({
        pin: port.pin,
        kind: 'bench-ceiling',
        blocking: false,
        message: `GPIO ${port.pin} still has LEDs past the ${port.provisioned} the card is set up for. Extend the setup to keep going.`,
      });
    }
  }
  return warnings;
}

/**
 * What discovery learned, in the shape portRoles.js persists. The caller merges
 * this into the project's portRoles through normalizePortRoles — this module
 * never touches project state itself.
 */
export function discoveryPortRoleUpdates(session) {
  if (!session || !Array.isArray(session.ports)) return [];
  return session.ports
    .filter(port => port.role !== 'control')
    .map(port => ({
      pin: port.pin,
      role: port.confirmed && port.count > 0 ? 'strip' : 'unused',
      pixelCount: port.confirmed ? port.count : 0,
      controlKind: port.controlKind || '',
    }));
}

export function totalDiscoveredPixels(session) {
  if (!session || !Array.isArray(session.ports)) return 0;
  return session.ports.reduce((total, port) => total + (port.confirmed ? port.count : 0), 0);
}

// ── Colour proof (ui-repair B-COLOUR) ────────────────────────────────────────
//
// On the real bench every colour the flow used as information rendered wrong —
// warm amber came out green, magenta came out blue — because the bench config
// guesses a channel order the strip may not have, and the counting protocol
// reads colours off the strip. The fix never assumes any colour renders truly:
// during the probe (where colour carries no meaning — only how FAR the light
// reaches does) Studio lights the probe run in one pure send-channel at a time
// and asks what colour it came out as. Two answers determine the whole
// send-slot -> seen-colour permutation; from then on every frame is corrected
// through that map before it is streamed, so green really means green by the
// time the decade ruler needs it. No card write is involved, and a wrong
// channel order cannot defeat the questions: whatever the owner sees IS the
// measurement.
export const DISCOVERY_CHANNEL_PROOF_COLORS = Object.freeze({
  first: '3C0000', // only send-slot 1 lit
  second: '003C00', // only send-slot 2 lit
});

/**
 * The probe extent lit in one pure send-channel. Same shape and extent as the
 * expanding probe frame, so "how far do the lights go" stays answerable while
 * the colour is being measured.
 */
export function buildChannelProofFrame({ benchLayout = [], pin, litCount = 0, step = 'first' } = {}) {
  const proofColor = DISCOVERY_CHANNEL_PROOF_COLORS[step] || DISCOVERY_CHANNEL_PROOF_COLORS.first;
  return buildExpandingProbeFrame({ benchLayout, pin, litCount })
    .map(color => (color === DISCOVERY_PROBE_COLOR ? proofColor : color));
}

const PROOF_COLOR_NAMES = Object.freeze(['red', 'green', 'blue']);

/**
 * What the owner saw for send-slot 1 and send-slot 2 -> the full permutation,
 * as { red, green, blue }: which SEND SLOT (0..2) ends up rendering each real
 * colour. Returns null when the answers cannot both be true (the same colour
 * twice, or not a colour name) — callers re-ask instead of recording a map
 * that lies.
 */
export function channelMapFromProofAnswers(seenFirst, seenSecond) {
  if (!PROOF_COLOR_NAMES.includes(seenFirst) || !PROOF_COLOR_NAMES.includes(seenSecond)) return null;
  if (seenFirst === seenSecond) return null;
  const seenThird = PROOF_COLOR_NAMES.find(name => name !== seenFirst && name !== seenSecond);
  return { [seenFirst]: 0, [seenSecond]: 1, [seenThird]: 2 };
}

/**
 * Re-arrange every hex colour of a frame so the PHYSICAL strip shows the
 * intended hues: the desired red amount is sent on whichever slot the proof
 * showed to render red, and so on. A missing or identity map is a pass-through,
 * so an unanswered or skipped proof behaves exactly like today.
 */
export function correctFrameForChannelMap(frame, channelMap) {
  if (!Array.isArray(frame) || !channelMap) return frame;
  if (channelMap.red === 0 && channelMap.green === 1 && channelMap.blue === 2) return frame;
  const cache = new Map();
  return frame.map(color => {
    let corrected = cache.get(color);
    if (corrected === undefined) {
      const sent = [0, 0, 0];
      sent[channelMap.red] = parseInt(color.slice(0, 2), 16) || 0;
      sent[channelMap.green] = parseInt(color.slice(2, 4), 16) || 0;
      sent[channelMap.blue] = parseInt(color.slice(4, 6), 16) || 0;
      // Uppercase to match every DISCOVERY_*_COLOR constant: corrected frames
      // are compared against them by exact string equality elsewhere, so a
      // lowercase pair would silently stop matching.
      corrected = sent.map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
      cache.set(color, corrected);
    }
    return corrected;
  });
}

// ── Named colour order (bottom of ui-repair B-COLOUR) ────────────────────────
//
// channelMapFromProofAnswers records which SEND SLOT a value must occupy for
// each real colour to show up on the strip. Turning that measured map back into
// ONE of the six named COLOR_ORDERS is just the same composition inverted:
//   - the strip maps each byte position to a physical R/G/B channel by its TRUE
//     order T — so real colour c is driven by the byte at T.indexOf(c);
//   - the card serializes a hex colour under the DECLARED order D, so that byte
//     position actually carries the hex slot occupied by D[T.indexOf(c)].
//   Predicted channelMap[c] = slot of D[T.indexOf(c)].
// So, holding D fixed, we predict the channel map for every candidate true
// order and return the ONE that reproduces the measurement. It is a bijection —
// each channel map belongs to exactly one order. Sanity check: when D and T are
// the same permutation the predicted map is the identity, which must resolve to
// D itself.
const COLOR_SLOT_OF_LETTER = Object.freeze({ R: 0, G: 1, B: 2 });

function predictedChannelMap(declaredOrder, trueOrder) {
  const predicted = {};
  predicted.red = COLOR_SLOT_OF_LETTER[declaredOrder[trueOrder.indexOf('R')]];
  predicted.green = COLOR_SLOT_OF_LETTER[declaredOrder[trueOrder.indexOf('G')]];
  predicted.blue = COLOR_SLOT_OF_LETTER[declaredOrder[trueOrder.indexOf('B')]];
  return predicted;
}

/**
 * The one member of COLOR_ORDERS that makes the strip render truly, given the
 * frames were streamed under `declaredOrder` and the proof measured the
 * permutation described by `channelMap`. Empty string when there is no map to
 * resolve (unknown / incomplete) or when no candidate reproduces it.
 */
export function namedColorOrderFromChannelMap(channelMap, declaredOrder = 'GRB') {
  if (!channelMap || typeof channelMap !== 'object' || Array.isArray(channelMap)) return '';
  const { red, green, blue } = channelMap;
  if (!Number.isInteger(red) || !Number.isInteger(green) || !Number.isInteger(blue)) return '';
  const declared = String(declaredOrder || '').toUpperCase();
  if (!COLOR_ORDERS.includes(declared)) return '';
  for (const candidate of COLOR_ORDERS) {
    const predicted = predictedChannelMap(declared, candidate);
    if (predicted.red === red && predicted.green === green && predicted.blue === blue) return candidate;
  }
  return '';
}
