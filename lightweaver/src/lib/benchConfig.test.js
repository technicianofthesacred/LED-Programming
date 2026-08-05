import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BENCH_DEFAULT_PORT_PIXELS,
  BENCH_LOOK_BRIGHTNESS,
  BENCH_LOOK_ID,
  BENCH_MAX_MILLIAMPS,
  BENCH_PROJECT_ID,
  BENCH_PROJECT_REVISION,
  BENCH_RESERVED_CONTROL_PINS,
  BENCH_SKIP_MAX_OUTPUTS,
  BENCH_SKIP_PIXEL_BUDGET,
  BENCH_SKIP_RESERVED_CONTROL_PIN,
  BENCH_SKIP_ROLE_CONTROL,
  BENCH_ZONE_ID,
  benchSkipReasonText,
  buildBenchConfig,
  isBenchProjectEvidence,
} from './benchConfig.js';
import { CARD_HARDWARE_CONTRACT } from './cardHardwareContract.js';
import { CARD_CONFIG_STORAGE_LIMIT_BYTES } from './cardStoragePayload.js';
import { PORT_ROLE_CONTROL, PORT_ROLE_STRIP, PORT_ROLE_UNUSED } from './portRoles.js';

const PINS = CARD_HARDWARE_CONTRACT.outputPins;
// The compiled pin menu overlaps the default control GPIOs, so a fixture that
// expects a port to become an output has to pick a pin no control claims.
const SAFE_PINS = PINS.filter(pin => !BENCH_RESERVED_CONTROL_PINS.includes(pin));

function rolesWith(overrides = {}) {
  return PINS.map(pin => (
    Object.hasOwn(overrides, pin)
      ? { pin, controlKind: '', pixelCount: 0, ...overrides[pin] }
      : { pin, role: PORT_ROLE_UNUSED, pixelCount: 0, controlKind: '' }
  ));
}

function stripRoles(counts = {}) {
  return rolesWith(Object.fromEntries(
    Object.entries(counts).map(([pin, pixelCount]) => [pin, { role: PORT_ROLE_STRIP, pixelCount }]),
  ));
}

test('the fixture pin menu leaves at least four ports free of control GPIOs', () => {
  assert.ok(SAFE_PINS.length >= CARD_HARDWARE_CONTRACT.maxOutputs, JSON.stringify({ PINS, SAFE_PINS }));
});

test('isBenchProjectEvidence recognizes only the bench sentinel', () => {
  assert.equal(isBenchProjectEvidence({ projectId: BENCH_PROJECT_ID }), true);
  assert.equal(isBenchProjectEvidence({ projectId: 'lwproj-abc-123' }), false);
  assert.equal(isBenchProjectEvidence({}), false);
  assert.equal(isBenchProjectEvidence(null), false);
  assert.equal(isBenchProjectEvidence(undefined), false);
  assert.equal(isBenchProjectEvidence(BENCH_PROJECT_ID), false);
});

test('a port the owner asked for gets one legal output and one look', () => {
  // LightweaverStorage.cpp:473 rejects only outputCount == 0 || lookCount == 0.
  const { config, layout } = buildBenchConfig(stripRoles({ [SAFE_PINS[0]]: 0 }), { maxPixels: 1024 });
  assert.equal(config.led.outputs.length, 1);
  assert.equal(config.looks.length, 1);
  assert.equal(config.looks[0].id, BENCH_LOOK_ID);
  assert.deepEqual(layout, [{ pin: SAFE_PINS[0], start: 0, count: BENCH_DEFAULT_PORT_PIXELS }]);
});

test('no requested port means no config — never a substituted one', () => {
  const { config, layout, skipped } = buildBenchConfig(undefined, { maxPixels: 1024 });
  assert.equal(config, null);
  assert.deepEqual(layout, []);
  assert.deepEqual(skipped, []);
});

