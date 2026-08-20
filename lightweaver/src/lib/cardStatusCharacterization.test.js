import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveCardLifecycle } from './cardLifecycle.js';

// Characterization baseline for the card-interaction consolidation (phase 3).
// Each row is a representative cardLink shape and the exact
// {state, label, setupTaskId} deriveCardLifecycle answers for it. The rows
// were recorded against the pre-phase code and then updated ONLY where the
// new `confirming` state legitimately changes the verdict — those rows are
// marked `// CHANGED (phase 3):` with the before value, so the semantic diff
// of this phase is readable in one place.

const FP = 'a'.repeat(64);
const COMPLETE_READINESS = Object.freeze({
  cardId: 'lw-fixture',
  bootId: 'boot-1',
  runtimePhase: 'ready',
  knownGoodProject: true,
  commandReady: true,
  outputReady: true,
  playbackReady: true,
  projectId: 'piece-a',
  projectRevision: 3,
  projectFingerprint: FP,
});
const VERIFIED_LINK = Object.freeze({
  state: 'connected-bridge',
  card: { id: 'lw-fixture' },
  expectedCard: { id: 'lw-fixture' },
  readiness: COMPLETE_READINESS,
});
const MATCHING_PROJECT = Object.freeze({ id: 'piece-a', revision: 3, fingerprint: FP });

