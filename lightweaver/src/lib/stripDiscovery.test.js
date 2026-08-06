import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DISCOVERY_DECADE_COLOR,
  DISCOVERY_END_MARKER_COLOR,
  DISCOVERY_FIFTY_COLOR,
  DISCOVERY_FRAME_RATE_WARN_PIXELS,
  DISCOVERY_HUNDRED_COLOR,
  DISCOVERY_OFF_COLOR,
  DISCOVERY_PROBE_COLOR,
  DISCOVERY_PROBE_START,
  advance,
  buildDecadeMarkerFrame,
  buildEndMarkerFrame,
  buildExpandingProbeFrame,
  createStripDiscoverySession,
  discoveryFrame,
  discoveryPortRoleUpdates,
  discoveryWarnings,
  totalDiscoveredPixels,
} from './stripDiscovery.js';

// Two strip ports and one knob, the shape buildBenchConfig produces for a card
// whose owner has said "16 and 17 have strips, 18 has a knob".
const benchLayout = [
  { pin: 16, start: 0, count: 600 },
  { pin: 17, start: 600, count: 600 },
];
const portRoles = [
  { pin: 16, role: 'strip', pixelCount: 0, controlKind: '' },
  { pin: 17, role: 'strip', pixelCount: 0, controlKind: '' },
  { pin: 18, role: 'control', pixelCount: 0, controlKind: 'knob' },
  { pin: 21, role: 'unused', pixelCount: 0, controlKind: '' },
];

const session = () => createStripDiscoverySession({ portRoles, benchLayout });
const litIndexes = (frame, color) => frame.reduce((found, value, index) => (value === color ? [...found, index] : found), []);

test('a new session starts at the one card write and knows each port ceiling', () => {
  const start = session();
  assert.equal(start.phase, 'bench-install');
  assert.equal(start.activePin, null);
  assert.deepEqual(start.ports.map(port => port.provisioned), [600, 600, 0, 0]);
  assert.equal(JSON.parse(JSON.stringify(start)).phase, 'bench-install', 'the session must be serializable');
});

test('installing the bench config opens the probe on the first strip port', () => {
  const probing = advance(session(), { type: 'bench-installed' });
  assert.equal(probing.phase, 'probe');
  assert.equal(probing.activePin, 16);
  assert.equal(probing.ports.find(port => port.pin === 16).litCount, DISCOVERY_PROBE_START);
});

test('a failed bench install never reaches the probe phase', () => {
  // The panel dispatches this when installBenchConfig throws — including the
  // 'staged' answer from a card that still needs a firmware update. A card that
  // applied nothing must not be walked as if its LEDs were live.
  const failed = advance(session(), { type: 'bench-failed', error: 'this card needs updating first' });
  assert.equal(failed.phase, 'bench-install');
  assert.equal(failed.activePin, null);
  assert.equal(failed.error, 'this card needs updating first');
  assert.equal(discoveryFrame(failed), null, 'no frame is built for a card that never applied the setup');
});

test('the probe doubles with no maximum of its own and never lights a control port', () => {
  let state = advance(session(), { type: 'bench-installed' });
  const counts = [];
  for (let index = 0; index < 6; index += 1) {
    counts.push(state.ports.find(port => port.pin === 16).litCount);
    state = advance(state, { type: 'probe-more' });
  }
  assert.deepEqual(counts, [8, 16, 32, 64, 128, 256]);
  // Port 18 carries a knob, so it is never offered as a probe target.
  const visited = new Set();
  let walk = advance(session(), { type: 'bench-installed' });
  while (walk.phase === 'probe') {
    visited.add(walk.activePin);
    walk = advance(walk, { type: 'probe-enough' });
  }
  assert.deepEqual([...visited], [16, 17]);
});

test('asking for more at the provisioned ceiling requests a bigger bench instead of clamping silently', () => {
  let state = advance(session(), { type: 'bench-installed' });
  while (state.ports.find(port => port.pin === 16).litCount < 600) {
    state = advance(state, { type: 'probe-more' });
  }
  assert.equal(state.ports.find(port => port.pin === 16).litCount, 600);
  const pressed = advance(state, { type: 'probe-more' });
  assert.equal(pressed.ports.find(port => port.pin === 16).needsLargerBench, true);
  assert.equal(discoveryWarnings(pressed).some(warning => warning.kind === 'bench-ceiling'), true);
  assert.equal(discoveryWarnings(pressed).every(warning => warning.blocking === false), true);

  const resized = advance(pressed, {
    type: 'bench-resized',
    benchLayout: [{ pin: 16, start: 0, count: 2400 }, { pin: 17, start: 2400, count: 600 }],
  });
  assert.equal(resized.ports.find(port => port.pin === 16).provisioned, 2400);
  assert.equal(resized.ports.find(port => port.pin === 16).needsLargerBench, false);
  assert.equal(advance(resized, { type: 'probe-more' }).ports.find(port => port.pin === 16).litCount, 1200);
});

