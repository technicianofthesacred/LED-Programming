import test from 'node:test';
import assert from 'node:assert/strict';
import { cardActionReducer, createCardActionState } from './cardAction.js';

test('card actions become confirmed only after acknowledgement', () => {
  let state = createCardActionState({ confirmedRevision: 3 });
  state = cardActionReducer(state, { type: 'start', revision: 4 });
  assert.equal(state.status, 'pending');
  assert.equal(state.confirmedRevision, 3);
  assert.equal(state.conflictsDisabled, true);
  state = cardActionReducer(state, { type: 'confirm' });
  assert.equal(state.status, 'confirmed');
  assert.equal(state.confirmedRevision, 4);
});

test('failure preserves the prior confirmed revision and can retry', () => {
  let state = createCardActionState({ confirmedRevision: 7 });
  state = cardActionReducer(state, { type: 'start', revision: 8 });
  state = cardActionReducer(state, { type: 'fail', error: 'Card did not answer' });
  assert.equal(state.status, 'failed');
  assert.equal(state.confirmedRevision, 7);
  assert.equal(state.error, 'Card did not answer');
  state = cardActionReducer(state, { type: 'retry' });
  assert.equal(state.status, 'pending');
  assert.equal(state.pendingRevision, 8);
});