test('picking only control-reserved pins yields zero outputs and a reason per pin', () => {
  // The first rows of the discovery picker are the default control GPIOs. The
  // owner must never end up with an unrelated port provisioned in their place.
  const reserved = PINS.filter(pin => BENCH_RESERVED_CONTROL_PINS.includes(pin));
  assert.ok(reserved.length > 0, 'this contract build has no control-pin overlap to test');

  const { config, layout, skipped } = buildBenchConfig(
    stripRoles(Object.fromEntries(reserved.map(pin => [pin, 60]))),
    { maxPixels: 1024 },
  );
  assert.equal(config, null, 'a port the owner never picked must not be provisioned in their place');
  assert.deepEqual(layout, []);
  assert.deepEqual(
    skipped,
    reserved.map(pin => ({ pin, reason: BENCH_SKIP_RESERVED_CONTROL_PIN })),
  );
  for (const entry of skipped) {
    assert.match(benchSkipReasonText(entry.reason), /in use by the controls/);
  }
});

test('every skip reason has a plain-language sentence', () => {
  const reasons = [
    BENCH_SKIP_ROLE_CONTROL,
    BENCH_SKIP_RESERVED_CONTROL_PIN,
    BENCH_SKIP_MAX_OUTPUTS,
    BENCH_SKIP_PIXEL_BUDGET,
  ];
  const sentences = new Set();
  for (const reason of reasons) {
    const text = benchSkipReasonText(reason);
    assert.ok(text.length > 10, `no copy for ${reason}`);
    assert.notEqual(text, benchSkipReasonText('made-up-reason'), `${reason} fell through to the generic sentence`);
    sentences.add(text);
  }
  assert.equal(sentences.size, reasons.length, 'each reason needs its own sentence');
});

test('one output per strip-role port, layout contiguous and ascending from zero', () => {
  const { config, layout } = buildBenchConfig(
    stripRoles({ [SAFE_PINS[0]]: 120, [SAFE_PINS[2]]: 60 }),
    { maxPixels: 1024 },
  );
  assert.deepEqual(layout, [
    { pin: SAFE_PINS[0], start: 0, count: 120 },
    { pin: SAFE_PINS[2], start: 120, count: 60 },
  ]);
  assert.deepEqual(config.led.outputs.map(output => output.pin), [SAFE_PINS[0], SAFE_PINS[2]]);
  assert.deepEqual(config.led.outputs.map(output => output.pixels), [120, 60]);
  assert.equal(config.led.pixels, 180);

  let expectedStart = 0;
  for (const entry of layout) {
    assert.equal(entry.start, expectedStart, 'layout starts must be contiguous');
    expectedStart += entry.count;
  }
});

test('pixelsPerPort overrides the recorded count and opts an unused port in', () => {
  const { layout } = buildBenchConfig(
    stripRoles({ [SAFE_PINS[0]]: 8 }),
    { maxPixels: 1024, pixelsPerPort: { [SAFE_PINS[0]]: 64, [SAFE_PINS[3]]: 32 } },
  );
  assert.deepEqual(layout, [
    { pin: SAFE_PINS[0], start: 0, count: 64 },
    { pin: SAFE_PINS[3], start: 64, count: 32 },
  ]);
});

test('a control-role port is never driven as an LED output', () => {
  const roles = rolesWith({
    [SAFE_PINS[0]]: { role: PORT_ROLE_STRIP, pixelCount: 40 },
    [SAFE_PINS[1]]: { role: PORT_ROLE_CONTROL, controlKind: 'knob' },
  });
  const { layout, skipped } = buildBenchConfig(roles, {
    maxPixels: 1024,
    // Even an explicit request must not claim a port the owner gave to a knob.
    pixelsPerPort: { [SAFE_PINS[1]]: 100 },
  });
  assert.deepEqual(layout.map(entry => entry.pin), [SAFE_PINS[0]]);
  assert.deepEqual(skipped, [{ pin: SAFE_PINS[1], reason: BENCH_SKIP_ROLE_CONTROL }]);
});

