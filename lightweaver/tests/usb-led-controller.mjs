import assert from 'node:assert/strict';
import { LwUsbController } from '../server/lwUsbController.js';

const writes = [];
const preferred = new LwUsbController({ colorOrder: 'grb' });
assert.equal(preferred.status().colorOrder, 'GRB');

const firmwareReported = new LwUsbController();
assert.equal(firmwareReported.status().maxPixels, 600);
firmwareReported.handleLine('LWUSB CONFIG pixels=60 brightness=40 colorOrder=RGB maxPixels=300');
assert.equal(firmwareReported.status().maxPixels, 300);

const controller = new LwUsbController({ maxPixels: 300 });
controller.portPath = '/dev/mock-lightweaver';
controller.port = {
  isOpen: true,
  writableLength: 0,
  write(line, callback) {
    writes.push(line);
    callback?.();
  },
};

controller.sendFrame({ hex: 'ff000000ff000000ff' });
const first = controller.status();

assert.equal(first.lastFramePixels, 3);
assert.equal(first.lastFrameChanged, true);
assert.equal(typeof first.lastFrameHash, 'string');
assert.match(first.lastFrameHash, /^[0-9a-f]{8}$/);
assert.equal(first.lastFrameHead, 'ff000000ff000000ff');
assert.equal(writes.at(-1), 'FRAME ff000000ff000000ff\n');

controller.sendFrame({ hex: 'ff000000ff000000ff' });
const repeated = controller.status();
assert.equal(repeated.lastFrameHash, first.lastFrameHash);
assert.equal(repeated.lastFrameChanged, false);

controller.sendFrame({ hex: '00ff000000ffff0000' });
const changed = controller.status();
assert.notEqual(changed.lastFrameHash, first.lastFrameHash);
assert.equal(changed.lastFrameChanged, true);

controller.handleLine('LWUSB ROTARY turn=clockwise');
controller.handleLine('LWUSB ROTARY press');
const inputStatus = controller.status();
assert.deepEqual(
  inputStatus.inputEvents.map(event => ({ type: event.type, turn: event.turn })),
  [
    { type: 'rotate', turn: 'clockwise' },
    { type: 'press', turn: undefined },
  ],
);
assert.equal(inputStatus.inputEvents[0].source, 'usb-serial');

const backpressure = new LwUsbController({ maxPixels: 300 });
backpressure.portPath = '/dev/mock-lightweaver';
backpressure.port = {
  isOpen: true,
  writableLength: 0,
  write() {},
};
backpressure.sendFrame({ hex: 'ff0000' });
assert.deepEqual(
  backpressure.sendFrame({ hex: '00ff00' }),
  { skipped: true, pixels: 1, reason: 'serial write pending' },
);

console.log('usb-led-controller tests passed');
