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
    projectRevision: 7,
    projectFingerprint: 'a'.repeat(64),
  },
});

test('one lifecycle orders exact failures ahead of generic connection copy', () => {
  const cases = [
    [{ link: { state: 'disconnected' } }, 'disconnected', 'Not connected', 'connect-card'],
    [{ link: { state: 'connecting' } }, 'connecting', 'Connecting', 'connect-card'],
    [{ link: { state: 'disconnected', reason: 'found-unpaired' } }, 'found-unpaired', 'Found — pair', 'pair-card'],
    [{ link: { state: 'connecting', activity: 'recovering' } }, 'recovering', 'Recovering', 'recover-operation'],
    [{ link: { state: 'reconnecting' } }, 'reconnecting', 'Card stopped responding', 'reconnect-card'],
    [{ link: { state: 'revalidating', reason: 'card-restarted' } }, 'verifying', 'Card restarted — verifying', 'reconnect-card'],
    [{ link: { reason: 'wrong-card' } }, 'wrong-card', 'Wrong card', 'connect-card'],
    [{ update: { phase: 'rolled-back', reason: 'boot-health-failed' } }, 'update-rolled-back', 'Update rolled back', 'recover-operation'],
    [{ update: { phase: 'sending' } }, 'updating', 'Updating card', 'recover-operation'],
    [{ update: { phase: 'restarting' } }, 'update-recovering', 'Restarting card', 'recover-operation'],
    [{ update: { phase: 'blocked', reason: 'wrong-card' } }, 'wrong-card', 'Wrong card', 'connect-card'],
    [{ update: { phase: 'blocked', reason: 'target-mismatch' } }, 'target-mismatch', 'Needs attention', 'update-firmware'],
    [{ update: { phase: 'blocked', reason: 'project-changed' } }, 'project-changed', 'Needs attention', 'load-matching-project'],
    [{ link: { reason: 'firmware-too-old' } }, 'update-required', 'Needs attention', 'update-firmware'],
    [{ link: { ...READY_LINK, cardBlank: true } }, 'setup-required', 'Needs project', 'install-project'],
    [{ link: READY_LINK, project: { id: 'piece-b', revision: 7, fingerprint: 'b'.repeat(64) } }, 'project-mismatch', 'Needs attention', 'load-matching-project'],
    [{ link: READY_LINK, project: { id: 'piece-a', revision: 7, fingerprint: 'a'.repeat(64) } }, 'ready', 'Connected', 'open-patterns'],
    [{ link: { ...READY_LINK, readiness: { ...READY_LINK.readiness, firmwareUpdate: { phase: 'rolled-back', rollbackReason: 'health-check-failed' } } } }, 'update-rolled-back', 'Update rolled back', 'recover-operation'],
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
    project: { id: 'piece-a', revision: 7, fingerprint: 'a'.repeat(64) },
  };
  const ready = deriveCardLifecycle(input);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.exactCard, true);
  assert.equal(ready.exactProject, true);
  assert.equal(ready.safeControlAccess, 'ready');

  const wrongProject = deriveCardLifecycle({
    ...input,
    project: { id: 'piece-b', revision: 7, fingerprint: 'b'.repeat(64) },
  });
  assert.equal(wrongProject.state, 'project-mismatch');
  assert.equal(wrongProject.safeControlAccess, 'project-mismatch');
  assert.equal(wrongProject.setupTaskId, 'load-matching-project');

  const wrongFingerprint = deriveCardLifecycle({
    ...input,
    project: { id: 'piece-a', revision: 7, fingerprint: 'b'.repeat(64) },
  });
  assert.equal(wrongFingerprint.state, 'project-mismatch');

  const wrongRevision = deriveCardLifecycle({
    ...input,
    project: { id: 'piece-a', revision: 8, fingerprint: 'a'.repeat(64) },
  });
  assert.equal(wrongRevision.state, 'project-mismatch');
  assert.equal(wrongRevision.exactRevision, false);
});

test('transport identity and all runtime readiness fields stay fail-closed', () => {
  const project = { id: 'piece-a', revision: 7, fingerprint: 'a'.repeat(64) };
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
