import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectLifecycle,
  hasUnsavedChanges,
  lifecycleLabel,
  markEdited,
  markInstalled,
  markPersisted,
  replaceProjectSafely,
} from './projectLifecycle.js';

test('edits are distinct from browser, file, card, and recovery persistence', () => {
  let state = createProjectLifecycle();
  state = markEdited(state);
  assert.equal(state.editedRevision, 1);
  assert.equal(lifecycleLabel(state), 'Unsaved changes');

  state = markPersisted(state, 'browser');
  assert.equal(lifecycleLabel(state), 'Saved in browser');
  assert.deepEqual(state.persistence, { destination: 'browser', revision: 1 });

  state = markEdited(state);
  assert.equal(lifecycleLabel(state), 'Unsaved changes');
  state = markPersisted(state, 'file');
  assert.equal(lifecycleLabel(state), 'File downloaded');

  state = markInstalled(state);
  assert.equal(lifecycleLabel(state), 'Installed on card');
  state = markEdited(state);
  assert.equal(lifecycleLabel(state), 'Unsaved changes');
  assert.equal(state.installedRevision, 2);

  state = markPersisted(state, 'recovery');
  assert.equal(lifecycleLabel(state), 'Unsaved changes');
});

test('failed validation leaves the project and undo history untouched', async () => {
  const current = { name: 'Current' };
  const history = ['edit'];
  let applied = false;
  const result = await replaceProjectSafely({
    candidate: { invalid: true }, current, history,
    validate: () => null,
    confirmDiscard: () => true,
    apply: () => { applied = true; },
  });
  assert.equal(result.reason, 'invalid');
  assert.equal(applied, false);
  assert.equal(current.name, 'Current');
  assert.deepEqual(history, ['edit']);
});

test('card acknowledgement installs the requested revision, not a newer edit', () => {
  let state = markEdited(createProjectLifecycle());
  const requestedRevision = state.editedRevision;
  state = markEdited(state);
  state = markInstalled(state, requestedRevision);
  assert.equal(state.installedRevision, 1);
  assert.equal(state.editedRevision, 2);
  assert.equal(lifecycleLabel(state), 'Unsaved changes');
});

test('installing the current revision does not count as saving the project', () => {
  const installedOnly = markInstalled(markEdited(createProjectLifecycle()));
  assert.equal(hasUnsavedChanges(installedOnly), true);
  assert.equal(lifecycleLabel(installedOnly), 'Installed on card');
});

test('unsaved cancel preserves state and successful replace applies only after validation', async () => {
  const calls = [];
  const base = {
    candidate: { name: 'Next' },
    current: { name: 'Current' },
    history: ['edit'],
    validate: value => { calls.push('validate'); return value; },
    apply: value => calls.push(`apply:${value.name}`),
  };
  const cancelled = await replaceProjectSafely({
    ...base,
    dirty: true,
    confirmDiscard: () => { calls.push('confirm'); return false; },
  });
  assert.equal(cancelled.reason, 'cancelled');
  assert.deepEqual(calls, ['validate', 'confirm']);

  calls.length = 0;
  const replaced = await replaceProjectSafely({
    ...base,
    dirty: true,
    confirmDiscard: () => { calls.push('confirm'); return true; },
  });
  assert.equal(replaced.ok, true);
  assert.deepEqual(calls, ['validate', 'confirm', 'apply:Next']);
});
