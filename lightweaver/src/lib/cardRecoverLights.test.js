import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverCardLightsVerified, requireExactReadyCardStatus } from './cardRecoverLights.js';

const READY_STATUS = Object.freeze({
  cardId: 'lw-recover-test',
  runtimePhase: 'ready',
  knownGoodProject: true,
  commandReady: true,
  outputReady: true,
});

test('requireExactReadyCardStatus accepts an exact ready answer', () => {
  assert.equal(requireExactReadyCardStatus({ ...READY_STATUS }, 'lw-recover-test').cardId, 'lw-recover-test');
});

test('requireExactReadyCardStatus refuses a different card by name', () => {
  assert.throws(
    () => requireExactReadyCardStatus({ ...READY_STATUS, cardId: 'lw-impostor' }, 'lw-recover-test'),
    /A different card answered the hardware check/,
  );
});

test('requireExactReadyCardStatus refuses a half-ready runtime', () => {
  for (const broken of [
    { runtimePhase: 'recovering' },
    { knownGoodProject: false },
    { commandReady: false },
    { outputReady: false },
  ]) {
    assert.throws(
      () => requireExactReadyCardStatus({ ...READY_STATUS, ...broken }, 'lw-recover-test'),
      /runtime or LED output is not ready/,
    );
  }
});

test('send-only recovery forwards look and options and never reads status', async () => {
  const sends = [];
  let statusReads = 0;
  const response = await recoverCardLightsVerified(
    { patternId: 'warm-white', brightness: 1, syncZones: true },
    {
      host: 'lightweaver.local',
      timeoutMs: 3200,
      restartCard: true,
      recoverImpl: async (look, options) => { sends.push({ look, options }); return { ok: true, restarted: true }; },
      readStatusImpl: async () => { statusReads += 1; return READY_STATUS; },
    },
  );
  assert.equal(response.restarted, true);
  assert.equal(statusReads, 0);
  assert.deepEqual(sends[0].look, { patternId: 'warm-white', brightness: 1, syncZones: true });
  assert.deepEqual(sends[0].options, { host: 'lightweaver.local', timeoutMs: 3200, restartCard: true });
});

test('verified recovery reads back the same host and requires the expected card', async () => {
  const statusHosts = [];
  const response = await recoverCardLightsVerified(
    { patternId: 'warm-white', brightness: 0.35, syncZones: true },
    {
      host: 'lightweaver.local',
      timeoutMs: 3200,
      verifyReadback: { expectedCardId: 'lw-recover-test' },
      recoverImpl: async () => ({ ok: true, restarted: false }),
      readStatusImpl: async ({ host }) => { statusHosts.push(host); return { ...READY_STATUS }; },
    },
  );
  assert.equal(response.ok, true);
  assert.deepEqual(statusHosts, ['lightweaver.local']);

  await assert.rejects(
    recoverCardLightsVerified({}, {
      host: 'lightweaver.local',
      verifyReadback: { expectedCardId: 'lw-recover-test' },
      recoverImpl: async () => ({ ok: true }),
      readStatusImpl: async () => ({ ...READY_STATUS, cardId: 'lw-impostor' }),
    }),
    /A different card answered the hardware check/,
  );
});
