import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_EDIT_AUTHORIZATION_TTL_MS,
  clearCardEditAuthorization,
  consumeCardEditAuthorization,
  hasCurrentCardProjectAuthorization,
  issueCardEditAuthorization,
  issueSignedProductionCardEditAuthorization,
  renewCardEditAuthorization,
} from './cardEditAuthorization.js';

const NOW = 10_000;
const binding = Object.freeze({
  intent: 'pattern:ocean',
  cardId: 'lw-aabbccddeeff',
  firmwareVersion: '1.2.3',
  buildId: 'build-42',
  bootId: 'boot-7',
  installedProjectId: 'project-1',
  installedProjectFingerprint: 'a'.repeat(64),
  studioProjectId: 'project-1',
  studioProjectFingerprint: 'a'.repeat(64),
  projectGeneration: 4,
});

test.afterEach(() => clearCardEditAuthorization());

test('never consumes an exact intent before authorization is issued', () => {
  assert.equal(consumeCardEditAuthorization(binding, { now: NOW }), false);
  assert.equal(hasCurrentCardProjectAuthorization(binding, { now: NOW }), false);
});

test('consumes an exact card-edit intent once while retaining command authorization', () => {
  issueCardEditAuthorization(binding, { now: NOW });

  assert.equal(consumeCardEditAuthorization(binding, { now: NOW + 1 }), true);
  assert.equal(consumeCardEditAuthorization(binding, { now: NOW + 2 }), false);
  assert.equal(hasCurrentCardProjectAuthorization(binding, { now: NOW + 2 }), true);
});

test('binds authorization to every intent, card, installed-project, Studio-project, and lifecycle field', () => {
  const mutations = {
    intent: 'look:saved-look',
    cardId: 'lw-112233445566',
    firmwareVersion: '1.2.4',
    buildId: 'build-43',
    bootId: 'boot-8',
    installedProjectId: 'project-2',
    installedProjectFingerprint: 'b'.repeat(64),
    studioProjectId: 'project-2',
    studioProjectFingerprint: 'b'.repeat(64),
    projectGeneration: 5,
  };

  for (const [field, value] of Object.entries(mutations)) {
    clearCardEditAuthorization();
    issueCardEditAuthorization(binding, { now: NOW });
    const changed = { ...binding, [field]: value };
    assert.equal(
      field === 'intent'
        ? consumeCardEditAuthorization(changed, { now: NOW + 1 })
        : hasCurrentCardProjectAuthorization(changed, { now: NOW + 1 }),
      false,
      `${field} must be exact`,
    );
  }
});

test('refuses to issue for mismatched or incomplete installed and Studio projects', () => {
  assert.equal(issueCardEditAuthorization({
    ...binding,
    studioProjectFingerprint: 'b'.repeat(64),
  }, { now: NOW }), false);
  assert.equal(issueCardEditAuthorization({ ...binding, bootId: '' }, { now: NOW }), false);
  assert.equal(hasCurrentCardProjectAuthorization(binding, { now: NOW }), false);
});

test('signed production authorization binds a verified legacy fingerprint to the exact Studio fingerprint', () => {
  const productionBinding = {
    ...binding,
    installedProjectFingerprint: 'a'.repeat(16),
    studioProjectFingerprint: 'b'.repeat(64),
  };
  const signedProject = {
    jobId: 'job-42',
    jobDigest: 'c'.repeat(64),
    projectId: productionBinding.installedProjectId,
    projectFingerprint: productionBinding.installedProjectFingerprint,
  };

  assert.equal(issueSignedProductionCardEditAuthorization(
    productionBinding,
    signedProject,
    { now: NOW },
  ), true);
  assert.equal(hasCurrentCardProjectAuthorization(productionBinding, { now: NOW + 1 }), true);
  assert.equal(hasCurrentCardProjectAuthorization({
    ...productionBinding,
    installedProjectFingerprint: 'd'.repeat(16),
  }, { now: NOW + 1 }), false);
  assert.equal(hasCurrentCardProjectAuthorization({
    ...productionBinding,
    studioProjectFingerprint: 'e'.repeat(64),
  }, { now: NOW + 1 }), false);
});

test('signed production authorization rejects incomplete or mismatched signed proof', () => {
  const productionBinding = {
    ...binding,
    installedProjectFingerprint: 'a'.repeat(16),
    studioProjectFingerprint: 'b'.repeat(64),
  };
  const signedProject = {
    jobId: 'job-42',
    jobDigest: 'c'.repeat(64),
    projectId: productionBinding.installedProjectId,
    projectFingerprint: productionBinding.installedProjectFingerprint,
  };
  const invalidProofs = [
    { ...signedProject, projectId: 'project-2' },
    { ...signedProject, projectFingerprint: 'd'.repeat(16) },
    { ...signedProject, jobId: '' },
    { ...signedProject, jobId: 'job id with spaces' },
    { ...signedProject, jobDigest: '' },
    { ...signedProject, jobDigest: 'c'.repeat(63) },
  ];

  for (const proof of invalidProofs) {
    clearCardEditAuthorization();
    assert.equal(issueSignedProductionCardEditAuthorization(
      productionBinding,
      proof,
      { now: NOW },
    ), false);
    assert.equal(hasCurrentCardProjectAuthorization(productionBinding, { now: NOW + 1 }), false);
  }
});

