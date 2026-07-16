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

console.log('wiring-promotion-power-loss tests passed');
