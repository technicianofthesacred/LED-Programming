import assert from 'node:assert/strict';
import {
  estimateLwUsbFrameBytes,
  getLwUsbSerialSafeFps,
  normalizeLwUsbPixelCount,
  pixelsToLwUsbFrameHex,
} from '../src/lib/usbLedFrame.js';

assert.equal(
  pixelsToLwUsbFrameHex([
    { r: 255, g: 128.4, b: 0 },
    { r: -20, g: 10, b: 999 },
  ]),
  'ff8000000aff',
);

assert.equal(
  pixelsToLwUsbFrameHex([
    { r: 1, g: 2, b: 3 },
    { r: 4, g: 5, b: 6 },
  ], { maxPixels: 1 }),
  '010203',
);

assert.equal(pixelsToLwUsbFrameHex(null), '');

assert.equal(normalizeLwUsbPixelCount(60), 60);
assert.equal(normalizeLwUsbPixelCount('120'), 120);
assert.equal(normalizeLwUsbPixelCount(0), 1);
assert.equal(normalizeLwUsbPixelCount(999, { maxPixels: 300 }), 300);

assert.equal(estimateLwUsbFrameBytes(43), 265);
assert.equal(getLwUsbSerialSafeFps(43, { baudRate: 115200, maxFps: 18 }), 18);
assert.equal(getLwUsbSerialSafeFps(300, { baudRate: 115200, maxFps: 18 }), 3);
assert.equal(getLwUsbSerialSafeFps(300, { baudRate: 921600, maxFps: 18 }), 18);

console.log('usb-led-frame tests passed');
