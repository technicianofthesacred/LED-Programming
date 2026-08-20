import test from 'node:test';
import assert from 'node:assert/strict';

import { CARD_TASK_COPY, cardTaskCopy } from './cardTaskCopy.js';
import { SETUP_TASK_IDS } from './setupJourney.js';

test('the task copy table covers exactly the setup task vocabulary', () => {
  assert.deepEqual(Object.keys(CARD_TASK_COPY).sort(), [...SETUP_TASK_IDS].sort());
  for (const taskId of SETUP_TASK_IDS) {
    assert.equal(typeof CARD_TASK_COPY[taskId], 'string');
    assert.ok(CARD_TASK_COPY[taskId].length > 0, taskId);
  }
});

test('unknown task ids fall back to the generic continue line', () => {
  assert.equal(cardTaskCopy('not-a-task'), 'Continue the exact next Setup task.');
  assert.equal(cardTaskCopy(''), 'Continue the exact next Setup task.');
  assert.equal(cardTaskCopy('open-patterns'), 'Setup is complete. Continue to your patterns.');
});
