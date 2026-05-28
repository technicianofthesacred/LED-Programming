import assert from 'node:assert/strict';
import {
  parseUsbRotaryInputLine,
  resolveRotaryInputAction,
  selectFreshUsbRotaryEvents,
} from '../src/lib/usbRotaryInput.js';

const knownPatternIds = new Set(['aurora', 'fire', 'candle', 'breathe']);

assert.deepEqual(
  parseUsbRotaryInputLine('LWUSB ROTARY turn=clockwise'),
  { type: 'rotate', turn: 'clockwise' },
);

assert.deepEqual(
  parseUsbRotaryInputLine('LWUSB ROTARY dir=-1'),
  { type: 'rotate', turn: 'counterclockwise' },
);

assert.deepEqual(
  parseUsbRotaryInputLine('LWUSB ROTARY press'),
  { type: 'press' },
);

assert.equal(parseUsbRotaryInputLine('LWUSB OK frame pixels=44'), null);

assert.deepEqual(
  resolveRotaryInputAction({
    event: { type: 'rotate', turn: 'clockwise' },
    currentBrightness: 0.5,
    currentPatternId: 'aurora',
    physicalControls: {
      encoder: {
        enabled: true,
        rotateAction: 'brightness',
        rotateDirection: 'clockwise-dimmer',
        brightnessStep: 26,
      },
    },
    knownPatternIds,
  }),
  { type: 'brightness', brightness: 0.398 },
);

assert.deepEqual(
  resolveRotaryInputAction({
    event: { type: 'press' },
    currentBrightness: 0.5,
    currentPatternId: 'fire',
    showClips: [
      { patternId: 'aurora' },
      { patternId: 'candle' },
      { patternId: 'fire' },
    ],
    physicalControls: {
      encoder: {
        enabled: true,
        pressAction: 'next-preset',
        patternCycleIds: ['fire', 'candle', 'breathe'],
      },
    },
    knownPatternIds,
  }),
  { type: 'pattern', patternId: 'candle' },
);

assert.equal(
  resolveRotaryInputAction({
    event: { type: 'rotate', turn: 'clockwise' },
    currentBrightness: 0.5,
    currentPatternId: 'aurora',
    physicalControls: { encoder: { enabled: false } },
    knownPatternIds,
  }),
  null,
);

assert.deepEqual(
  resolveRotaryInputAction({
    event: { type: 'rotate', turn: 'clockwise' },
    currentBrightness: 0.5,
    currentPatternId: 'aurora',
    physicalControls: { encoder: { enabled: false, rotateDirection: 'clockwise-dimmer' } },
    knownPatternIds,
    requireEnabled: false,
  }),
  { type: 'brightness', brightness: 0.469 },
);

assert.deepEqual(
  selectFreshUsbRotaryEvents(
    [
      { id: 1, at: 1000, type: 'rotate', turn: 'clockwise' },
      { id: 2, at: 1010, type: 'press' },
    ],
    { lastEventId: 513, startedAt: 900 },
  ),
  {
    events: [
      { id: 1, at: 1000, type: 'rotate', turn: 'clockwise' },
      { id: 2, at: 1010, type: 'press' },
    ],
    lastEventId: 2,
  },
);

assert.deepEqual(
  selectFreshUsbRotaryEvents(
    [
      { id: 511, at: 800, type: 'rotate', turn: 'clockwise' },
      { id: 512, at: 820, type: 'rotate', turn: 'clockwise' },
    ],
    { lastEventId: 513, startedAt: 900 },
  ),
  { events: [], lastEventId: 513 },
);

console.log('usb-rotary-input tests passed');