test('a port with nothing on it is skipped and stays available for a control', () => {
  let state = advance(session(), { type: 'bench-installed' });
  state = advance(state, { type: 'probe-skip' });
  assert.equal(state.activePin, 17);
  const port16 = state.ports.find(port => port.pin === 16);
  assert.equal(port16.role, 'unused');
  assert.equal(port16.skipped, true);
});

test('probe -> decade -> end marker -> recorded counts is the full happy path', () => {
  let state = advance(session(), { type: 'bench-installed' });
  state = advance(state, { type: 'probe-more' });   // 16
  state = advance(state, { type: 'probe-enough' }); // port 16 ceiling 16
  assert.equal(state.activePin, 17);
  state = advance(state, { type: 'probe-enough' }); // port 17 ceiling 8
  assert.equal(state.phase, 'decade');

  // The read-off seeds each input with the probe ceiling, then the owner types
  // the number they read off the strip.
  assert.equal(state.ports.find(port => port.pin === 16).count, 16);
  state = advance(state, { type: 'set-count', pin: 16, count: 354 });
  state = advance(state, { type: 'set-count', pin: 17, count: 120 });
  state = advance(state, { type: 'counts-entered' });

  assert.equal(state.phase, 'end-marker');
  assert.equal(state.activePin, 16);
  state = advance(state, { type: 'end-marker-yes' });
  assert.equal(state.activePin, 17);
  state = advance(state, { type: 'end-marker-yes' });
  assert.equal(state.phase, 'record');

  assert.equal(totalDiscoveredPixels(state), 474);
  assert.deepEqual(discoveryPortRoleUpdates(state), [
    { pin: 16, role: 'strip', pixelCount: 354, controlKind: '' },
    { pin: 17, role: 'strip', pixelCount: 120, controlKind: '' },
    { pin: 21, role: 'unused', pixelCount: 0, controlKind: '' },
  ]);
  assert.equal(advance(state, { type: 'recorded' }).phase, 'done');
});

test('"that was not the last LED" reopens only that port and keeps the other confirmations', () => {
  let state = advance(session(), { type: 'bench-installed' });
  state = advance(state, { type: 'probe-enough' });
  state = advance(state, { type: 'probe-enough' });
  state = advance(state, { type: 'set-count', pin: 16, count: 100 });
  state = advance(state, { type: 'set-count', pin: 17, count: 50 });
  state = advance(state, { type: 'counts-entered' });
  state = advance(state, { type: 'end-marker-yes' }); // 16 confirmed
  assert.equal(state.activePin, 17);
  state = advance(state, { type: 'end-marker-no' });
  assert.equal(state.phase, 'probe');
  assert.equal(state.activePin, 17);
  assert.equal(state.ports.find(port => port.pin === 16).confirmed, true, 'port 16 keeps its confirmation');
  assert.equal(state.ports.find(port => port.pin === 17).confirmed, false);
});

test('an unknown event never corrupts the session', () => {
  const state = advance(session(), { type: 'bench-installed' });
  assert.equal(advance(state, { type: 'nonsense' }), state);
  assert.equal(advance(state, {}), state);
});

test('the expanding probe frame lights one port and covers the whole bench total', () => {
  const frame = buildExpandingProbeFrame({ benchLayout, pin: 17, litCount: 8 });
  assert.equal(frame.length, 1200);
  assert.deepEqual(litIndexes(frame, DISCOVERY_PROBE_COLOR), [600, 601, 602, 603, 604, 605, 606, 607]);
  assert.equal(frame.filter(value => value === DISCOVERY_OFF_COLOR).length, 1192);
  // Never past what the port provisions, so a runaway litCount cannot spill
  // into the next port's pixels.
  assert.equal(buildExpandingProbeFrame({ benchLayout, pin: 16, litCount: 5000 })
    .filter(value => value === DISCOVERY_PROBE_COLOR).length, 600);
  assert.equal(buildExpandingProbeFrame({ benchLayout, pin: 99, litCount: 8 })
    .every(value => value === DISCOVERY_OFF_COLOR), true);
});