test('expires in memory and a reload-style clear revokes it immediately', () => {
  issueCardEditAuthorization(binding, { now: NOW });
  assert.equal(hasCurrentCardProjectAuthorization(binding, {
    now: NOW + CARD_EDIT_AUTHORIZATION_TTL_MS - 1,
  }), true);
  assert.equal(hasCurrentCardProjectAuthorization(binding, {
    now: NOW + CARD_EDIT_AUTHORIZATION_TTL_MS,
  }), false);

  issueCardEditAuthorization(binding, { now: NOW });
  clearCardEditAuthorization();
  assert.equal(hasCurrentCardProjectAuthorization(binding, { now: NOW + 1 }), false);
});

test('issuing a new exact context revokes the previous one', () => {
  issueCardEditAuthorization(binding, { now: NOW });
  const next = { ...binding, intent: '', bootId: 'boot-8' };
  issueCardEditAuthorization(next, { now: NOW + 1 });

  assert.equal(hasCurrentCardProjectAuthorization(binding, { now: NOW + 2 }), false);
  assert.equal(hasCurrentCardProjectAuthorization(next, { now: NOW + 2 }), true);
});

// ── renewal (the fix for the 120s wall clock) ────────────────────────────────
// The old TTL revoked live-preview authority two minutes after the Hardware
// screen issued it, even with the card still connected, still matching, and
// still being re-verified before every send. Renewal replaces the wall clock
// with "the bound facts are still being confirmed" — without touching the
// identity binding that carries the actual safety property.

test('renewal keeps a still-true authorization alive far past the old 120s TTL', () => {
  const OLD_TTL = 120_000;
  issueCardEditAuthorization(binding, { now: NOW });

  // A readiness poll / pre-send evidence read lands inside the window and
  // re-confirms the exact binding.
  assert.equal(renewCardEditAuthorization(binding, { now: NOW + 60_000 }), true);

  // Past the old TTL, and past it again after another confirmation.
  assert.equal(hasCurrentCardProjectAuthorization(binding, { now: NOW + OLD_TTL + 1 }), true);
  assert.equal(renewCardEditAuthorization(binding, { now: NOW + OLD_TTL + 1 }), true);
  assert.equal(hasCurrentCardProjectAuthorization(binding, {
    now: NOW + OLD_TTL + CARD_EDIT_AUTHORIZATION_TTL_MS,
  }), true);
});

test('renewal is refused, and the authorization revoked, once the binding diverges', () => {
  const divergentBindings = [
    ['studio project edited', { studioProjectFingerprint: 'b'.repeat(64) }],
    ['card project replaced', { installedProjectFingerprint: 'c'.repeat(64) }],
    ['different project opened', { studioProjectId: 'project-2' }],
    ['card rebooted', { bootId: 'boot-8' }],
    ['different card', { cardId: 'lw-ffeeddccbbaa' }],
    ['firmware changed', { firmwareVersion: '1.2.4' }],
    ['build changed', { buildId: 'build-43' }],
    ['project generation advanced', { projectGeneration: 5 }],
  ];

  for (const [label, patch] of divergentBindings) {
    clearCardEditAuthorization();
    issueCardEditAuthorization(binding, { now: NOW });
    const diverged = { ...binding, ...patch };

    assert.equal(renewCardEditAuthorization(diverged, { now: NOW + 1 }), false, label);
    assert.equal(hasCurrentCardProjectAuthorization(diverged, { now: NOW + 2 }), false, label);
    // Repeated renewal attempts never talk the diverged binding into authority,
    // and it is still refused past the point the old wall clock would have
    // expired the authorization anyway.
    assert.equal(renewCardEditAuthorization(diverged, { now: NOW + 130_000 }), false, label);
    assert.equal(hasCurrentCardProjectAuthorization(diverged, {
      now: NOW + CARD_EDIT_AUTHORIZATION_TTL_MS * 2,
    }), false, label);
  }
});

test('renewal never issues: it cannot resurrect a lapsed or absent authorization', () => {
  assert.equal(renewCardEditAuthorization(binding, { now: NOW }), false);
  assert.equal(hasCurrentCardProjectAuthorization(binding, { now: NOW + 1 }), false);

  issueCardEditAuthorization(binding, { now: NOW });
  const lapsed = NOW + CARD_EDIT_AUTHORIZATION_TTL_MS;
  assert.equal(renewCardEditAuthorization(binding, { now: lapsed }), false);
  assert.equal(hasCurrentCardProjectAuthorization(binding, { now: lapsed + 1 }), false);
});

test('a card that stops confirming still lapses on the staleness window', () => {
  issueCardEditAuthorization(binding, { now: NOW });
  assert.equal(hasCurrentCardProjectAuthorization(binding, {
    now: NOW + CARD_EDIT_AUTHORIZATION_TTL_MS - 1,
  }), true);
  assert.equal(hasCurrentCardProjectAuthorization(binding, {
    now: NOW + CARD_EDIT_AUTHORIZATION_TTL_MS,
  }), false);
});
