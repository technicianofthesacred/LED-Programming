import assert from 'node:assert/strict';
import { LwUsbController } from '../server/lwUsbController.js';

const writes = [];
const controller = new LwUsbController({ maxPixels: 300 });
controller.portPath = '/dev/mock-lightweaver';
controller.port = {
  isOpen: true,
  writableLength: 0,
  write(line) {
    writes.push(line);
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

console.log('usb-led-controller tests passed');
