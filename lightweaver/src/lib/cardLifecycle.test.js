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

test('a legacy card reporting no fingerprint is ready only through a verified legacy binding', () => {
  const legacyLink = {
    ...READY_LINK,
    readiness: { ...READY_LINK.readiness, projectRevision: 0, projectFingerprint: '' },
  };
  // The verified installation record made against the empty value stands in…
  const bound = deriveCardLifecycle({
    link: legacyLink,
    project: { id: 'piece-a', revision: 0, fingerprint: 'f'.repeat(64), legacyFingerprintBinding: true },
  });
  assert.equal(bound.state, 'ready');
  assert.equal(bound.exactProject, true);
  // …but without that record the empty answer proves nothing.
  const unbound = deriveCardLifecycle({
    link: legacyLink,
    project: { id: 'piece-a', revision: 0, fingerprint: 'f'.repeat(64) },
  });
  assert.equal(unbound.state, 'project-mismatch');
  // A card that reports a real fingerprint must still match it exactly.
  const conflicting = deriveCardLifecycle({
    link: READY_LINK,
    project: { id: 'piece-a', revision: 7, fingerprint: 'b'.repeat(64), legacyFingerprintBinding: true },
  });
  assert.equal(conflicting.state, 'project-mismatch');
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

test('a fresh connect with incomplete readiness evidence is confirming, not attention', () => {
  // The card answered on a verified transport but its readiness envelope has
  // not carried the evidence fields yet — that is a probe in flight, and it
  // used to flash "Needs attention" on every connect.
  const freshConnect = deriveCardLifecycle({
    link: {
      state: 'connected-bridge',
      card: { id: 'lw-card-a' },
      expectedCard: { id: 'lw-card-a' },
      readiness: { cardId: 'lw-card-a' },
    },
  });
  assert.equal(freshConnect.state, 'confirming');
  assert.equal(freshConnect.label, 'Checking card');
  assert.equal(freshConnect.setupTaskId, 'reconnect-card');

  // Any single missing evidence boolean keeps it confirming…
  for (const missing of ['knownGoodProject', 'commandReady', 'outputReady']) {
    const readiness = { ...READY_LINK.readiness };
    delete readiness[missing];
    assert.equal(
      deriveCardLifecycle({ link: { ...READY_LINK, readiness } }).state,
      'confirming',
      `missing ${missing}`,
    );
  }
  // …and a missing bootId keeps an unready answer confirming too (the same
  // evidence-incomplete notion classifyCardReadiness applies), while the
  // command gate still rules once every boolean answers true.
  const noBoot = { ...READY_LINK.readiness, commandReady: false };
  delete noBoot.bootId;
  assert.equal(deriveCardLifecycle({ link: { ...READY_LINK, readiness: noBoot } }).state, 'confirming');

  // …but confirming never outranks real failure, update, or blank evidence.
  assert.equal(deriveCardLifecycle({
    link: { state: 'connected-bridge', card: { id: 'lw-card-a' }, readiness: { cardId: 'lw-card-a' }, activity: 'failed' },
  }).state, 'attention-required');
  assert.equal(deriveCardLifecycle({
    link: { state: 'connected-bridge', card: { id: 'lw-card-a' }, readiness: { cardId: 'lw-card-a' }, cardBlank: true },
  }).state, 'setup-required');
  assert.equal(deriveCardLifecycle({
    link: { state: 'connected-bridge', card: { id: 'lw-card-a' }, expectedCard: { id: 'lw-card-b' }, readiness: { cardId: 'lw-card-a' } },
  }).state, 'wrong-card');
  assert.equal(deriveCardLifecycle({
    link: { state: 'connected-bridge', card: { id: 'lw-card-a' }, readiness: { cardId: 'lw-card-a' } },
    update: { phase: 'blocked', reason: 'target-mismatch' },
  }).state, 'target-mismatch');
});

test('complete-but-failed readiness evidence stays attention-required', () => {
  const refused = deriveCardLifecycle({
    link: { ...READY_LINK, readiness: { ...READY_LINK.readiness, commandReady: false } },
  });
  assert.equal(refused.state, 'attention-required');
  assert.equal(refused.label, 'Needs attention');

  const notReady = deriveCardLifecycle({
    link: {
      ...READY_LINK,
      readiness: { ...READY_LINK.readiness, runtimePhase: 'recovering', commandReady: false },
    },
  });
  assert.equal(notReady.state, 'attention-required');
});

test('a ready→ready poll never passes through confirming', () => {
  const project = { id: 'piece-a', revision: 7, fingerprint: 'a'.repeat(64) };
  const first = deriveCardLifecycle({ link: READY_LINK, project });
  const second = deriveCardLifecycle({
    link: { ...READY_LINK, readiness: { ...READY_LINK.readiness } },
    project,
  });
  assert.equal(first.state, 'ready');
  assert.equal(second.state, 'ready');
});

test('project ids match across the card sanitizing boundary instead of stranding a correct card', () => {
  // The card lowercases and slugifies whatever id it was given before storing
  // it, so a raw string comparison reported a permanent project-mismatch for a
  // card that is in fact holding exactly this project.
  const ready = deriveCardLifecycle({
    link: READY_LINK,
    project: { id: 'Piece A', revision: 7, fingerprint: 'A'.repeat(64) },
  });
  assert.equal(ready.exactProject, true);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.setupTaskId, 'open-patterns');

  // Genuinely different ids still refuse.
  const mismatch = deriveCardLifecycle({
    link: READY_LINK,
    project: { id: 'piece-b', revision: 7, fingerprint: 'a'.repeat(64) },
  });
  assert.equal(mismatch.exactProject, false);
  assert.equal(mismatch.state, 'project-mismatch');
});
