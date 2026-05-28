import assert from 'node:assert/strict';
import {
  COLOR_ORDERS,
  normalizeUsbLedColorOrder,
  makeUsbLedColorOrderCommand,
  makeUsbLedCalibrationPixels,
  nextUsbLedColorOrder,
} from '../src/lib/usbLedColorOrder.js';

assert.deepEqual(COLOR_ORDERS, ['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR']);
assert.equal(normalizeUsbLedColorOrder('rgb'), 'RGB');
assert.equal(normalizeUsbLedColorOrder(' grb '), 'GRB');
assert.equal(normalizeUsbLedColorOrder('nope'), 'RGB');
assert.equal(makeUsbLedColorOrderCommand('bgr'), 'ORDER BGR');
assert.equal(nextUsbLedColorOrder('RGB'), 'GRB');
assert.equal(nextUsbLedColorOrder('GBR'), 'RGB');
assert.equal(nextUsbLedColorOrder('nope'), 'GRB');

assert.deepEqual(makeUsbLedCalibrationPixels(6), [
  { r: 255, g: 0, b: 0 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 0, g: 0, b: 255 },
]);
assert.deepEqual(makeUsbLedCalibrationPixels(2), [
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
]);

console.log('usb-led-color-order tests passed');
