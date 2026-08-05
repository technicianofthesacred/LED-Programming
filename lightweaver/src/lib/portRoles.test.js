import assert from 'node:assert/strict';
import test from 'node:test';

import { CARD_HARDWARE_CONTRACT } from './cardHardwareContract.js';
import {
  PORT_MAX_PIXEL_COUNT,
  PORT_ROLE_CONTROL,
  PORT_ROLE_STRIP,
  PORT_ROLE_UNUSED,
  defaultPortRoles,
  normalizePortRoles,
  stripPorts,
  totalStripPixels,
} from './portRoles.js';

test('defaultPortRoles describes every contract pin as an empty port, in order', () => {
  const roles = defaultPortRoles();
  assert.deepEqual(roles.map(entry => entry.pin), [...CARD_HARDWARE_CONTRACT.outputPins]);
  for (const entry of roles) {
    assert.deepEqual(entry, { pin: entry.pin, role: PORT_ROLE_UNUSED, pixelCount: 0, controlKind: '' });
  }
});

test('defaultPortRoles honours an explicit pin list', () => {
  assert.deepEqual(defaultPortRoles([7, 9]).map(entry => entry.pin), [7, 9]);
});

test('normalizePortRoles fills every missing pin from defaults', () => {
  const pins = CARD_HARDWARE_CONTRACT.outputPins;
  const roles = normalizePortRoles([{ pin: pins[1], role: PORT_ROLE_STRIP, pixelCount: 120 }]);
  assert.equal(roles.length, pins.length);
  assert.deepEqual(roles.map(entry => entry.pin), [...pins]);
  assert.equal(roles[1].role, PORT_ROLE_STRIP);
  assert.equal(roles[1].pixelCount, 120);
  assert.equal(roles[0].role, PORT_ROLE_UNUSED);
  assert.equal(roles[0].pixelCount, 0);
});

test('normalizePortRoles returns full defaults for junk input', () => {
  for (const junk of [undefined, null, 'strip', 42, {}, [null, 'nope', 7]]) {
    assert.deepEqual(normalizePortRoles(junk), defaultPortRoles(), `input ${JSON.stringify(junk)}`);
  }
});

test('normalizePortRoles coerces unknown roles and control kinds to safe values', () => {
  const pins = CARD_HARDWARE_CONTRACT.outputPins;
  const [first, second] = normalizePortRoles([
    { pin: pins[0], role: 'STRIP', pixelCount: 4, controlKind: 'dial' },
    { pin: pins[1], role: PORT_ROLE_CONTROL, pixelCount: 0, controlKind: 'knob' },
  ]);
  // 'STRIP' is not one of the exact role values, so it must not be trusted.
  assert.equal(first.role, PORT_ROLE_UNUSED);
  assert.equal(first.controlKind, '');
  assert.equal(second.role, PORT_ROLE_CONTROL);
  assert.equal(second.controlKind, 'knob');
});

test('normalizePortRoles clamps pixelCount without ever rejecting a large strip', () => {
  const pins = CARD_HARDWARE_CONTRACT.outputPins;
  const roles = normalizePortRoles([
    { pin: pins[0], role: PORT_ROLE_STRIP, pixelCount: -12 },
    { pin: pins[1], role: PORT_ROLE_STRIP, pixelCount: 999999 },
    { pin: pins[2], role: PORT_ROLE_STRIP, pixelCount: 40.9 },
    { pin: pins[3], role: PORT_ROLE_STRIP, pixelCount: 'lots' },
  ]);
  assert.equal(roles[0].pixelCount, 0);
  assert.equal(roles[1].pixelCount, PORT_MAX_PIXEL_COUNT);
  assert.equal(roles[2].pixelCount, 40);
  assert.equal(roles[3].pixelCount, 0);
});

test('normalizePortRoles never rejects a count past the card build limit', () => {
  const pins = CARD_HARDWARE_CONTRACT.outputPins;
  // Warn, never block: a count larger than the card can currently drive is a
  // consumer-facing warning, so normalization keeps it (up to the uint16 wall)
  // instead of throwing or zeroing it.
  const oversize = CARD_HARDWARE_CONTRACT.maxPixels + 10_000;
  const [entry] = normalizePortRoles([{ pin: pins[0], role: PORT_ROLE_STRIP, pixelCount: oversize }]);
  assert.equal(entry.pixelCount, Math.min(oversize, PORT_MAX_PIXEL_COUNT));
  assert.ok(entry.pixelCount > 0);
});

test('normalizePortRoles drops pins this card cannot drive and de-duplicates', () => {
  const pins = CARD_HARDWARE_CONTRACT.outputPins;
  const roles = normalizePortRoles([
    { pin: 99, role: PORT_ROLE_STRIP, pixelCount: 500 },
    { pin: pins[0], role: PORT_ROLE_STRIP, pixelCount: 30 },
    { pin: pins[0], role: PORT_ROLE_CONTROL, pixelCount: 0 },
  ]);
  assert.deepEqual(roles.map(entry => entry.pin), [...pins]);
  assert.equal(roles[0].role, PORT_ROLE_STRIP);
  assert.equal(roles[0].pixelCount, 30);
});

test('normalizePortRoles accepts a custom pin list', () => {
  const roles = normalizePortRoles([{ pin: 40, role: PORT_ROLE_STRIP, pixelCount: 60 }], { outputPins: [40, 41] });
  assert.deepEqual(roles.map(entry => entry.pin), [40, 41]);
  assert.equal(roles[0].pixelCount, 60);
  assert.equal(roles[1].role, PORT_ROLE_UNUSED);
});

test('normalizePortRoles is idempotent', () => {
  const pins = CARD_HARDWARE_CONTRACT.outputPins;
  const once = normalizePortRoles([
    { pin: pins[0], role: PORT_ROLE_STRIP, pixelCount: 300 },
    { pin: pins[2], role: PORT_ROLE_CONTROL, controlKind: 'slider' },
  ]);
  assert.deepEqual(normalizePortRoles(once), once);
});

test('stripPorts and totalStripPixels only count measured strips', () => {
  const pins = CARD_HARDWARE_CONTRACT.outputPins;
  const roles = normalizePortRoles([
    { pin: pins[0], role: PORT_ROLE_STRIP, pixelCount: 144 },
    { pin: pins[1], role: PORT_ROLE_STRIP, pixelCount: 0 },
    { pin: pins[2], role: PORT_ROLE_CONTROL, controlKind: 'knob' },
    { pin: pins[3], role: PORT_ROLE_STRIP, pixelCount: 60 },
  ]);
  assert.deepEqual(stripPorts(roles).map(entry => entry.pin), [pins[0], pins[3]]);
  assert.equal(totalStripPixels(roles), 204);
});

test('stripPorts tolerates junk without throwing', () => {
  assert.deepEqual(stripPorts(undefined), []);
  assert.deepEqual(stripPorts([null, { role: PORT_ROLE_STRIP }]), []);
  assert.equal(totalStripPixels(null), 0);
});
