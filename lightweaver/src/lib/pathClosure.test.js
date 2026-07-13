import test from 'node:test';
import assert from 'node:assert/strict';

import { isClosedPathData } from './pathClosure.js';

test('detects explicit SVG close commands without changing geometry order', () => {
  assert.equal(isClosedPathData('M 0 0 L 10 0 L 10 10 Z'), true);
  assert.equal(isClosedPathData('M0,0 C1,1 2,2 3,3z   '), true);
  assert.equal(isClosedPathData('M 0 0 L 10 0 L 10 10'), false);
});

test('honors an explicit persisted closed flag before path inference', () => {
  assert.equal(isClosedPathData('M 0 0 L 10 0', true), true);
  assert.equal(isClosedPathData('M 0 0 L 10 0 Z', false), false);
});
