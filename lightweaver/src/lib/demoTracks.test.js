import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beatGrid,
  beatSeconds,
  createDemoTrack,
  DEMO_TRACK_IDS,
  DEMO_TRACK_SPECS,
  DEMO_TRACKS,
  eventsInWindow,
  findDemoTrack,
  LOOKAHEAD_SECONDS,
  midiHz,
  voiceGain,
} from './demoTracks.js';

// ── the registry ──────────────────────────────────────────────────────────

test('three demo tracks, each with a unique id and owner-readable copy', () => {
  assert.equal(DEMO_TRACKS.length, 3);
  assert.deepEqual(DEMO_TRACK_IDS, ['ember', 'heart', 'rain']);
  assert.equal(new Set(DEMO_TRACK_IDS).size, 3);
  for (const track of DEMO_TRACKS) {
    assert.match(track.id, /^[a-z]+$/);
    assert.ok(track.name.length > 3, `${track.id} needs a name`);
    assert.ok(track.description.length > 20, `${track.id} needs a description`);
    assert.equal(typeof track.build, 'function');
    assert.ok(track.loopSeconds >= 30 && track.loopSeconds <= 45, `${track.id} loops in 30-45s`);
  }
});

test('findDemoTrack resolves by id and refuses anything else', () => {
  assert.equal(findDemoTrack('heart').name, 'Steady Heart');
  assert.equal(findDemoTrack('nope'), null);
  assert.equal(findDemoTrack(undefined), null);
  assert.throws(() => createDemoTrack({}, 'nope'), /Unknown demo track/);
});

// ── musical maths ─────────────────────────────────────────────────────────

test('midiHz is equal temperament anchored on A440', () => {
  assert.equal(midiHz(69), 440);
  assert.ok(Math.abs(midiHz(81) - 880) < 1e-9);
  assert.ok(Math.abs(midiHz(57) - 220) < 1e-9);
  assert.ok(Math.abs(midiHz(60) - 261.6255653) < 1e-6); // middle C
});

test('beatGrid lays beats evenly at the stated tempo', () => {
  assert.ok(Math.abs(beatSeconds(120) - 0.5) < 1e-12);
  const grid = beatGrid(84, 4);
  assert.equal(grid.length, 4);
  assert.equal(grid[0], 0);
  for (let i = 1; i < grid.length; i += 1) {
    assert.ok(Math.abs((grid[i] - grid[i - 1]) - beatSeconds(84)) < 1e-12);
  }
});

test('voiceGain keeps a chord at the same apparent level as a single note', () => {
  assert.equal(voiceGain(0.3, 1), 0.3);
  assert.ok(Math.abs(voiceGain(0.3, 4) - 0.15) < 1e-12);
  // Power sum of n voices at voiceGain(peak, n) is peak, whatever n is —
  // which is why the three tracks do not jump in loudness when switched.
  for (const n of [1, 2, 3, 4, 9]) {
    const g = voiceGain(0.4, n);
    assert.ok(Math.abs(Math.sqrt(n * g * g) - 0.4) < 1e-12);
  }
  assert.equal(voiceGain(0.3, 0), 0.3); // degenerate counts do not divide by zero
});

// ── the lookahead scheduler ───────────────────────────────────────────────

const EVENTS = [{ time: 0, kind: 'a' }, { time: 2.5, kind: 'b' }, { time: 7, kind: 'c' }];
const LOOP = 8;

test('eventsInWindow returns the occurrences inside a half-open window, in order', () => {
  const found = eventsInWindow(EVENTS, LOOP, 0, 8);
  assert.deepEqual(found.map((e) => e.time), [0, 2.5, 7]);
  assert.deepEqual(found.map((e) => e.kind), ['a', 'b', 'c']);
  // Half-open: the event exactly at `to` belongs to the next window, never both.
  assert.deepEqual(eventsInWindow(EVENTS, LOOP, 0, 2.5).map((e) => e.time), [0]);
  assert.deepEqual(eventsInWindow(EVENTS, LOOP, 2.5, 3).map((e) => e.time), [2.5]);
});

test('eventsInWindow repeats the loop forever without a seam', () => {
  assert.deepEqual(eventsInWindow(EVENTS, LOOP, 8, 16).map((e) => e.time), [8, 10.5, 15]);
  // A window straddling the loop point picks up the tail of one cycle and the
  // head of the next — this is the seam that a naive modulo scheduler drops.
  assert.deepEqual(eventsInWindow(EVENTS, LOOP, 6.9, 8.1).map((e) => e.time), [7, 8]);
  assert.deepEqual(eventsInWindow(EVENTS, LOOP, 0, 24).length, EVENTS.length * 3);
});

