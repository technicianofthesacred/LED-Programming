import assert from 'node:assert/strict';
import { makeCardRuntimePackage } from '../src/lib/cardRuntimeContract.js';

const pkg = makeCardRuntimePackage({
  projectName: 'Customer Piece',
  mode: 'website-flash',
  led: {
    pixels: 44,
    colorOrder: 'GRB',
    brightnessLimit: 0.5,
    outputs: [{ id: 'main', name: 'Main', pin: 16, pixels: 44 }],
  },
  controls: {
    encoder: {
      a: 4,
      b: 5,
      press: 0,
      alternatePress: 6,
      rotateDirection: 'clockwise-brighter',
      brightnessStep: 18,
      patternCycleIds: ['aurora', 'ember', 'scanner'],
    },
  },
});

const body = JSON.stringify(pkg.config);
assert.match(body, /"mode":"website-flash"/);
assert.match(body, /"patternCycleIds":\["aurora","ember","scanner"\]/);
assert.equal(pkg.config.led.outputs[0].pin, 16);
assert.equal(pkg.config.controls.encoder.press, 0);

console.log('card-installer-package tests passed');
