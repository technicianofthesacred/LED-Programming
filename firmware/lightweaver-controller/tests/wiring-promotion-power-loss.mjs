import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const storage = readFileSync(new URL('../src/LightweaverStorage.cpp', import.meta.url), 'utf8');

function functionBody(name, nextName) {
  const start = storage.indexOf(`bool ${name}(`);
  const end = storage.indexOf(`${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} must be present before ${nextName}`);
  return storage.slice(start, end);
}

function orderedActions(body, definitions) {
  return definitions
    .map(([name, token]) => ({ name, index: body.indexOf(token) }))
    .filter(action => action.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map(action => action.name);
}

function mutate(state, action, rollbackPayload) {
  if (action === 'restore-known-good') {
    if (rollbackPayload === undefined) delete state.knownGood;
    else state.knownGood = rollbackPayload;
  } else if (action === 'disarm') {
    state.armed = false;
  } else if (action === 'drop-journal') {
    delete state.previousKnown;
  } else if (action === 'drop-candidate') {
    delete state.candidateConfig;
  } else if (action === 'drop-candidate-id') {
    delete state.candidateId;
  }
}

function runRestore(state, actions, crashAfter = Infinity) {
  if (!state.armed) return false;
  const rollbackPayload = state.previousKnown;
  let mutations = 0;
  for (const action of actions) {
    mutate(state, action, rollbackPayload);
    mutations += 1;
    if (mutations === crashAfter) return true;
  }
  return false;
}

function runFinalize(state, actions, crashAfter = Infinity) {
  let mutations = 0;
  for (const action of actions) {
    mutate(state, action);
    mutations += 1;
    if (mutations === crashAfter) return true;
  }
  return false;
}

function assertRecoverableRollbackState(state, message) {
  const retryable = state.armed === true && state.previousKnown === 'known-good-v1';
  const restored = state.armed === false && state.knownGood === 'known-good-v1';
  assert.ok(retryable || restored, message);
}

function assertRecoverableCommittedState(state, message) {
  const cleanupRetryable = state.armed === true && state.previousKnown === 'known-good-v1';
  const committed = state.armed === false && state.knownGood === 'candidate-v2';
  assert.ok(cleanupRetryable || committed, message);
}

const restoreBody = functionBody('restorePreviousKnownGood', 'finalizeCommittedPromotion');
const armedRestoreBody = restoreBody.slice(restoreBody.indexOf('String previous'));
const restoreActions = orderedActions(armedRestoreBody, [
  ['restore-known-good', 'prefs.putString(NVS_KNOWN_GOOD_CONFIG_KEY'],
  ['disarm', 'prefs.putBool(NVS_PROMOTION_ARMED_KEY, false)'],
  ['drop-journal', 'prefs.remove(NVS_PREVIOUS_KNOWN_GOOD_KEY'],
]);
assert.deepEqual(restoreActions, ['restore-known-good', 'disarm', 'drop-journal'],
  'rollback must durably disarm before deleting its only recovery payload');

for (let firstCut = 1; firstCut <= restoreActions.length; firstCut += 1) {
  for (let secondCut = 1; secondCut <= restoreActions.length; secondCut += 1) {
    const state = {
      knownGood: 'candidate-v2',
      previousKnown: 'known-good-v1',
      armed: true,
    };
    runRestore(state, restoreActions, firstCut);
    assertRecoverableRollbackState(state, `rollback must remain recoverable after mutation ${firstCut}`);
    runRestore(state, restoreActions, secondCut);
    assertRecoverableRollbackState(state, `rollback must remain recoverable after repeated boot cut ${firstCut}/${secondCut}`);
    runRestore(state, restoreActions);
    assert.equal(state.knownGood, 'known-good-v1');
    assert.equal(state.armed, false);
  }
}

const finalizeBody = functionBody('finalizeCommittedPromotion', 'makeActivationId');
const finalizeActions = orderedActions(finalizeBody, [
  ['disarm', 'prefs.putBool(NVS_PROMOTION_ARMED_KEY, false)'],
  ['drop-journal', 'prefs.remove(NVS_PREVIOUS_KNOWN_GOOD_KEY'],
  ['drop-candidate', 'prefs.remove(NVS_CANDIDATE_CONFIG_KEY'],
  ['drop-candidate-id', 'prefs.remove(NVS_CANDIDATE_ID_KEY'],
]);
assert.deepEqual(finalizeActions, ['disarm', 'drop-journal', 'drop-candidate', 'drop-candidate-id'],
  'committed promotion cleanup must disarm first and idempotently clear all stale transaction payloads');

for (let firstCut = 1; firstCut <= finalizeActions.length; firstCut += 1) {
  for (let secondCut = 1; secondCut <= finalizeActions.length; secondCut += 1) {
    const state = {
      knownGood: 'candidate-v2',
      previousKnown: 'known-good-v1',
      armed: true,
      candidateConfig: 'candidate-v2',
      candidateId: 'activation-2',
    };
    runFinalize(state, finalizeActions, firstCut);
    assertRecoverableCommittedState(state, `commit cleanup must remain recognized after mutation ${firstCut}`);
    runFinalize(state, finalizeActions, secondCut);
    assertRecoverableCommittedState(state, `commit cleanup must remain recognized after repeated cut ${firstCut}/${secondCut}`);
    runFinalize(state, finalizeActions);
    assert.equal(state.knownGood, 'candidate-v2');
    assert.equal(state.armed, false);
    assert.equal(state.previousKnown, undefined);
    assert.equal(state.candidateConfig, undefined);
    assert.equal(state.candidateId, undefined);
  }
}

const saveStart = storage.indexOf('bool saveRuntimeConfigJson(');
const saveEnd = storage.indexOf('bool stageRuntimeConfigJson(', saveStart);
const saveBody = storage.slice(saveStart, saveEnd);
const clearConfirmed = saveBody.indexOf('prefs.remove(NVS_CONFIRMED_ID_KEY)');
const replaceKnownGood = saveBody.indexOf('prefs.putString(NVS_KNOWN_GOOD_CONFIG_KEY, json)');
assert.ok(clearConfirmed >= 0 && replaceKnownGood > clearConfirmed,
  'ordinary known-good writes must fence confirmed activation replay before replacing config identity');

const replayModel = { knownGood: 'config-a', confirmedId: 'activation-a' };
assert.equal(replayModel.confirmedId === 'activation-a', true, 'confirm A is initially replay-safe');
delete replayModel.confirmedId;
replayModel.knownGood = 'config-b';
assert.equal(replayModel.confirmedId === 'activation-a', false,
  'confirm A must be rejected after a same-wiring save B replaces the acknowledged config');

function candidateMetadataValid(state) {
  if (![0, 1, 2, 3].includes(state.candidateState)) return false;
  if (state.candidateState === 3) {
    if (!state.armKeyPresent || !state.candidateConfig || !state.candidateId) return false;
    if (state.armed) return state.previousKnown !== undefined;
    return state.knownGood !== state.candidateConfig;
  }
  if (state.candidateState === 0 && state.armed) {
    return Boolean(state.confirmedId && state.candidateConfig && state.candidateId &&
      state.confirmedId === state.candidateId && state.previousKnown !== undefined &&
      state.knownGood === state.candidateConfig);
  }
  if (state.candidateState === 0 && !state.armed && state.previousKnown !== undefined) {
    return Boolean(state.candidateConfig && state.candidateId &&
      state.confirmedId === state.candidateId && state.knownGood === state.candidateConfig);
  }
  if (state.candidateState === 0 && state.candidateConfig) {
    if (state.knownGood === state.candidateConfig) {
      return Boolean(state.candidateId && state.confirmedId === state.candidateId);
    }
    return true;
  }
  if (state.candidateState === 0 && state.candidateId) {
    return true;
  }
  return !state.armed;
}

function bootDisarmedNoneCleanup(state) {
  if (!candidateMetadataValid(state)) return false;
  const rollbackResidue = (state.candidateConfig && state.knownGood !== state.candidateConfig) ||
    (!state.candidateConfig && state.candidateId && state.confirmedId &&
      state.confirmedId !== state.candidateId);
  if (rollbackResidue) delete state.confirmedId;
  state.armed = false;
  delete state.previousKnown;
  delete state.candidateConfig;
  delete state.candidateId;
  return true;
}

function bootAfterStageCut(state) {
  if (!candidateMetadataValid(state)) return false;
  if (state.candidateState === 0) return bootDisarmedNoneCleanup(state);
  return true;
}

const interruptedPromotion = {
  candidateState: 3,
  armKeyPresent: true,
  armed: true,
  knownGood: 'candidate-v2',
  previousKnown: 'known-good-v1',
  candidateConfig: 'candidate-v2',
  candidateId: 'activation-2',
};
assert.equal(candidateMetadataValid(interruptedPromotion), true);
for (const missing of ['armKeyPresent', 'previousKnown', 'candidateConfig', 'candidateId']) {
  const corrupt = { ...interruptedPromotion };
  if (missing === 'armKeyPresent') corrupt.armKeyPresent = false;
  else delete corrupt[missing];
  assert.equal(candidateMetadataValid(corrupt), false, `missing ${missing} must fail closed`);
  assert.equal(candidateMetadataValid(corrupt), false, `repeated boot with missing ${missing} must remain safe-mode`);
}
for (const corrupt of [
  { ...interruptedPromotion, candidateState: 255 },
  { ...interruptedPromotion, armed: false },
]) {
  assert.equal(candidateMetadataValid(corrupt), false);
  assert.equal(candidateMetadataValid(corrupt), false, 'corrupt metadata must not heal into known-good on repeated boot');
}
const committedWithoutConfirmation = {
  ...interruptedPromotion,
  candidateState: 0,
  armed: false,
};
assert.equal(candidateMetadataValid(committedWithoutConfirmation), false,
  'a committed candidate without its confirmation fence must fail closed');

const mismatchedCommittedIds = {
  ...interruptedPromotion,
  candidateState: 0,
  confirmedId: 'activation-b',
};
assert.equal(candidateMetadataValid(mismatchedCommittedIds), false,
  'a committed candidate must not accept another activation confirmation');
assert.equal(candidateMetadataValid(mismatchedCommittedIds), false,
  'repeated boot must not heal mismatched committed activation ids');

const staleCleanupWithMismatchedIds = {
  ...mismatchedCommittedIds,
  armed: false,
};
assert.equal(candidateMetadataValid(staleCleanupWithMismatchedIds), false,
  'stale committed cleanup must retain mismatched metadata for safe recovery');
assert.equal(candidateMetadataValid(staleCleanupWithMismatchedIds), false,
  'repeated stale cleanup must not erase evidence with mismatched activation ids');

const staleBToA = {
  ...interruptedPromotion,
  candidateState: 0,
  knownGood: 'candidate-a',
  candidateConfig: 'candidate-a',
  candidateId: 'activation-a',
  confirmedId: 'activation-b',
};
assert.equal(candidateMetadataValid(staleBToA), false,
  'stale confirmation B must never authorize committed candidate A');
assert.equal(candidateMetadataValid({ ...staleBToA, armed: false }), false,
  'stale confirmation B must never authorize cleanup of candidate A');

const rollbackResidueWithStaleConfirmation = {
  ...staleCleanupWithMismatchedIds,
  previousKnown: undefined,
  candidateConfig: 'candidate-a',
  candidateId: 'activation-a',
  confirmedId: 'activation-a',
  knownGood: 'candidate-b',
};
assert.equal(candidateMetadataValid(rollbackResidueWithStaleConfirmation), true,
  'an unpromoted candidate may discard any retained confirmation as rollback residue');

const rollbackBody = functionBody('rollbackCandidateRuntimeConfig', 'getRuntimeWiringSafetyStatus');
const rollbackCleanupActions = orderedActions(rollbackBody, [
  ['state-none', 'writeCandidateState(prefs, WIRING_CANDIDATE_NONE)'],
  ['drop-confirmed', 'prefs.remove(NVS_CONFIRMED_ID_KEY)'],
  ['drop-candidate', 'prefs.remove(NVS_CANDIDATE_CONFIG_KEY)'],
  ['drop-candidate-id', 'prefs.remove(NVS_CANDIDATE_ID_KEY)'],
]);
assert.deepEqual(rollbackCleanupActions,
  ['state-none', 'drop-confirmed', 'drop-candidate', 'drop-candidate-id'],
  'rollback must become unbootable, then clear stale confirmation before candidate identity');
for (let cut = 1; cut <= rollbackCleanupActions.length; cut += 1) {
  const state = {
    candidateState: 3,
    armKeyPresent: true,
    armed: false,
    knownGood: 'known-good-v1',
    candidateConfig: 'candidate-v2',
    candidateId: 'activation-2',
  };
  for (const action of rollbackCleanupActions.slice(0, cut)) {
    if (action === 'state-none') state.candidateState = 0;
    if (action === 'drop-candidate') delete state.candidateConfig;
    if (action === 'drop-candidate-id') delete state.candidateId;
    if (action === 'drop-confirmed') delete state.confirmedId;
  }
  assert.equal(candidateMetadataValid(state), true,
    `rollback cleanup cut ${cut} must remain recognizable`);
  assert.equal(bootDisarmedNoneCleanup(state), true,
    `rollback cleanup cut ${cut} must finish without replacing old known-good`);
  assert.equal(state.knownGood, 'known-good-v1');
  assert.equal(bootDisarmedNoneCleanup(state), true,
    `repeated boot after rollback cut ${cut} must remain on old known-good`);
  assert.equal(state.knownGood, 'known-good-v1');
}

for (let cut = 1; cut <= rollbackCleanupActions.length; cut += 1) {
  const state = {
    candidateState: 3,
    armKeyPresent: true,
    armed: false,
    knownGood: 'candidate-b',
    candidateConfig: 'candidate-a',
    candidateId: 'activation-a',
    confirmedId: 'activation-b',
  };
  for (const action of rollbackCleanupActions.slice(0, cut)) {
    if (action === 'state-none') state.candidateState = 0;
    if (action === 'drop-confirmed') delete state.confirmedId;
    if (action === 'drop-candidate') delete state.candidateConfig;
    if (action === 'drop-candidate-id') delete state.candidateId;
  }
  assert.equal(candidateMetadataValid(state), true,
    `stale B / candidate A rollback cut ${cut} must be recognized as residue`);
  assert.equal(bootDisarmedNoneCleanup(state), true);
  assert.equal(state.knownGood, 'candidate-b');
  assert.equal(state.confirmedId, undefined,
    `stale confirmation B must be cleared after rollback cut ${cut}`);
  assert.equal(bootDisarmedNoneCleanup(state), true,
    `repeated boot after stale B / candidate A cut ${cut} must remain known-good B`);
  assert.equal(state.knownGood, 'candidate-b');
}

assert.equal(candidateMetadataValid({
  candidateState: 0,
  armed: false,
  knownGood: 'known-good-v1',
  candidateId: 'activation-2',
}), true, 'an orphan rollback candidate id without confirmation is safe to clear');
assert.equal(candidateMetadataValid({
  candidateState: 0,
  armed: false,
  knownGood: 'known-good-v1',
  confirmedId: 'activation-2',
}), true, 'a clean confirmation replay fence remains valid after committed cleanup');

assert.match(storage, /validateCandidateMetadataForBoot/);
assert.match(storage, /candidate metadata corrupt/);
assert.match(storage, /NVS_NO_PREVIOUS_KNOWN_GOOD/);
assert.match(storage, /confirmedId != candidateId/,
  'firmware must compare the committed confirmation and candidate ids exactly');
assert.match(storage, /knownGood != candidate/,
  'rollback cleanup must be classified by different config identity');
assert.doesNotMatch(storage, /candidate metadata corrupt: orphan confirmation/,
  'the retained confirmation replay fence must remain valid after committed cleanup');

const stageBody = functionBody('stageRuntimeConfigJson', 'activateStagedRuntimeConfig');
const stageValidateMetadata = stageBody.indexOf('validateCandidateMetadataForBoot');
const stageCleanupPrior = stageBody.indexOf('finalizeCommittedPromotion');
const stageClearConfirmation = stageBody.indexOf('prefs.remove(NVS_CONFIRMED_ID_KEY)');
const stageMarkCandidate = stageBody.indexOf('writeCandidateState(prefs, WIRING_CANDIDATE_STAGED)');
assert.ok(stageValidateMetadata >= 0 && stageCleanupPrior > stageValidateMetadata,
  'staging must fail closed on corrupt promotion metadata before cleanup touches its journal');
assert.ok(stageClearConfirmation >= 0 && stageMarkCandidate > stageClearConfirmation,
  'staging must clear the prior confirmation fence before making candidate A bootable');
assert.match(stageBody, /confirmationCleared/,
  'staging must check confirmation-fence removal before committing candidate state');

const stageActions = orderedActions(stageBody, [
  ['store-candidate', 'prefs.putString(NVS_CANDIDATE_CONFIG_KEY, json)'],
  ['store-candidate-id', 'prefs.putString(NVS_CANDIDATE_ID_KEY, activationId)'],
  ['drop-confirmed', 'prefs.remove(NVS_CONFIRMED_ID_KEY)'],
  ['mark-staged', 'writeCandidateState(prefs, WIRING_CANDIDATE_STAGED)'],
]);
assert.deepEqual(stageActions,
  ['store-candidate', 'store-candidate-id', 'drop-confirmed', 'mark-staged'],
  'staging must store identity and clear the old fence before becoming bootable');
for (let cut = 1; cut <= stageActions.length; cut += 1) {
  const state = {
    candidateState: 0,
    armKeyPresent: true,
    armed: false,
    knownGood: 'candidate-b',
    confirmedId: 'activation-b',
  };
  for (const action of stageActions.slice(0, cut)) {
    if (action === 'store-candidate') state.candidateConfig = 'candidate-a';
    if (action === 'store-candidate-id') state.candidateId = 'activation-a';
    if (action === 'drop-confirmed') delete state.confirmedId;
    if (action === 'mark-staged') state.candidateState = 1;
  }
  assert.equal(candidateMetadataValid(state), true,
    `stage cut ${cut} must remain recoverable`);
  assert.equal(bootAfterStageCut(state), true,
    `stage cut ${cut} must boot the old known-good config`);
  assert.equal(state.knownGood, 'candidate-b');
  assert.equal(bootAfterStageCut(state), true,
    `repeated boot after stage cut ${cut} must retain old known-good`);
  assert.equal(state.knownGood, 'candidate-b');
}

assert.match(storage, /knownGood == candidate &&\s*\(!candidateId\.length\(\)/,
  'only candidate bytes already equal to known-good require committed candidate identity');

assert.match(restoreBody,
  /if \(!prefs\.getBool\(NVS_PROMOTION_ARMED_KEY, false\)\) \{[\s\S]*NVS_PREVIOUS_KNOWN_GOOD_KEY[\s\S]*prefs\.remove/,
  'unarmed rollback must durably remove any pre-arm journal before continuing');

const OLD = 'known-good-b';
const CANDIDATE = 'candidate-a';
const ACTIVATION = 'activation-a';
const SENTINEL = '__lightweaver_none__';

function baseState() {
  return {
    candidateState: 0,
    armKeyPresent: true,
    armed: false,
    knownGood: OLD,
  };
}

function applyWrite(state, write) {
  if (write === 'store-candidate') state.candidateConfig = CANDIDATE;
  if (write === 'store-candidate-id') state.candidateId = ACTIVATION;
  if (write === 'drop-confirmed') delete state.confirmedId;
  if (write === 'mark-staged') state.candidateState = 1;
  if (write === 'clear-discovery') state.discoveryActive = false;
  if (write === 'mark-booting') state.candidateState = 2;
  if (write === 'mark-awaiting') state.candidateState = 3;
  if (write === 'write-legacy') state.legacyConfig = state.candidateConfig;
  if (write === 'journal-old') state.previousKnown = state.knownGood ?? SENTINEL;
  if (write === 'arm') state.armed = true;
  if (write === 'promote-candidate') state.knownGood = state.candidateConfig;
  if (write === 'confirm-id') state.confirmedId = state.candidateId;
  if (write === 'mark-none') state.candidateState = 0;
  if (write === 'disarm') state.armed = false;
  if (write === 'drop-journal') delete state.previousKnown;
  if (write === 'drop-candidate') delete state.candidateConfig;
  if (write === 'drop-candidate-id') delete state.candidateId;
  if (write === 'restore-old') {
    if (state.previousKnown === SENTINEL) delete state.knownGood;
    else state.knownGood = state.previousKnown;
  }
}

function finishRollback(state) {
  if (state.armed) {
    applyWrite(state, 'restore-old');
    applyWrite(state, 'disarm');
  }
  applyWrite(state, 'drop-journal');
  applyWrite(state, 'mark-none');
  applyWrite(state, 'drop-confirmed');
  applyWrite(state, 'drop-candidate');
  applyWrite(state, 'drop-candidate-id');
}

function rebootOnce(state) {
  if (!candidateMetadataValid(state)) return 'safe-defaults';
  if (state.candidateState === 1) return 'pending-candidate';
  if (state.candidateState === 2) {
    applyWrite(state, 'mark-awaiting');
    return 'pending-candidate';
  }
  if (state.candidateState === 3) {
    finishRollback(state);
    return state.knownGood === OLD || state.knownGood === undefined
      ? 'old-known-good' : 'unexpected';
  }
  bootDisarmedNoneCleanup(state);
  return state.knownGood === CANDIDATE ? 'confirmed-new-known-good' : 'old-known-good';
}

function assertRepeatedBootConvergence(state, expected, label) {
  const outcomes = [];
  for (let boot = 0; boot < 3; boot += 1) outcomes.push(rebootOnce(state));
  assert.equal(outcomes.includes('safe-defaults'), false, `${label} must never enter safe defaults`);
  assert.equal(outcomes.includes('unexpected'), false, `${label} must stay in a defined recovery state`);
  assert.equal(outcomes.at(-1), expected, `${label} must converge after repeated boots`);
}

const stageWrites = ['store-candidate', 'store-candidate-id', 'drop-confirmed', 'mark-staged'];
for (let cut = 0; cut <= stageWrites.length; cut += 1) {
  const state = baseState();
  state.confirmedId = 'activation-b';
  stageWrites.slice(0, cut).forEach(write => applyWrite(state, write));
  assertRepeatedBootConvergence(state, cut === stageWrites.length ? 'pending-candidate' : 'old-known-good',
    `stage write cut ${cut}`);
}

const stagedState = baseState();
stageWrites.forEach(write => applyWrite(stagedState, write));
const activateWrites = ['clear-discovery', 'mark-booting', 'mark-awaiting'];
for (let cut = 0; cut <= activateWrites.length; cut += 1) {
  const state = { ...stagedState };
  activateWrites.slice(0, cut).forEach(write => applyWrite(state, write));
  assertRepeatedBootConvergence(state, cut >= 2 ? 'old-known-good' : 'pending-candidate',
    `activation/boot write cut ${cut}`);
}

const awaitingState = { ...stagedState, candidateState: 3 };
const confirmWrites = [
  'journal-old', 'arm', 'promote-candidate', 'confirm-id', 'mark-none', 'write-legacy',
  'disarm', 'drop-journal', 'drop-candidate', 'drop-candidate-id',
];
const confirmBody = functionBody('confirmCandidateRuntimeConfig', 'rollbackCandidateRuntimeConfig');
const confirmPrefixWrites = orderedActions(confirmBody, [
  ['journal-old', 'prefs.putString(NVS_PREVIOUS_KNOWN_GOOD_KEY'],
  ['arm', 'prefs.putBool(NVS_PROMOTION_ARMED_KEY, true)'],
  ['promote-candidate', 'prefs.putString(NVS_KNOWN_GOOD_CONFIG_KEY, candidate)'],
  ['confirm-id', 'prefs.putString(NVS_CONFIRMED_ID_KEY, activationId)'],
  ['mark-none', 'writeCandidateState(prefs, WIRING_CANDIDATE_NONE)'],
  ['write-legacy', 'prefs.putString(NVS_LEGACY_CONFIG_KEY, candidate)'],
]);
assert.deepEqual([...confirmPrefixWrites, ...finalizeActions], confirmWrites,
  'confirmation fault model must enumerate the firmware NVS write order');
for (let cut = 0; cut <= confirmWrites.length; cut += 1) {
  const state = { ...awaitingState };
  confirmWrites.slice(0, cut).forEach(write => applyWrite(state, write));
  assertRepeatedBootConvergence(state, cut >= 5 ? 'confirmed-new-known-good' : 'old-known-good',
    `confirmation write cut ${cut}`);
}

const armedRollbackWrites = [
  'restore-old', 'disarm', 'drop-journal', 'mark-none',
  'drop-confirmed', 'drop-candidate', 'drop-candidate-id',
];
for (let cut = 0; cut <= armedRollbackWrites.length; cut += 1) {
  const state = {
    ...awaitingState,
    armed: true,
    previousKnown: OLD,
    knownGood: CANDIDATE,
    confirmedId: ACTIVATION,
  };
  armedRollbackWrites.slice(0, cut).forEach(write => applyWrite(state, write));
  assertRepeatedBootConvergence(state, 'old-known-good', `armed rollback write cut ${cut}`);
  assert.equal(state.knownGood, OLD);
  assert.equal(state.previousKnown, undefined);
}

const rollbackWrites = [
  'drop-journal', 'mark-none', 'drop-confirmed', 'drop-candidate', 'drop-candidate-id',
];
for (const journal of [OLD, SENTINEL]) {
  for (let cut = 0; cut <= rollbackWrites.length; cut += 1) {
    const state = { ...awaitingState, previousKnown: journal };
    if (journal === SENTINEL) delete state.knownGood;
    rollbackWrites.slice(0, cut).forEach(write => applyWrite(state, write));
    assertRepeatedBootConvergence(state, 'old-known-good',
      `pre-arm ${journal === SENTINEL ? 'sentinel' : 'journal'} rollback cut ${cut}`);
    assert.equal(state.previousKnown, undefined,
      `pre-arm journal must be gone after repeated boot cut ${cut}`);
  }
}

console.log('wiring-promotion-power-loss tests passed');
