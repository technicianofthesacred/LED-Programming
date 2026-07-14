import test from 'node:test';
import assert from 'node:assert/strict';

import { BOARD_CONTROL_FIELDS, planBoardGpioAssignment } from './gpioAssignments.js';

const outputs = [{ id: 'out1', pin: 16 }, { id: 'out2', pin: 17 }];
const controls = {
  encoder: { a: 4, b: 5, press: 0, alternatePress: 6 },
  previous: 7, next: 8, blackout: 9, brightness: -1, statusLed: 2,
};

test('board GPIO planner updates outputs and nested controls without mutating input', () => {
  const outputPlan = planBoardGpioAssignment({ outputs, controls, target: { kind: 'output', id: 'out1' }, pin: 38, supportedOutputPins: [16, 17, 38] });
  assert.equal(outputPlan.ok, true);
  assert.equal(outputPlan.outputs[0].pin, 38);
  assert.equal(outputs[0].pin, 16);
  const controlPlan = planBoardGpioAssignment({ outputs, controls, target: { kind: 'control', key: 'encoderA' }, pin: 10, supportedOutputPins: [16, 17, 38] });
  assert.equal(controlPlan.ok, true);
  assert.equal(controlPlan.controls.encoder.a, 10);
  assert.equal(controls.encoder.a, 4);
  assert.equal(BOARD_CONTROL_FIELDS.length, 9);
});

test('board GPIO planner rejects duplicate active pins and invalid ranges', () => {
  const duplicateOutput = planBoardGpioAssignment({ outputs, controls, target: { kind: 'output', id: 'out2' }, pin: 16, supportedOutputPins: [16, 17, 38] });
  assert.equal(duplicateOutput.ok, false);
  assert.match(duplicateOutput.error, /already assigned/i);
  const duplicateControl = planBoardGpioAssignment({ outputs, controls, target: { kind: 'control', key: 'previous' }, pin: 16, supportedOutputPins: [16, 17, 38] });
  assert.equal(duplicateControl.ok, false);
  assert.match(duplicateControl.error, /already assigned/i);
  assert.equal(planBoardGpioAssignment({ outputs, controls, target: { kind: 'control', key: 'brightness' }, pin: -1 }).ok, true);
  assert.equal(planBoardGpioAssignment({ outputs, controls, target: { kind: 'control', key: 'brightness' }, pin: 49 }).ok, false);
});