test('the decade frame marks 10s, 50s and 100s with 100 beating 50 beating 10', () => {
  const frame = buildDecadeMarkerFrame({ benchLayout, counts: { 16: 120 } });
  assert.equal(frame.length, 1200);
  assert.equal(frame[0], DISCOVERY_PROBE_COLOR);
  assert.equal(frame[9], DISCOVERY_DECADE_COLOR, 'the 10th LED is green');
  assert.equal(frame[49], DISCOVERY_FIFTY_COLOR, 'the 50th LED is blue, not green');
  assert.equal(frame[99], DISCOVERY_HUNDRED_COLOR, 'the 100th LED is red, not blue');
  assert.equal(frame[119], DISCOVERY_DECADE_COLOR);
  assert.equal(frame[120], DISCOVERY_OFF_COLOR);
  // The read-off arithmetic the owner performs: reds*100 + blues-since-red*50 +
  // greens-since-blue*10 + warm tail.
  const marked = buildDecadeMarkerFrame({ benchLayout, counts: { 16: 354 } }).slice(0, 354);
  const reds = marked.filter(value => value === DISCOVERY_HUNDRED_COLOR).length;
  const lastRed = marked.lastIndexOf(DISCOVERY_HUNDRED_COLOR);
  const bluesSinceRed = marked.slice(lastRed).filter(value => value === DISCOVERY_FIFTY_COLOR).length;
  const lastMarker = Math.max(marked.lastIndexOf(DISCOVERY_FIFTY_COLOR), marked.lastIndexOf(DISCOVERY_DECADE_COLOR), lastRed);
  assert.equal(reds * 100 + bluesSinceRed * 50 + (marked.length - 1 - lastMarker), 354);
});

test('the end marker lights exactly one pixel', () => {
  const frame = buildEndMarkerFrame({ benchLayout, pin: 16, index: 353 });
  assert.equal(frame.filter(value => value !== DISCOVERY_OFF_COLOR).length, 1);
  assert.equal(frame[353], DISCOVERY_END_MARKER_COLOR);
  assert.equal(buildEndMarkerFrame({ benchLayout, pin: 16, index: 600 })
    .every(value => value === DISCOVERY_OFF_COLOR), true, 'an out-of-range index lights nothing');
});

test('discoveryFrame follows the phase', () => {
  let state = advance(session(), { type: 'bench-installed' });
  assert.equal(discoveryFrame(state)[0], DISCOVERY_PROBE_COLOR);
  state = advance(state, { type: 'probe-enough' });
  state = advance(state, { type: 'probe-enough' });
  assert.equal(discoveryFrame(state)[600], DISCOVERY_PROBE_COLOR, 'the decade frame lights every probed port at once');
  state = advance(state, { type: 'set-count', pin: 16, count: 12 });
  state = advance(state, { type: 'set-count', pin: 17, count: 12 });
  state = advance(state, { type: 'counts-entered' });
  assert.deepEqual(litIndexes(discoveryFrame(state), DISCOVERY_END_MARKER_COLOR), [11]);
  assert.equal(discoveryFrame(createStripDiscoverySession({ portRoles, benchLayout })), null);
});

test('a long strip warns about frame rate and never blocks the flow', () => {
  let state = advance(session(), { type: 'bench-installed' });
  state = advance(state, { type: 'probe-enough' });
  state = advance(state, { type: 'probe-enough' });
  state = advance(state, { type: 'set-count', pin: 16, count: DISCOVERY_FRAME_RATE_WARN_PIXELS + 1 });
  state = advance(state, { type: 'set-count', pin: 17, count: DISCOVERY_FRAME_RATE_WARN_PIXELS });
  const warnings = discoveryWarnings(state);
  assert.deepEqual(warnings.map(warning => warning.pin), [16], 'exactly at the threshold is not a warning');
  assert.equal(warnings[0].kind, 'frame-rate');
  assert.equal(warnings[0].blocking, false);
  // The flow keeps moving with the warning showing.
  state = advance(state, { type: 'counts-entered' });
  state = advance(state, { type: 'end-marker-yes' });
  state = advance(state, { type: 'end-marker-yes' });
  assert.equal(state.phase, 'record');
  assert.equal(discoveryPortRoleUpdates(state)[0].pixelCount, DISCOVERY_FRAME_RATE_WARN_PIXELS + 1);
});
