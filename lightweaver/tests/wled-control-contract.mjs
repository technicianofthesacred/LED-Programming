import assert from 'node:assert/strict';
import {
  DEFAULT_WLED_PHYSICAL_CONTROLS,
  WLED_ENCODER_FIRMWARE_MODES,
  buildWledControlContract,
  hasWledRotaryEncoderSupport,
  makeWledEncoderBrightnessState,
  makeWledEncoderPressButtonConfig,
  makeWledEncoderPressTestState,
  makeWledPresetCycleCommand,
  normalizeWledPhysicalControls,
  summarizeWledControlContract,
} from '../src/lib/wledControlContract.js';

const normalized = normalizeWledPhysicalControls({
  encoder: {
    enabled: true,
    firmware: 'rotary-usermod',
    pins: { a: '4', b: '5', press: '6' },
    brightnessStep: '12',
  },
});

assert.equal(DEFAULT_WLED_PHYSICAL_CONTROLS.encoder.rotateAction, 'brightness');
assert.equal(normalized.encoder.enabled, true);
assert.equal(normalized.encoder.firmware, WLED_ENCODER_FIRMWARE_MODES.ROTARY_USERMOD);
assert.deepEqual(normalized.encoder.pins, { a: 4, b: 5, press: 6 });
assert.equal(normalized.encoder.rotateAction, 'brightness');
assert.equal(normalized.encoder.pressAction, 'next-preset');
assert.equal(normalized.encoder.brightnessStep, 12);

assert.deepEqual(makeWledPresetCycleCommand({ presetIds: [1, 2, 3] }), {
  firstPresetId: 1,
  lastPresetId: 3,
  presetIds: [1, 2, 3],
  httpCommand: 'P1=1&P2=3&PL=~',
  jsonCommand: { ps: '1~ 3~' },
});

assert.deepEqual(makeWledPresetCycleCommand({
  presetIds: [8, 7, 7, 9],
}), {
  firstPresetId: 7,
  lastPresetId: 9,
  presetIds: [7, 8, 9],
  httpCommand: 'P1=7&P2=9&PL=~',
  jsonCommand: { ps: '7~ 9~' },
});

assert.equal(hasWledRotaryEncoderSupport({
  u: { 'Rotary Encoder': ['ready'] },
}), true);
assert.equal(hasWledRotaryEncoderSupport({}, {
  um: { RotaryEncoderUI: { enabled: true } },
}), true);
assert.equal(hasWledRotaryEncoderSupport({
  u: { AudioReactive: ['ready'] },
}), false);

const disabledContract = buildWledControlContract({
  physicalControls: { encoder: { enabled: false } },
  wledPackage: { presets: [{ presetId: 1 }, { presetId: 2 }], playlistPresetId: 3 },
});
assert.equal(disabledContract.encoder.enabled, false);
assert.deepEqual(disabledContract.presetEntries, {});

const enabledContract = buildWledControlContract({
  physicalControls: normalized,
  wledPackage: { presets: [{ presetId: 1 }, { presetId: 2 }, { presetId: 3 }], playlistPresetId: 4 },
});
assert.equal(enabledContract.runtimeOwner, 'wled-firmware');
assert.equal(enabledContract.encoder.enabled, true);
assert.equal(enabledContract.encoder.rotate.ready, true);
assert.equal(enabledContract.encoder.rotate.action, 'brightness');
assert.equal(enabledContract.encoder.press.ready, true);
assert.equal(enabledContract.encoder.press.helperPresetId, 5);
assert.equal(enabledContract.encoder.press.httpCommand, 'P1=1&P2=3&PL=~');
assert.deepEqual(enabledContract.presetEntries, {
  5: {
    n: 'LW Next Look',
    ql: '>>',
    ps: '1~ 3~',
  },
});
assert.deepEqual(makeWledEncoderPressTestState(enabledContract), { ps: '1~ 3~' });
assert.deepEqual(makeWledEncoderBrightnessState(enabledContract, 'down'), { bri: '~-12' });
assert.deepEqual(makeWledEncoderBrightnessState(enabledContract, 'up'), { bri: '~12' });

const pressButtonConfig = makeWledEncoderPressButtonConfig({
  contract: enabledContract,
  cfg: {
    hw: {
      btn: {
        max: 4,
        pull: true,
        ins: [
          { type: 2, pin: [0], macros: [0, 0, 0] },
          { type: 0, pin: [], macros: [0, 0, 0] },
        ],
      },
    },
  },
});
assert.equal(pressButtonConfig.buttonIndex, 1);
assert.equal(pressButtonConfig.pin, 6);
assert.equal(pressButtonConfig.presetId, 5);
assert.deepEqual(pressButtonConfig.patch.hw.btn.ins[0], { type: 2, pin: [0], macros: [0, 0, 0] });
assert.deepEqual(pressButtonConfig.patch.hw.btn.ins[1], { type: 2, pin: [6], macros: [5, 5, 5] });

const matchingPressButtonConfig = makeWledEncoderPressButtonConfig({
  contract: enabledContract,
  cfg: {
    hw: {
      btn: {
        max: 4,
        ins: [
          { type: 2, pin: [6], macros: [0, 0, 0] },
          { type: 2, pin: [12], macros: [3, 4, 0] },
        ],
      },
    },
  },
});
assert.equal(matchingPressButtonConfig.buttonIndex, 0);
assert.deepEqual(matchingPressButtonConfig.patch.hw.btn.ins[0], { type: 2, pin: [6], macros: [5, 5, 5] });

const stockContract = buildWledControlContract({
  physicalControls: {
    encoder: {
      enabled: true,
      firmware: 'stock-wled',
      pins: { press: 0 },
    },
  },
  wledPackage: { presets: [{ presetId: 1 }], playlistPresetId: 2 },
});
assert.equal(stockContract.encoder.rotate.ready, false);
assert.match(stockContract.encoder.rotate.note, /rotary encoder usermod/i);
assert.equal(stockContract.encoder.press.ready, true);
assert.match(summarizeWledControlContract(stockContract), /press triggers preset 3/i);

console.log('wled-control-contract passed');
