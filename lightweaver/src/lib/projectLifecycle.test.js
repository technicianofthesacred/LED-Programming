import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectLifecycle,
  hasUnsavedChanges,
  lifecycleForRestoredProject,
  lifecycleLabel,
  lifecycleRecordFromState,
  markEdited,
  markInstalled,
  markPersisted,
  markRestored,
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

test('a fresh lifecycle is clean: no unsaved changes, no discard guard', () => {
  const state = createProjectLifecycle();
  assert.equal(lifecycleLabel(state), 'New project');
  assert.equal(hasUnsavedChanges(state), false);
});

test('restored-unsaved work is labelled distinctly and still guards discard', () => {
  let state = markRestored(createProjectLifecycle());
  assert.equal(lifecycleLabel(state), 'Restored from recovery copy');
  assert.equal(hasUnsavedChanges(state), true, 'restored work must guard New/Load until saved');

  state = markEdited(state);
  assert.equal(lifecycleLabel(state), 'Unsaved changes');
  assert.equal(hasUnsavedChanges(state), true);

  state = markPersisted(state, 'browser');
  assert.equal(lifecycleLabel(state), 'Saved in browser');
  assert.equal(hasUnsavedChanges(state), false);
});

test('saving a restored project without edits releases the guard', () => {
  const state = markPersisted(markRestored(createProjectLifecycle()), 'file');
  assert.equal(lifecycleLabel(state), 'File downloaded');
  assert.equal(hasUnsavedChanges(state), false);
});

test('lifecycle record captures dirty/persisted/installed truthfully', () => {
  assert.deepEqual(lifecycleRecordFromState(createProjectLifecycle()), {
    version: 1, dirty: false, persistedDestination: null, installed: false,
  });

  const dirty = markEdited(createProjectLifecycle());
  assert.deepEqual(lifecycleRecordFromState(dirty), {
    version: 1, dirty: true, persistedDestination: null, installed: false,
  });

  const saved = markPersisted(dirty, 'browser');
  assert.deepEqual(lifecycleRecordFromState(saved), {
    version: 1, dirty: false, persistedDestination: 'browser', installed: false,
  });

  const staleSave = markEdited(saved);
  assert.deepEqual(lifecycleRecordFromState(staleSave), {
    version: 1, dirty: true, persistedDestination: null, installed: false,
  });

  const installed = markInstalled(markPersisted(staleSave, 'file'));
  assert.deepEqual(lifecycleRecordFromState(installed), {
    version: 1, dirty: false, persistedDestination: 'file', installed: true,
  });

  const restoredUnsaved = markRestored(createProjectLifecycle());
  assert.equal(lifecycleRecordFromState(restoredUnsaved).dirty, true);
});

test('boot lifecycle from a record: saved states survive reload, dirty ones restore guarded', () => {
  // Saved in browser before reload → still "Saved in browser" after.
  const savedBoot = lifecycleForRestoredProject({
    version: 1, dirty: false, persistedDestination: 'browser', installed: false,
  });
  assert.equal(lifecycleLabel(savedBoot), 'Saved in browser');
  assert.equal(hasUnsavedChanges(savedBoot), false);

  // Installed + saved keeps the stronger label.
  const installedBoot = lifecycleForRestoredProject({
    version: 1, dirty: false, persistedDestination: 'file', installed: true,
  });
  assert.equal(lifecycleLabel(installedBoot), 'Installed on card');
  assert.equal(hasUnsavedChanges(installedBoot), false);

  // Dirty before reload → restored-unsaved (guarded) after.
  const dirtyBoot = lifecycleForRestoredProject({
    version: 1, dirty: true, persistedDestination: null, installed: false,
  });
  assert.equal(lifecycleLabel(dirtyBoot), 'Restored from recovery copy');
  assert.equal(hasUnsavedChanges(dirtyBoot), true);

  // No record at all (or unknown version) → restored-unsaved, guarded.
  const noRecord = lifecycleForRestoredProject(null);
  assert.equal(lifecycleLabel(noRecord), 'Restored from recovery copy');
  assert.equal(hasUnsavedChanges(noRecord), true);
  assert.equal(hasUnsavedChanges(lifecycleForRestoredProject({ version: 99 })), true);

  // Clean, never-persisted record = untouched default project → stays "New
  // project" with no guard (reloading an untouched app must not arm dialogs).
  const untouched = lifecycleForRestoredProject({
    version: 1, dirty: false, persistedDestination: null, installed: false,
  });
  assert.equal(lifecycleLabel(untouched), 'New project');
  assert.equal(hasUnsavedChanges(untouched), false);
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
