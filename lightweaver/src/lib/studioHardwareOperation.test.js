import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STUDIO_HARDWARE_OPERATION_EVENT,
  beginStudioHardwareOperation,
  withStudioHardwareOperation,
} from './studioHardwareOperation.js';

test('hardware operation signal remains active until every overlapping operation ends', () => {
  const windowRef = new EventTarget();
  const events = [];
  windowRef.addEventListener(STUDIO_HARDWARE_OPERATION_EVENT, event => events.push(event.detail));

  const finishInstall = beginStudioHardwareOperation('install-project', windowRef);
  const finishRecovery = beginStudioHardwareOperation('production-recovery', windowRef);
  finishInstall();
  finishInstall();
  assert.deepEqual(events, [{ active: true, operation: 'install-project' }]);
  finishRecovery();
  assert.deepEqual(events, [
    { active: true, operation: 'install-project' },
    { active: false, operation: 'production-recovery' },
  ]);
});

test('hardware operation wrapper always clears its aggregate signal after failure', async () => {
  const windowRef = new EventTarget();
  const states = [];
  windowRef.addEventListener(STUDIO_HARDWARE_OPERATION_EVENT, event => states.push(event.detail.active));
  await assert.rejects(
    withStudioHardwareOperation('install-project', async () => { throw new Error('write failed'); }, windowRef),
    /write failed/,
  );
  assert.deepEqual(states, [true, false]);
});
