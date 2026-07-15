import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PHYSICAL_PREVIEW_FAILURE_MESSAGE,
  cardActionReducer,
  cardActionStatusLabel,
  classifyCardActionFailure,
  createCardActionState,
} from './cardAction.js';

test('classifies old card software without exposing the thrown message', () => {
  for (const reason of ['identity-missing', 'firmware-too-old']) {
    assert.deepEqual(
      classifyCardActionFailure({ reason, message: '<script>owned</script>' }),
      {
        code: reason,
        message: 'This card is running old software and cannot confirm physical previews. Update the card, then retry.',
        actionId: 'update-card',
        actionLabel: 'Update card',
      },
    );
  }
});

test('classifies the wrong card with an explicit identity recovery', () => {
  assert.deepEqual(classifyCardActionFailure({ reason: 'wrong-card' }), {
    code: 'wrong-card',
    message: 'Studio reached a different Lightweaver card. Reconnect the expected card, or explicitly choose this card.',
    actionId: 'reconnect-card',
    actionLabel: 'Reconnect card',
  });
});

test('classifies a missing local bridge with a card-page recovery', () => {
  assert.deepEqual(classifyCardActionFailure({ reason: 'bridge-missing' }), {
    code: 'bridge-missing',
    message: 'The local card page is not open. Reopen it, then retry the physical preview.',
    actionId: 'open-card-page',
    actionLabel: 'Open card page',
  });
});

test('classifies timeouts and a closed card page with a bounded retry', () => {
  for (const reason of ['timeout', 'bridge-timeout', 'card-page-closed']) {
    assert.deepEqual(classifyCardActionFailure({ reason }), {
      code: 'timeout',
      message: 'The card did not answer in time. Reconnect if needed, then retry the physical preview.',
      actionId: 'retry',
      actionLabel: 'Retry',
    });
  }
});

test('classifies a card rejection with fixed inspection guidance', () => {
  assert.deepEqual(classifyCardActionFailure({ code: 'card-rejected', message: 'user-controlled rejection' }), {
    code: 'card-rejected',
    message: 'The card rejected the physical preview. Open the card page to inspect the reported problem before retrying.',
    actionId: 'open-card-page',
    actionLabel: 'Open card page',
  });
});

test('classifies unconfirmed physical output with a lights recovery', () => {
  assert.deepEqual(classifyCardActionFailure({ reason: 'physical-output-unconfirmed' }), {
    code: 'physical-output-unconfirmed',
    message: 'The preview reached the card, but the lights did not confirm physical output. Verify the LED wiring or recover the lights.',
    actionId: 'recover-lights',
    actionLabel: 'Recover lights',
  });
});

test('unknown failures remain bounded and never render arbitrary thrown text', () => {
  const failure = classifyCardActionFailure(new Error('private host response with <script>markup</script>'));
  assert.deepEqual(failure, {
    code: 'unknown',
    message: 'The physical preview could not be confirmed. Check the card connection and try again.',
    actionId: '',
    actionLabel: '',
  });
  assert.ok(failure.message.length < 160);
  assert.doesNotMatch(failure.message, /private|script|markup/);
});

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
