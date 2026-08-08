import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearAbandonedCardEditIntent,
  isCardEditIntentAbandoned,
  markCardEditIntentAbandoned,
  readCardEditIntent,
  searchWithoutCardEditIntent,
} from './cardEditIntent.js';

test('the intent is whatever the owner asked the card to open', () => {
  assert.equal(readCardEditIntent('?editPattern=aurora'), 'pattern:aurora');
  assert.equal(readCardEditIntent('?editLook=warm-drift'), 'look:warm-drift');
  assert.equal(readCardEditIntent('?editPattern=aurora&editLook=warm-drift'), 'pattern:aurora');
  assert.equal(readCardEditIntent('?cardHost=lightweaver.local'), '');
  assert.equal(readCardEditIntent(''), '');
  assert.equal(readCardEditIntent('?editPattern=%20%20'), '');
});

test('an abandoned intent is remembered outside any component, because both screens remount', () => {
  // This is the circuit breaker. Patterns fails to claim, returns to the card,
  // and every once-only guard either screen owns is reset by the remount — so
  // the memory of the failure has to live somewhere neither of them can clear
  // by being rebuilt.
  clearAbandonedCardEditIntent();
  assert.equal(isCardEditIntentAbandoned('pattern:aurora'), false);

  markCardEditIntentAbandoned('pattern:aurora');
  assert.equal(isCardEditIntentAbandoned('pattern:aurora'), true);

  // Only that intent. Asking for something else is a new request, not a retry.
  assert.equal(isCardEditIntentAbandoned('pattern:ocean'), false);
  assert.equal(isCardEditIntentAbandoned('look:warm-drift'), false);
  // And "no intent at all" is never abandoned, whatever is remembered.
  assert.equal(isCardEditIntentAbandoned(''), false);
  assert.equal(isCardEditIntentAbandoned(null), false);

  clearAbandonedCardEditIntent();
  assert.equal(isCardEditIntentAbandoned('pattern:aurora'), false);
});

test('a later intent replaces the remembered one rather than accumulating', () => {
  markCardEditIntentAbandoned('pattern:aurora');
  markCardEditIntentAbandoned('look:warm-drift');
  assert.equal(isCardEditIntentAbandoned('look:warm-drift'), true);
  assert.equal(isCardEditIntentAbandoned('pattern:aurora'), false);
  clearAbandonedCardEditIntent();
});

test('the intent survives in the URL, so loading the project by hand still honours it', () => {
  // Deliberately NOT stripped on failure: `?editPattern=ocean` is still what
  // the owner came for. Only the automatic hand-over is suppressed.
  markCardEditIntentAbandoned('pattern:ocean');
  assert.equal(readCardEditIntent('?editPattern=ocean'), 'pattern:ocean');
  clearAbandonedCardEditIntent();
});

test('an honoured intent is removed so a reload cannot replay it', () => {
  assert.equal(searchWithoutCardEditIntent('?editPattern=aurora'), '');
  assert.equal(
    searchWithoutCardEditIntent('?cardHost=lightweaver.local&editPattern=aurora'),
    '?cardHost=lightweaver.local',
  );
  assert.equal(searchWithoutCardEditIntent('?editLook=warm-drift&v=3'), '?v=3');
  // Nothing to remove reports so, rather than rewriting the URL for nothing.
  assert.equal(searchWithoutCardEditIntent('?v=3'), null);
  assert.equal(searchWithoutCardEditIntent(''), null);
});
