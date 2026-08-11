import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveCardLifecycle } from './cardLifecycle.js';

const READY_LINK = Object.freeze({
  state: 'connected-direct',
  card: { id: 'lw-card-a' },
  expectedCard: { id: 'lw-card-a' },
  readiness: {
    cardId: 'lw-card-a',
    bootId: 'boot-2',
    runtimePhase: 'ready',
    commandReady: true,
    outputReady: true,
    playbackReady: true,
    knownGoodProject: true,
    projectId: 'piece-a',
    projectFingerprint: 'a'.repeat(64),
  },
});

test('one lifecycle orders exact failures ahead of generic connection copy', () => {
  const cases = [
    [{ link: { state: 'disconnected' } }, 'disconnected', 'Not connected', 'connect-card'],
    [{ link: { state: 'reconnecting' } }, 'reconnecting', 'Card stopped responding', 'reconnect-card'],
    [{ link: { state: 'revalidating', reason: 'card-restarted' } }, 'verifying', 'Card restarted — verifying', 'reconnect-card'],
    [{ link: { reason: 'wrong-card' } }, 'wrong-card', 'Wrong card', 'connect-card'],
    [{ update: { phase: 'rolled-back', reason: 'boot-health-failed' } }, 'update-rolled-back', 'Update rolled back', 'recover-operation'],
    [{ link: { reason: 'firmware-too-old' } }, 'update-required', 'Needs attention', 'update-firmware'],
    [{ link: { ...READY_LINK, cardBlank: true } }, 'setup-required', 'Needs project', 'install-project'],
  ];

  for (const [input, state, label, setupTaskId] of cases) {
    assert.deepEqual(
      { state: deriveCardLifecycle(input).state, label: deriveCardLifecycle(input).label, setupTaskId: deriveCardLifecycle(input).setupTaskId },
      { state, label, setupTaskId },
    );
  }
});

test('safe commands require the exact ready installed project', () => {
  const input = {
    link: READY_LINK,
    project: { id: 'piece-a', fingerprint: 'a'.repeat(64) },
  };
  const ready = deriveCardLifecycle(input);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.exactCard, true);
  assert.equal(ready.exactProject, true);
  assert.equal(ready.safeControlAccess, 'ready');

  const wrongProject = deriveCardLifecycle({
    ...input,
    project: { id: 'piece-b', fingerprint: 'b'.repeat(64) },
  });
  assert.equal(wrongProject.state, 'project-mismatch');
  assert.equal(wrongProject.safeControlAccess, 'project-mismatch');
  assert.equal(wrongProject.setupTaskId, 'load-matching-project');

  const wrongFingerprint = deriveCardLifecycle({
    ...input,
    project: { id: 'piece-a', fingerprint: 'b'.repeat(64) },
  });
  assert.equal(wrongFingerprint.state, 'project-mismatch');
});

test('transport identity and all runtime readiness fields stay fail-closed', () => {
  const project = { id: 'piece-a', fingerprint: 'a'.repeat(64) };
  assert.equal(deriveCardLifecycle({
    link: { ...READY_LINK, expectedCard: { id: 'lw-card-b' } },
    project,
  }).state, 'wrong-card');

  for (const field of ['commandReady', 'outputReady', 'playbackReady']) {
    const lifecycle = deriveCardLifecycle({
      link: { ...READY_LINK, readiness: { ...READY_LINK.readiness, [field]: false } },
      project,
    });
    assert.equal(lifecycle.state, 'attention-required');
    assert.equal(lifecycle.safeControlAccess, 'attention-required');
  }
});