test('a port on a default control GPIO is skipped, not silently repinned', () => {
  const reserved = PINS.find(pin => BENCH_RESERVED_CONTROL_PINS.includes(pin));
  if (reserved === undefined) return; // no overlap in this contract build
  const { config, layout, skipped } = buildBenchConfig(
    stripRoles({ [reserved]: 50, [SAFE_PINS[0]]: 50 }),
    { maxPixels: 1024 },
  );
  assert.deepEqual(layout.map(entry => entry.pin), [SAFE_PINS[0]]);
  assert.deepEqual(skipped, [{ pin: reserved, reason: BENCH_SKIP_RESERVED_CONTROL_PIN }]);
  // The controls the config ships with must still own that GPIO.
  const controlPins = [
    config.controls.encoder.a,
    config.controls.encoder.b,
    config.controls.encoder.press,
    config.controls.encoder.alternatePress,
    config.controls.previous,
    config.controls.next,
    config.controls.blackout,
    config.controls.brightness,
    config.controls.statusLed,
  ];
  assert.ok(controlPins.includes(reserved));
});

test('no bench output ever lands on a pin the shipped controls claim', () => {
  const counts = Object.fromEntries(PINS.map(pin => [pin, 8]));
  const { config } = buildBenchConfig(stripRoles(counts), { maxPixels: 1024 });
  for (const output of config.led.outputs) {
    assert.ok(
      !BENCH_RESERVED_CONTROL_PINS.includes(output.pin),
      `output on reserved control GPIO ${output.pin}`,
    );
  }
});

test('outputs stop at the four RMT channels the silicon has', () => {
  const counts = Object.fromEntries(SAFE_PINS.slice(0, 6).map(pin => [pin, 16]));
  const { config, layout, skipped } = buildBenchConfig(stripRoles(counts), { maxPixels: 1024 });
  assert.equal(config.led.outputs.length, CARD_HARDWARE_CONTRACT.maxOutputs);
  assert.equal(layout.length, CARD_HARDWARE_CONTRACT.maxOutputs);
  const dropped = SAFE_PINS.slice(CARD_HARDWARE_CONTRACT.maxOutputs, 6);
  assert.deepEqual(skipped, dropped.map(pin => ({ pin, reason: BENCH_SKIP_MAX_OUTPUTS })));
});

test('totals clamp to the pixel ceiling the card reported', () => {
  const { config, layout } = buildBenchConfig(
    stripRoles({ [SAFE_PINS[0]]: 700, [SAFE_PINS[1]]: 700, [SAFE_PINS[2]]: 700 }),
    { maxPixels: 1024 },
  );
  const total = layout.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(total, 1024);
  assert.equal(config.led.pixels, 1024);
  assert.deepEqual(layout, [
    { pin: SAFE_PINS[0], start: 0, count: 700 },
    { pin: SAFE_PINS[1], start: 700, count: 324 },
  ]);
});

test('a card reporting more than this Studio build supports is clamped to the contract', () => {
  const { layout } = buildBenchConfig(
    stripRoles({ [SAFE_PINS[0]]: 200_000 }),
    { maxPixels: 200_000 },
  );
  assert.equal(layout[0].count, CARD_HARDWARE_CONTRACT.maxPixels);
});

test('a missing or nonsense maxPixels falls back to the contract ceiling', () => {
  for (const maxPixels of [undefined, null, 0, -5, 'lots']) {
    const { layout } = buildBenchConfig(
      stripRoles({ [SAFE_PINS[0]]: 200_000 }),
      { maxPixels },
    );
    assert.equal(layout[0].count, CARD_HARDWARE_CONTRACT.maxPixels, `maxPixels ${maxPixels}`);
  }
});

test('maxMilliamps is always explicit — never the silent firmware fallback', () => {
  for (const opts of [{}, { maxPixels: 1024 }, { maxPixels: 32, ledType: 'WS2815', colorOrder: 'RGB' }]) {
    const { config } = buildBenchConfig(stripRoles({ [SAFE_PINS[0]]: 24 }), opts);
    assert.equal(config.led.maxMilliamps, BENCH_MAX_MILLIAMPS);
    assert.notEqual(config.led.maxMilliamps, 1500, 'must not land on LW_DEFAULT_MAX_MILLIAMPS');
  }
});

