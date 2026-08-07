import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeSetupHotspotWait,
  SETUP_HOTSPOT_BROADCAST_MS,
  SETUP_HOTSPOT_RESCAN_MS,
} from './setupHotspotWait.js';

const START = 1_700_000_000_000;
const SSID = 'Lightweaver-EEFF';

test('the first seconds after the card starts broadcasting are a wait, not a failure', () => {
  const wait = describeSetupHotspotWait({ startedAt: START, now: START + 2_000, label: SSID });
  assert.equal(wait.phase, 'appearing');
  assert.equal(wait.secondsRemaining, Math.ceil((SETUP_HOTSPOT_BROADCAST_MS - 2_000) / 1000));
  assert.match(wait.headline, /more seconds/);
  assert.match(wait.headline, new RegExp(SSID));
  // Nothing here may read as "something is wrong" — the card is fine.
  assert.doesNotMatch(`${wait.headline} ${wait.detail}`, /off and back on|cannot see/);
});

test('the countdown shrinks as the wait elapses and never goes below one second', () => {
  const early = describeSetupHotspotWait({ startedAt: START, now: START + 1_000, label: SSID });
  const late = describeSetupHotspotWait({ startedAt: START, now: START + 20_000, label: SSID });
  assert.ok(late.secondsRemaining < early.secondsRemaining);
  const last = describeSetupHotspotWait({
    startedAt: START, now: START + SETUP_HOTSPOT_BROADCAST_MS - 1, label: SSID,
  });
  assert.equal(last.secondsRemaining, 1);
  assert.match(last.headline, /about 1 more second —/);
});

test('once the broadcast window elapses the instruction becomes a plain join', () => {
  const wait = describeSetupHotspotWait({
    startedAt: START, now: START + SETUP_HOTSPOT_BROADCAST_MS, label: SSID,
  });
  assert.equal(wait.phase, 'listed');
  assert.equal(wait.secondsRemaining, 0);
  assert.match(wait.headline, /Wi-Fi settings and join Lightweaver-EEFF/);
});

test('a network that never appears escalates to the two things that actually cause it', () => {
  const wait = describeSetupHotspotWait({
    startedAt: START, now: START + SETUP_HOTSPOT_RESCAN_MS, label: SSID,
  });
  assert.equal(wait.phase, 'overdue');
  // The stale scan list, and the card having kept its Wi-Fi so no hotspot exists.
  assert.match(wait.detail, /off and back on/);
  assert.match(wait.detail, /already on your network/);
});

test('an unknown start time never invents a countdown', () => {
  for (const startedAt of [undefined, null, 0, NaN, 'soon']) {
    const wait = describeSetupHotspotWait({ startedAt, now: START, label: SSID });
    assert.equal(wait.phase, 'listed');
    assert.equal(wait.secondsRemaining, 0);
  }
});

test('a clock that steps backwards restarts the wait instead of counting up', () => {
  const wait = describeSetupHotspotWait({ startedAt: START, now: START - 60_000, label: SSID });
  assert.equal(wait.phase, 'appearing');
  assert.equal(wait.secondsRemaining, SETUP_HOTSPOT_BROADCAST_MS / 1000);
});

test('with no provable SSID the copy describes the network instead of naming one', () => {
  const wait = describeSetupHotspotWait({ startedAt: START, now: START + 1_000, label: '' });
  assert.match(wait.headline, /the card’s setup network/);
  assert.doesNotMatch(wait.headline, /undefined|null|XXXX/);
});

test('the label is never the first word of a sentence, so a descriptive label still reads', () => {
  const descriptive = 'the card’s own Wi-Fi network (its name starts with “Lightweaver-”)';
  for (const now of [START + 1_000, START + 30_000, START + 90_000]) {
    const wait = describeSetupHotspotWait({ startedAt: START, now, label: descriptive });
    assert.ok(!wait.headline.startsWith(descriptive));
    assert.ok(wait.headline.includes(descriptive));
  }
});
