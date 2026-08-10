import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearActiveUsbInspection,
  getActiveUsbInspection,
  registerActiveUsbInspection,
  releaseActiveUsbInspection,
} from './usbInspection.js';

test.afterEach(() => clearActiveUsbInspection());

test('active USB inspection reports exact identity and releases once', async () => {
  let releases = 0;
  const token = registerActiveUsbInspection({
    cardId: 'lw-b0fe81f61b44',
    release: async () => { releases += 1; return true; },
  });
  assert.deepEqual(getActiveUsbInspection(), token);
  const [first, second] = await Promise.all([
    releaseActiveUsbInspection(), releaseActiveUsbInspection(),
  ]);
  assert.equal(first.released, true);
  assert.equal(second.released, true);
  assert.equal(releases, 1);
  assert.equal(getActiveUsbInspection(), null);
});

test('failed release preserves active inspection so the caller cannot probe LAN', async () => {
  const token = registerActiveUsbInspection({
    cardId: 'lw-b0fe81f61b44', release: async () => false,
  });
  assert.equal((await releaseActiveUsbInspection()).released, false);
  assert.equal(getActiveUsbInspection(), token);
});

test('an old screen cannot clear a newer inspection', () => {
  const oldToken = registerActiveUsbInspection({ cardId: 'lw-old', release: async () => true });
  const currentToken = registerActiveUsbInspection({ cardId: 'lw-current', release: async () => true });
  assert.equal(clearActiveUsbInspection(oldToken), false);
  assert.equal(getActiveUsbInspection(), currentToken);
});

test('a newer inspection has its own release while an older release finishes', async () => {
  let finishOld;
  let currentReleases = 0;
  registerActiveUsbInspection({
    cardId: 'lw-old',
    release: () => new Promise(resolve => { finishOld = resolve; }),
  });
  const oldRelease = releaseActiveUsbInspection();
  registerActiveUsbInspection({
    cardId: 'lw-current',
    release: async () => { currentReleases += 1; return true; },
  });
  const currentRelease = await releaseActiveUsbInspection();
  assert.equal(currentRelease.cardId, 'lw-current');
  assert.equal(currentReleases, 1);
  assert.equal(getActiveUsbInspection(), null);
  finishOld(true);
  assert.equal((await oldRelease).cardId, 'lw-old');
});
