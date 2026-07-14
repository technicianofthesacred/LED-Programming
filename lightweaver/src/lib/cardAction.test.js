import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHYSICAL_PREVIEW_FAILURE_MESSAGE,
  cardActionReducer,
  cardActionStatusLabel,
  createCardActionState,
} from './cardAction.js';

test('card actions become confirmed only after acknowledgement', () => {
  let state = createCardActionState({ confirmedRevision: 3 });
  state = cardActionReducer(state, { type: 'start', revision: 4 });
  assert.equal(state.status, 'pending');
  assert.equal(state.confirmedRevision, 3);
  assert.equal(state.conflictsDisabled, true);
  state = cardActionReducer(state, { type: 'confirm', revision: 4 });
  assert.equal(state.status, 'confirmed');
  assert.equal(state.confirmedRevision, 4);
  assert.equal(cardActionStatusLabel(state), 'Playing on Lightweaver');
});

test('failure preserves the prior confirmed revision and can retry', () => {
  let state = createCardActionState({ confirmedRevision: 7 });
  state = cardActionReducer(state, { type: 'start', revision: 8 });
  state = cardActionReducer(state, { type: 'fail', revision: 8, error: 'Card did not answer' });
  assert.equal(state.status, 'failed');
  assert.equal(state.confirmedRevision, 7);
  assert.equal(state.error, 'Card did not answer');
  state = cardActionReducer(state, { type: 'retry' });
  assert.equal(state.status, 'pending');
  assert.equal(state.pendingRevision, 8);
  assert.equal(state.conflictsDisabled, true);
});

test('card action labels distinguish Studio preview, sending, and physical playback', () => {
  let state = createCardActionState();
  assert.equal(cardActionStatusLabel(state), 'Previewing in Studio');
  state = cardActionReducer(state, { type: 'start', revision: 11 });
  assert.equal(cardActionStatusLabel(state), 'Sending to Lightweaver');
  state = cardActionReducer(state, { type: 'confirm', revision: 11 });
  assert.equal(cardActionStatusLabel(state), 'Playing on Lightweaver');
});

test('superseded confirmations and failures cannot replace the latest physical intent', () => {
  let state = createCardActionState({ confirmedRevision: 2 });
  state = cardActionReducer(state, { type: 'start', revision: 3 });
  state = cardActionReducer(state, { type: 'start', revision: 4 });
  const afterOldConfirm = cardActionReducer(state, { type: 'confirm', revision: 3 });
  assert.strictEqual(afterOldConfirm, state);
  const afterOldFailure = cardActionReducer(state, { type: 'fail', revision: 3, error: 'late failure' });
  assert.strictEqual(afterOldFailure, state);
  state = cardActionReducer(state, { type: 'confirm', revision: 4 });
  assert.equal(state.confirmedRevision, 4);
});

test('physical preview failure has one exact recovery message', () => {
  assert.equal(
    PHYSICAL_PREVIEW_FAILURE_MESSAGE,
    'The Studio preview changed, but the physical lights did not. Reconnect and retry.',
  );
  let state = cardActionReducer(createCardActionState(), { type: 'start', revision: 9 });
  state = cardActionReducer(state, { type: 'fail', revision: 9 });
  assert.equal(state.error, PHYSICAL_PREVIEW_FAILURE_MESSAGE);
  assert.equal(state.confirmedRevision, null);
});