test('walking the pump forward emits every occurrence exactly once', () => {
  // Simulate a jittery pump: irregular step sizes, as a busy main thread gives.
  const steps = [0.1, 0.4, 0.03, 1.7, 0.25, 0.9, 0.05, 2.3, 0.6, 1.1, 0.02, 3.4];
  const seen = [];
  let cursor = 0;
  let i = 0;
  while (cursor < 40) {
    const next = cursor + steps[i % steps.length];
    i += 1;
    for (const event of eventsInWindow(EVENTS, LOOP, cursor, next)) seen.push(event.time);
    cursor = next;
  }
  const expected = eventsInWindow(EVENTS, LOOP, 0, cursor).map((e) => e.time);
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, seen.length, 'no occurrence emitted twice');
  for (let n = 1; n < seen.length; n += 1) assert.ok(seen[n] > seen[n - 1], 'emitted in time order');
});

test('eventsInWindow is inert for empty or backwards windows', () => {
  assert.deepEqual(eventsInWindow(EVENTS, LOOP, 3, 3), []);
  assert.deepEqual(eventsInWindow(EVENTS, LOOP, 5, 1), []);
  assert.deepEqual(eventsInWindow(EVENTS, 0, 0, 10), []);
  assert.deepEqual(eventsInWindow([], LOOP, 0, 10), []);
});

test('the lookahead outruns the pump interval by a wide margin', () => {
  // If the pump ever ran slower than the lookahead, notes would be scheduled
  // after their own start time and the music would stutter.
  assert.ok(LOOKAHEAD_SECONDS > 0.2);
});

// ── the material itself ───────────────────────────────────────────────────

test('every scheduled event sits inside its own loop and names a known voice', () => {
  const kinds = {
    ember: new Set(['pad']),
    heart: new Set(['kick', 'bass', 'chord']),
    rain: new Set(['tick', 'bell', 'pluck']),
  };
  for (const [id, spec] of Object.entries(DEMO_TRACK_SPECS)) {
    assert.ok(spec.events.length > 0, `${id} has material`);
    for (const event of spec.events) {
      assert.ok(Number.isFinite(event.time), `${id} event has a finite time`);
      assert.ok(event.time >= 0 && event.time < spec.loopSeconds, `${id} event ${event.time} inside the loop`);
      assert.ok(kinds[id].has(event.kind), `${id} event kind ${event.kind} is rendered`);
      if (event.pan !== undefined) assert.ok(Math.abs(event.pan) <= 1, 'pan stays in range');
    }
    assert.ok(spec.level > 0 && spec.level <= 0.8, `${id} keeps headroom under 1.0`);
  }
});

test('every track has a level, none of them close to clipping', () => {
  // Apparent loudness is matched by MEASURED RMS in the browser, not by equal
  // gain numbers here — sparse bells and a sustained pad with the same gain do
  // not sound the same. What this can check headlessly is that no track is
  // silent and none is dialled somewhere it could clip.
  for (const [id, spec] of Object.entries(DEMO_TRACK_SPECS)) {
    assert.ok(spec.level >= 0.3 && spec.level <= 0.8, `${id} level ${spec.level} is sane`);
  }
});

test('Steady Heart puts an onset on every beat and never changes tempo', () => {
  const spec = DEMO_TRACK_SPECS.heart;
  const kicks = spec.events.filter((e) => e.kind === 'kick').map((e) => e.time).sort((a, b) => a - b);
  const spb = beatSeconds(84);
  assert.equal(kicks.length, Math.round(spec.loopSeconds / spb));
  for (let i = 1; i < kicks.length; i += 1) {
    assert.ok(Math.abs((kicks[i] - kicks[i - 1]) - spb) < 1e-9, 'beat spacing is constant');
  }
  // The loop is a whole number of beats, so the pulse survives the loop point.
  assert.ok(Math.abs((spec.loopSeconds / spb) - Math.round(spec.loopSeconds / spb)) < 1e-9);
  assert.ok(Math.abs((kicks[0] + spec.loopSeconds - kicks[kicks.length - 1]) - spb) < 1e-9);
});

test('Slow Ember is sustained and Bright Rain is sparse and high', () => {
  const ember = DEMO_TRACK_SPECS.ember;
  // Four events across forty seconds: nothing here can read as a transient.
  assert.ok(ember.events.length / ember.loopSeconds < 0.2, 'fewer than one attack every 5s');
  for (const event of ember.events) {
    assert.ok(event.notes.every((note) => note <= 57), 'Slow Ember stays below A3');
  }
  const rain = DEMO_TRACK_SPECS.rain;
  const pitched = rain.events.filter((e) => e.note !== undefined);
  assert.ok(pitched.length > 0);
  for (const event of pitched) {
    assert.ok(event.note >= 72, 'Bright Rain stays above C5');
  }
  // And the two do not overlap in register at all, which is what makes the
  // band meters read differently.
  const emberTop = Math.max(...ember.events.flatMap((e) => e.notes));
  const rainBottom = Math.min(...pitched.map((e) => e.note));
  assert.ok(rainBottom - emberTop >= 12, 'at least an octave of separation');
});
