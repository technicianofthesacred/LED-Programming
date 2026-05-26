import assert from 'node:assert/strict';
import {
  COLOR_ORDERS,
  normalizeUsbLedColorOrder,
  makeUsbLedColorOrderCommand,
} from '../src/lib/usbLedColorOrder.js';

assert.deepEqual(COLOR_ORDERS, ['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR']);
assert.equal(normalizeUsbLedColorOrder('rgb'), 'RGB');
assert.equal(normalizeUsbLedColorOrder(' grb '), 'GRB');
assert.equal(normalizeUsbLedColorOrder('nope'), 'RGB');
assert.equal(makeUsbLedColorOrderCommand('bgr'), 'ORDER BGR');

console.log('usb-led-color-order tests passed');