test('the sentinel carries a real, stable project identity', () => {
  const roles = stripRoles({ [SAFE_PINS[0]]: 96 });
  const { config } = buildBenchConfig(roles, { maxPixels: 1024 });
  // The card persists this as `pieceId` and echoes it as `projectId` in
  // /api/status (project-identity-contract.mjs), which is what
  // isBenchProjectEvidence reads.
  assert.equal(config.piece.id, BENCH_PROJECT_ID);
  assert.equal(config.projectRevision, BENCH_PROJECT_REVISION);
  assert.match(config.projectFingerprint, /^[a-f0-9]{16,64}$/);

  const again = buildBenchConfig(roles, { maxPixels: 1024 });
  assert.equal(again.config.projectFingerprint, config.projectFingerprint, 'same inputs, same identity');

  const different = buildBenchConfig(stripRoles({ [SAFE_PINS[0]]: 97 }), { maxPixels: 1024 });
  assert.notEqual(different.config.projectFingerprint, config.projectFingerprint, 'different ports, different identity');

  assert.equal(isBenchProjectEvidence({ projectId: config.piece.id }), true);
});

test('the bench look is a single dim warm white', () => {
  const { config } = buildBenchConfig(stripRoles({ [SAFE_PINS[0]]: 48 }), { maxPixels: 1024 });
  assert.equal(config.looks.length, 1);
  const [look] = config.looks;
  assert.equal(look.id, BENCH_LOOK_ID);
  assert.equal(look.preset, 'warm-white');
  assert.equal(look.brightness, BENCH_LOOK_BRIGHTNESS);
  assert.ok(look.brightness <= 0.3, 'bench brightness must stay dim');
  assert.equal(config.startupPatternId, BENCH_LOOK_ID);
  // compactCardStorageConfig drops the encoder cycle and the pattern bank once
  // looks are present — the card derives both from the single look, and the
  // bytes are needed for the 3968-byte budget.
  assert.equal(config.controls.encoder.patternCycleIds, undefined);
  assert.equal(config.patterns, undefined);
});

test('exactly one zone covers every provisioned pixel', () => {
  // renderProceduralFrame() bails on zoneCount == 0 (main.cpp:1424), so a
  // zone-less bench config would install fine and render nothing.
  const { config, layout } = buildBenchConfig(
    stripRoles({ [SAFE_PINS[0]]: 120, [SAFE_PINS[1]]: 60 }),
    { maxPixels: 1024 },
  );
  const total = layout.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(config.zones.length, 1);
  assert.equal(config.zones[0].id, BENCH_ZONE_ID);
  assert.equal(config.zones[0].patternId, 'warm-white');
  assert.deepEqual(config.zones[0].ranges, [{ start: 0, count: total }]);
  assert.equal(config.zones[0].brightness, BENCH_LOOK_BRIGHTNESS);
});

test('the bench config fits the card storage budget at every port count', () => {
  for (let ports = 1; ports <= CARD_HARDWARE_CONTRACT.maxOutputs; ports += 1) {
    const counts = Object.fromEntries(SAFE_PINS.slice(0, ports).map(pin => [pin, 256]));
    const { config } = buildBenchConfig(stripRoles(counts), { maxPixels: 1024 });
    const bytes = new TextEncoder().encode(JSON.stringify(config)).byteLength;
    assert.ok(
      bytes <= CARD_CONFIG_STORAGE_LIMIT_BYTES,
      `${ports} ports serialized to ${bytes} bytes, over the ${CARD_CONFIG_STORAGE_LIMIT_BYTES}-byte card limit`,
    );
  }
});

test('led type and colour order are carried through', () => {
  const { config } = buildBenchConfig(stripRoles({ [SAFE_PINS[0]]: 12 }), {
    maxPixels: 1024,
    ledType: 'WS2815',
    colorOrder: 'BRG',
  });
  assert.equal(config.led.type, 'WS2815');
  assert.equal(config.led.colorOrder, 'BRG');
});

test('defaults are WS2812B / GRB', () => {
  const { config } = buildBenchConfig(stripRoles({ [SAFE_PINS[0]]: 12 }), { maxPixels: 1024 });
  assert.equal(config.led.type, 'WS2812B');
  assert.equal(config.led.colorOrder, 'GRB');
});