const ROWS = [
  ['disconnected, no history', { link: { state: 'disconnected' } },
    { state: 'disconnected', label: 'Not connected', setupTaskId: 'connect-card' }],
  ['disconnected, never connected', { link: { state: 'disconnected', reason: 'never-connected' } },
    { state: 'disconnected', label: 'Not connected', setupTaskId: 'connect-card' }],
  ['disconnected, card unreachable', { link: { state: 'disconnected', reason: 'card-unreachable' } },
    { state: 'disconnected', label: 'Not connected', setupTaskId: 'connect-card' }],
  ['connecting transport', { link: { state: 'connecting' } },
    { state: 'connecting', label: 'Connecting', setupTaskId: 'connect-card' }],
  ['operation pending on a live link', { link: { ...VERIFIED_LINK, activity: 'pending' } },
    { state: 'connecting', label: 'Connecting', setupTaskId: 'connect-card' }],
  ['operation recovering', { link: { state: 'connecting', activity: 'recovering' } },
    { state: 'recovering', label: 'Recovering', setupTaskId: 'recover-operation' }],
  ['reconnecting after silence', { link: { state: 'reconnecting' } },
    { state: 'reconnecting', label: 'Card stopped responding', setupTaskId: 'reconnect-card' }],
  ['bridge reconnecting', { link: { state: 'reconnecting-bridge' } },
    { state: 'reconnecting', label: 'Card stopped responding', setupTaskId: 'reconnect-card' }],
  ['revalidating after card restart', { link: { state: 'revalidating', reason: 'card-restarted' } },
    { state: 'verifying', label: 'Card restarted — verifying', setupTaskId: 'reconnect-card' }],
  ['revalidating for stability', { link: { state: 'revalidating' } },
    { state: 'verifying', label: 'Card restarted — verifying', setupTaskId: 'reconnect-card' }],
  ['found but unpaired', { link: { state: 'disconnected', reason: 'found-unpaired' } },
    { state: 'found-unpaired', label: 'Found — pair', setupTaskId: 'pair-card' }],
  ['popup blocked', { link: { state: 'disconnected', reason: 'popup-blocked' } },
    { state: 'attention-required', label: 'Needs attention', setupTaskId: 'recover-operation' }],
  ['operation failed', { link: { state: 'disconnected', activity: 'failed' } },
    { state: 'attention-required', label: 'Needs attention', setupTaskId: 'recover-operation' }],
  ['operation uncertain', { link: { state: 'disconnected', reason: 'operation-uncertain' } },
    { state: 'attention-required', label: 'Needs attention', setupTaskId: 'recover-operation' }],
  ['wrong card answered', {
    link: { ...VERIFIED_LINK, expectedCard: { id: 'lw-other' } },
  }, { state: 'wrong-card', label: 'Wrong card', setupTaskId: 'connect-card' }],
  ['firmware too old', { link: { state: 'disconnected', reason: 'firmware-too-old' } },
    { state: 'update-required', label: 'Needs attention', setupTaskId: 'update-firmware' }],
  ['blank card on verified transport', { link: { ...VERIFIED_LINK, cardBlank: true } },
    { state: 'setup-required', label: 'Needs project', setupTaskId: 'install-project' }],
  // Fork 1: a verified transport whose readiness evidence has not arrived yet.
  // CHANGED (phase 3): was attention-required / 'Needs attention' / recover-operation.
  ['connected bridge, incomplete readiness evidence (fresh connect)', {
    link: {
      state: 'connected-bridge',
      card: { id: 'lw-fixture' },
      expectedCard: { id: 'lw-fixture' },
      readiness: { cardId: 'lw-fixture' },
    },
  }, { state: 'confirming', label: 'Checking card', setupTaskId: 'reconnect-card' }],
  // CHANGED (phase 3): was attention-required / 'Needs attention' / recover-operation.
  ['connected bridge, commandReady still null', {
    link: {
      ...VERIFIED_LINK,
      readiness: { ...COMPLETE_READINESS, commandReady: null },
    },
  }, { state: 'confirming', label: 'Checking card', setupTaskId: 'reconnect-card' }],
  ['connected bridge, complete evidence but command refused', {
    link: {
      ...VERIFIED_LINK,
      readiness: { ...COMPLETE_READINESS, commandReady: false },
    },
  }, { state: 'attention-required', label: 'Needs attention', setupTaskId: 'recover-operation' }],
  ['connected bridge, complete evidence but runtime not ready', {
    link: {
      ...VERIFIED_LINK,
      readiness: { ...COMPLETE_READINESS, runtimePhase: 'recovering', commandReady: false },
    },
  }, { state: 'attention-required', label: 'Needs attention', setupTaskId: 'recover-operation' }],
  ['ready card, project mismatch', {
    link: VERIFIED_LINK,
    project: { id: 'piece-b', revision: 3, fingerprint: 'b'.repeat(64) },
  }, { state: 'project-mismatch', label: 'Needs attention', setupTaskId: 'load-matching-project' }],
  ['ready card, exact project', { link: VERIFIED_LINK, project: MATCHING_PROJECT },
    { state: 'ready', label: 'Connected', setupTaskId: 'open-patterns' }],
  ['update preflight', { link: VERIFIED_LINK, update: { phase: 'preflight' } },
    { state: 'updating', label: 'Updating card', setupTaskId: 'recover-operation' }],
  ['update sending', { link: VERIFIED_LINK, update: { phase: 'sending' } },
    { state: 'updating', label: 'Updating card', setupTaskId: 'recover-operation' }],
  ['update restarting', { link: VERIFIED_LINK, update: { phase: 'restarting' } },
    { state: 'update-recovering', label: 'Restarting card', setupTaskId: 'recover-operation' }],
  ['update rolled back', { link: VERIFIED_LINK, update: { phase: 'rolled-back', reason: 'boot-health-failed' } },
    { state: 'update-rolled-back', label: 'Update rolled back', setupTaskId: 'recover-operation' }],
  ['update blocked: wrong card', { link: VERIFIED_LINK, update: { phase: 'blocked', reason: 'wrong-card' } },
    { state: 'wrong-card', label: 'Wrong card', setupTaskId: 'connect-card' }],
  ['update blocked: target mismatch', { link: VERIFIED_LINK, update: { phase: 'blocked', reason: 'target-mismatch' } },
    { state: 'target-mismatch', label: 'Needs attention', setupTaskId: 'update-firmware' }],
  ['update blocked: project changed', { link: VERIFIED_LINK, update: { phase: 'blocked', reason: 'project-changed' } },
    { state: 'project-changed', label: 'Needs attention', setupTaskId: 'load-matching-project' }],
  ['update timed out', { link: VERIFIED_LINK, update: { phase: 'timeout' } },
    { state: 'attention-required', label: 'Needs attention', setupTaskId: 'recover-operation' }],
];

test('deriveCardLifecycle characterization table', () => {
  for (const [name, input, expected] of ROWS) {
    const lifecycle = deriveCardLifecycle(input);
    assert.deepEqual(
      { state: lifecycle.state, label: lifecycle.label, setupTaskId: lifecycle.setupTaskId },
      expected,
      name,
    );
  }
});

test('a ready→ready poll never passes through a transitional state', () => {
  const first = deriveCardLifecycle({ link: VERIFIED_LINK, project: MATCHING_PROJECT });
  const second = deriveCardLifecycle({
    link: { ...VERIFIED_LINK, readiness: { ...COMPLETE_READINESS } },
    project: MATCHING_PROJECT,
  });
  assert.equal(first.state, 'ready');
  assert.equal(second.state, 'ready');
});
