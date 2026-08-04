import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('Studio card and production mutations publish the shared hardware-operation signal', async () => {
  const [cardPushSource, productionSource] = await Promise.all([
    readFile(new URL('../components/layout/shared/CardPushControl.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../v3/lw-production.jsx', import.meta.url), 'utf8'),
  ]);

  for (const operation of ['install-project', 'activate-wiring', 'finish-wiring']) {
    assert.match(cardPushSource, new RegExp(`withStudioHardwareOperation\\('${operation}'`));
  }
  for (const operation of [
    'production-usb-release',
    'production-usb-reset',
    'production-firmware-install',
    'production-artwork-restore',
    'production-physical-recovery',
  ]) {
    assert.match(productionSource, new RegExp(`beginStudioHardwareOperation\\('${operation}'`));
  }
});

test('Studio applies operation signals to freshness synchronously before React effects run', async () => {
  const appSource = await readFile(new URL('../v3/app.jsx', import.meta.url), 'utf8');

  assert.match(appSource, /hardwareOperationActiveRef\.current = active;[\s\S]*?setOperationActive\([\s\S]*?installActiveRef\.current \|\| active \|\| commissioningActiveRef\.current/);
  assert.match(appSource, /installActiveRef\.current = active;[\s\S]*?setOperationActive\([\s\S]*?active \|\| hardwareOperationActiveRef\.current \|\| commissioningActiveRef\.current/);
});
