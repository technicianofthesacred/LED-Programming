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
const restoreActions = orderedActions(restoreBody, [
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
  if (state.candidateState === 0 && state.candidateConfig) {
    if (!state.candidateId) return false;
    if (state.knownGood === state.candidateConfig) {
      return state.confirmedId === state.candidateId;
    }
    return !state.confirmedId;
  }
  if (state.candidateState === 0 && state.candidateId) {
    return !state.confirmedId || state.confirmedId === state.candidateId;
  }
  return !state.armed;
}

function bootDisarmedNoneCleanup(state) {
  if (!candidateMetadataValid(state)) return false;
  delete state.previousKnown;
  delete state.candidateConfig;
  delete state.candidateId;
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

const staleCleanupWithWrongKnownGood = {
  ...staleCleanupWithMismatchedIds,
  candidateConfig: 'candidate-a',
  candidateId: 'activation-a',
  confirmedId: 'activation-a',
  knownGood: 'candidate-b',
};
assert.equal(candidateMetadataValid(staleCleanupWithWrongKnownGood), false,
  'stale cleanup must require exact candidate and known-good identity');

const rollbackBody = functionBody('rollbackCandidateRuntimeConfig', 'getRuntimeWiringSafetyStatus');
const rollbackCleanupActions = orderedActions(rollbackBody, [
  ['state-none', 'writeCandidateState(prefs, WIRING_CANDIDATE_NONE)'],
  ['drop-candidate', 'prefs.remove(NVS_CANDIDATE_CONFIG_KEY)'],
  ['drop-candidate-id', 'prefs.remove(NVS_CANDIDATE_ID_KEY)'],
  ['drop-confirmed', 'prefs.remove(NVS_CONFIRMED_ID_KEY)'],
]);
assert.deepEqual(rollbackCleanupActions,
  ['state-none', 'drop-candidate', 'drop-candidate-id', 'drop-confirmed'],
  'rollback must make the candidate unbootable before removing transaction identity');
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
assert.match(storage, /knownGood != candidate && confirmedId\.length\(\)/,
  'rollback cleanup must be classified by different config identity and no confirmation');
assert.doesNotMatch(storage, /candidate metadata corrupt: orphan confirmation/,
  'the retained confirmation replay fence must remain valid after committed cleanup');

console.log('wiring-promotion-power-loss tests passed');
