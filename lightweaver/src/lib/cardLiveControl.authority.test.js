import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIVE_CONTROL_AUTHORITY_MESSAGES,
  createLiveControlAuthorityGate,
  decideLiveControlProjectAuthority,
  requireResetLiveOutputReadback,
  resetLiveOutputOnCard,
} from './cardLiveControl.js';

const studioProject = {
  projectId: 'piece-a',
  projectFingerprint: 'fingerprint-a',
  patternIds: ['fire', 'aurora'],
  startupPatternId: 'aurora',
  looks: [{ id: 'aurora', patternId: 'aurora', brightness: 0.42, speed: 1.3 }],
};
const readyStatus = {
  app: 'Lightweaver', runtimePhase: 'ready', knownGoodProject: true,
  commandReady: true, outputReady: true, playbackReady: true,
  projectId: 'piece-a', projectFingerprint: 'fingerprint-a',
  currentPatternId: 'aurora', startupPatternId: 'aurora',
};

test('live-control authority distinguishes disconnected, runtime readiness, project mismatch, and ready', () => {
  assert.deepEqual(decideLiveControlProjectAuthority({ connected: false, studioProject, cardStatus: readyStatus }), {
    ok: false, state: 'disconnected', message: LIVE_CONTROL_AUTHORITY_MESSAGES.disconnected,
  });
  assert.deepEqual(decideLiveControlProjectAuthority({
    connected: true, studioProject, cardStatus: { ...readyStatus, playbackReady: false, commandReady: false },
  }), {
    ok: false, state: 'not-ready', message: LIVE_CONTROL_AUTHORITY_MESSAGES['not-ready'],
  });
  assert.deepEqual(decideLiveControlProjectAuthority({
    connected: true, studioProject, cardStatus: { ...readyStatus, projectId: 'piece-b' },
  }), {
    ok: false, state: 'project-mismatch', message: LIVE_CONTROL_AUTHORITY_MESSAGES['project-mismatch'],
  });
  assert.deepEqual(decideLiveControlProjectAuthority({ connected: true, studioProject, cardStatus: readyStatus }), {
    ok: true, state: 'ready', message: '',
  });
  assert.deepEqual(decideLiveControlProjectAuthority({
    connected: true,
    studioProject,
    cardStatus: { ...readyStatus, runtimePhase: 'recovering', commandReady: false, playbackReady: true },
  }), {
    ok: true, state: 'ready', message: '',
  });
});

test('a live pattern absent from the installed matching Studio project is refused', () => {
  assert.deepEqual(decideLiveControlProjectAuthority({
    connected: true, studioProject, cardStatus: readyStatus, patternId: 'ocean',
  }), {
    ok: false,
    state: 'project-mismatch',
    reason: 'pattern-not-installed',
    message: LIVE_CONTROL_AUTHORITY_MESSAGES['pattern-not-installed'],
  });
});

test('an active frame sender stops admitting frames after project mismatch or readiness loss', () => {
  const gate = createLiveControlAuthorityGate({ connected: true, studioProject, cardStatus: readyStatus });
  const frames = [];
  const send = frame => {
    if (gate.canSend()) frames.push(frame);
  };

  send('authorized');
  assert.equal(gate.update({
    connected: true,
    studioProject,
    cardStatus: { ...readyStatus, projectFingerprint: 'different-project' },
  }).state, 'project-mismatch');
  send('mismatched');
  assert.equal(gate.update({
    connected: true,
    studioProject,
    cardStatus: { ...readyStatus, playbackReady: false, commandReady: false },
  }).state, 'not-ready');
  send('not-ready');

  assert.deepEqual(frames, ['authorized']);
});

test('reset readback accepts only the installed startup look on the matching ready project', () => {
  assert.equal(requireResetLiveOutputReadback(readyStatus, studioProject).currentPatternId, 'aurora');
  assert.throws(
    () => requireResetLiveOutputReadback({ ...readyStatus, currentPatternId: 'blackout' }, studioProject),
    error => error?.reason === 'reset-readback-unconfirmed',
  );
  assert.throws(
    () => requireResetLiveOutputReadback({ ...readyStatus, projectFingerprint: 'other' }, studioProject),
    error => error?.reason === 'project-mismatch',
  );
});

test('Reset Live recovers the installed startup look and succeeds only after fresh matching readback', async () => {
  const recoveries = [];
  const result = await resetLiveOutputOnCard({ patternId: 'fire', brightness: 80 }, {
    host: '192.168.18.70',
    studioProject,
    recoverImpl: async (look, options) => {
      recoveries.push({ look, host: options.host });
      return { ok: true, recovered: true };
    },
    readStatusImpl: async () => readyStatus,
  });

  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].host, '192.168.18.70');
  assert.equal(recoveries[0].look.patternId, 'aurora');
  assert.equal(recoveries[0].look.brightness, 0.42);
  assert.equal(recoveries[0].look.speed, 1.3);
  assert.equal(result.source, 'startup-recovery');
  assert.equal(result.status.currentPatternId, 'aurora');

  await assert.rejects(
    resetLiveOutputOnCard({ patternId: 'fire' }, {
      studioProject,
      recoverImpl: async () => ({ ok: true }),
      readStatusImpl: async () => ({ ...readyStatus, currentPatternId: 'blackout' }),
    }),
    error => error?.reason === 'reset-readback-unconfirmed',
  );
});

test('preset-named startup resolves to its exact installed look identity and rejects card-selected alternatives', async () => {
  const presetProject = {
    projectId: 'piece-a',
    projectFingerprint: 'fingerprint-a',
    startupPatternId: 'aurora',
    looks: [
      { id: 'look-dawn', preset: 'aurora', brightness: 0.31, speed: 0.8 },
      { id: 'look-fire', preset: 'fire', brightness: 0.7 },
    ],
  };
  const recoveries = [];
  const correctStatus = {
    ...readyStatus,
    currentPatternId: 'look-dawn',
    startupPatternId: 'aurora',
  };
  await resetLiveOutputOnCard({}, {
    studioProject: presetProject,
    recoverImpl: async look => {
      recoveries.push(look);
      return { ok: true };
    },
    readStatusImpl: async () => correctStatus,
  });

  assert.equal(recoveries[0].patternId, 'look-dawn');
  assert.equal(recoveries[0].brightness, 0.31);
  assert.equal(requireResetLiveOutputReadback(correctStatus, presetProject).currentPatternId, 'look-dawn');
  assert.throws(
    () => requireResetLiveOutputReadback({
      ...correctStatus,
      currentPatternId: 'look-fire',
      startupPatternId: 'fire',
    }, presetProject),
    error => error?.reason === 'reset-readback-unconfirmed',
  );
});
