import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_EDIT_AUTHORIZATION_TTL_MS,
  clearCardEditAuthorization,
  consumeCardEditAuthorization,
  ensureCardEditAuthorization,
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

// ── ensureCardEditAuthorization ───────────────────────────────────────────
// A connected, verified, exactly-matching card must be able to receive pattern
// commands after a reload, without a second press of the Setup button — but
// only when every fact the binding asserts is independently evidenced.

const autoBinding = Object.freeze({ ...binding, intent: '' });
const autoEvidence = Object.freeze({
  cardId: 'LW-AABBCCDDEEFF',
  firmwareVersion: '1.2.3',
  buildId: 'build-42',
  bootId: 'boot-7',
  projectId: 'project-1',
  projectFingerprint: 'A'.repeat(64),
  projectRevision: 9,
});
const autoInstallation = Object.freeze({
  cardId: 'lw-aabbccddeeff',
  projectRevision: 9,
  projectFingerprint: 'a'.repeat(64),
  verified: true,
});
const autoRequest = (patch = {}) => ({
  binding: autoBinding,
  cardEvidence: autoEvidence,
  installation: autoInstallation,
  linkReady: true,
  ...patch,
});

test('derives an authorization from a ready link, fresh card evidence, and a verified installation', () => {
  assert.equal(hasCurrentCardProjectAuthorization(autoBinding, { now: NOW }), false);
  assert.equal(ensureCardEditAuthorization(autoRequest(), { now: NOW }), true);
  assert.equal(hasCurrentCardProjectAuthorization(autoBinding, { now: NOW + 1 }), true);
});

test('a derived authorization carries no intent, so it never answers a card handoff claim', () => {
  ensureCardEditAuthorization(autoRequest(), { now: NOW });
  assert.equal(consumeCardEditAuthorization({ ...autoBinding, intent: 'pattern:ocean' }, { now: NOW + 1 }), false);
  // …and the command authorization itself is untouched by the refused claim.
  assert.equal(hasCurrentCardProjectAuthorization(autoBinding, { now: NOW + 2 }), true);
});

test('an existing exact authorization is kept rather than re-issued', () => {
  issueCardEditAuthorization(binding, { now: NOW });
  assert.equal(ensureCardEditAuthorization({ binding, linkReady: false }, { now: NOW + 1 }), true);
  // The intent-bearing grant survived, so the card handoff can still claim it.
  assert.equal(consumeCardEditAuthorization(binding, { now: NOW + 2 }), true);
});

test('refuses to derive an authorization on any break in the evidence chain', () => {
  const refusals = [
    ['link not ready', { linkReady: false }],
    ['link readiness unknown', { linkReady: undefined }],
    ['no card evidence at all', { cardEvidence: null }],
    ['different card', { cardEvidence: { ...autoEvidence, cardId: 'lw-112233445566' } }],
    ['card reports no id', { cardEvidence: { ...autoEvidence, cardId: '' } }],
    ['firmware changed', { cardEvidence: { ...autoEvidence, firmwareVersion: '1.2.4' } }],
    ['build changed', { cardEvidence: { ...autoEvidence, buildId: 'build-43' } }],
    ['stale boot id', { cardEvidence: { ...autoEvidence, bootId: 'boot-8' } }],
    ['card holds another project', { cardEvidence: { ...autoEvidence, projectId: 'project-2' } }],
    ['card fingerprint diverged', { cardEvidence: { ...autoEvidence, projectFingerprint: 'b'.repeat(64) } }],
    ['card reports no revision', { cardEvidence: { ...autoEvidence, projectRevision: null } }],
    ['card revision moved on', { cardEvidence: { ...autoEvidence, projectRevision: 10 } }],
    ['no installation record', { installation: null }],
    ['installation not verified', { installation: { ...autoInstallation, verified: false } }],
    ['installation names another card', { installation: { ...autoInstallation, cardId: 'lw-112233445566' } }],
    ['installation fingerprint diverged', { installation: { ...autoInstallation, projectFingerprint: 'b'.repeat(64) } }],
    ['installation revision diverged', { installation: { ...autoInstallation, projectRevision: 8 } }],
    ['studio project is not the installed one', {
      binding: { ...autoBinding, studioProjectId: 'project-2' },
    }],
    ['studio fingerprint diverged from the card', {
      binding: { ...autoBinding, studioProjectFingerprint: 'b'.repeat(64) },
    }],
    ['binding is incomplete', { binding: { ...autoBinding, bootId: '' } }],
  ];

  for (const [label, patch] of refusals) {
    clearCardEditAuthorization();
    assert.equal(ensureCardEditAuthorization(autoRequest(patch), { now: NOW }), false, label);
    assert.equal(hasCurrentCardProjectAuthorization(autoBinding, { now: NOW + 1 }), false, label);
  }
});

test('a derived authorization lapses and renews exactly like an issued one', () => {
  ensureCardEditAuthorization(autoRequest(), { now: NOW });
  assert.equal(renewCardEditAuthorization(autoBinding, { now: NOW + 1_000 }), true);
  assert.equal(hasCurrentCardProjectAuthorization(autoBinding, {
    now: NOW + 1_000 + CARD_EDIT_AUTHORIZATION_TTL_MS - 1,
  }), true);
  assert.equal(hasCurrentCardProjectAuthorization(autoBinding, {
    now: NOW + 1_000 + CARD_EDIT_AUTHORIZATION_TTL_MS,
  }), false);
});

test('a lapsed derived authorization is re-derived from evidence that still holds', () => {
  ensureCardEditAuthorization(autoRequest(), { now: NOW });
  const lapsed = NOW + CARD_EDIT_AUTHORIZATION_TTL_MS;
  assert.equal(hasCurrentCardProjectAuthorization(autoBinding, { now: lapsed }), false);
  assert.equal(ensureCardEditAuthorization(autoRequest(), { now: lapsed }), true);
  assert.equal(hasCurrentCardProjectAuthorization(autoBinding, { now: lapsed + 1 }), true);
});

test('a refused derivation leaves an unrelated live authorization alone', () => {
  issueCardEditAuthorization(binding, { now: NOW });
  const otherCard = { ...autoBinding, cardId: 'lw-112233445566' };
  assert.equal(ensureCardEditAuthorization(autoRequest({
    binding: otherCard,
    installation: { ...autoInstallation, cardId: 'lw-112233445566' },
  }), { now: NOW + 1 }), false);
  assert.equal(hasCurrentCardProjectAuthorization(binding, { now: NOW + 2 }), true);
});
