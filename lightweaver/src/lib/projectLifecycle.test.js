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
  replaceProjectLifecycle,
  replaceProjectSafely,
  repositoryPersistenceMarker,
  reverifyInstallation,
  structurallyInstalledRecord,
} from './projectLifecycle.js';

test('card repository saves preserve the exact lifecycle revision without treating recovery writes as explicit saves', () => {
  assert.deepEqual(repositoryPersistenceMarker(
    { source: { kind: 'card' } },
    { generation: 4, editedRevision: 7 },
  ), {
    destination: 'card',
    generation: 4,
    revision: 7,
  });
  assert.equal(repositoryPersistenceMarker(
    { source: { kind: 'recovery' } },
    { generation: 4, editedRevision: 7 },
  ), null);
  assert.equal(repositoryPersistenceMarker(
    { source: { kind: 'browser' } },
    { generation: 4, editedRevision: 7 },
  ), null);
});

function exactInstallation(revision) {
  return {
    revision,
    generation: 0,
    cardId: 'lw-aabbccddeeff',
    projectRevision: 7,
    projectFingerprint: 'a1b2c3d4e5f60708',
  };
}

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
  state = markPersisted(state, 'card');
  assert.equal(lifecycleLabel(state), 'Saved on card');

  state = markInstalled(state, exactInstallation(state.editedRevision));
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
    version: 2, dirty: false, persistedDestination: null, installation: null,
  });

  const dirty = markEdited(createProjectLifecycle());
  assert.deepEqual(lifecycleRecordFromState(dirty), {
    version: 2, dirty: true, persistedDestination: null, installation: null,
  });

  const saved = markPersisted(dirty, 'browser');
  assert.deepEqual(lifecycleRecordFromState(saved), {
    version: 2, dirty: false, persistedDestination: 'browser', installation: null,
  });

  const staleSave = markEdited(saved);
  assert.deepEqual(lifecycleRecordFromState(staleSave), {
    version: 2, dirty: true, persistedDestination: null, installation: null,
  });

  const installed = markInstalled(
    markPersisted(staleSave, 'file'),
    exactInstallation(staleSave.editedRevision),
  );
  assert.deepEqual(lifecycleRecordFromState(installed), {
    version: 2,
    dirty: false,
    persistedDestination: 'file',
    installation: {
      cardId: 'lw-aabbccddeeff',
      projectRevision: 7,
      projectFingerprint: 'a1b2c3d4e5f60708',
    },
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

  // A legacy installed flag is retained only as unverified history.
  const installedBoot = lifecycleForRestoredProject({
    version: 1, dirty: false, persistedDestination: 'file', installed: true,
  });
  assert.equal(lifecycleLabel(installedBoot), 'Previously installed');
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

test('a card-adopted installation binds by the structure it was recorded against, not by the edit revision', () => {
  const studioFingerprint = 'b1b2c3d4e5f60708';
  const adopted = markInstalled(createProjectLifecycle(), {
    ...exactInstallation(0),
    studioFingerprint,
  });
  assert.equal(adopted.installation.verified, true);

  // The card's own fingerprint stands in for the open project…
  assert.equal(
    structurallyInstalledRecord(adopted, studioFingerprint)?.projectFingerprint,
    'a1b2c3d4e5f60708',
  );
  // …and keeps standing in after a look edit, which changes no structure.
  assert.equal(
    structurallyInstalledRecord(markEdited(adopted), studioFingerprint)?.projectFingerprint,
    'a1b2c3d4e5f60708',
  );
  // …but not after a rewire, which changes the structural fingerprint.
  assert.equal(structurallyInstalledRecord(adopted, 'c1b2c3d4e5f60708'), null);
  // A Studio install records no structural fingerprint and never stands in.
  assert.equal(
    structurallyInstalledRecord(markInstalled(createProjectLifecycle(), exactInstallation(0)), ''),
    null,
  );

  const record = lifecycleRecordFromState(adopted);
  assert.equal(record.installation.studioFingerprint, studioFingerprint);
  const restored = lifecycleForRestoredProject(record);
  assert.equal(restored.installation.verified, false);

  // Re-verification must still see the same structure it was bound to.
  const evidence = {
    cardId: 'lw-aabbccddeeff',
    projectId: 'installed-piece-01',
    studioProjectId: 'installed-piece-01',
    projectRevision: 7,
    projectFingerprint: 'a1b2c3d4e5f60708',
  };
  assert.equal(
    reverifyInstallation(restored, { ...evidence, studioProjectFingerprint: 'c1b2c3d4e5f60708' }).installation.verified,
    false,
  );
  assert.equal(
    reverifyInstallation(restored, { ...evidence, studioProjectFingerprint: studioFingerprint }).installation.verified,
    true,
  );
});

test('installed lifecycle records bind exact card and project identity but reload as unverified', () => {
  const installation = {
    revision: 0,
    generation: 0,
    cardId: 'lw-aabbccddeeff',
    projectRevision: 7,
    projectFingerprint: 'a1b2c3d4e5f60708',
  };
  const installed = markInstalled(createProjectLifecycle(), installation);
  assert.equal(lifecycleLabel(installed), 'Installed on card');
  assert.deepEqual(lifecycleRecordFromState(installed), {
    version: 2,
    dirty: false,
    persistedDestination: null,
    installation: {
      cardId: installation.cardId,
      projectRevision: installation.projectRevision,
      projectFingerprint: installation.projectFingerprint,
    },
  });

  const restored = lifecycleForRestoredProject(lifecycleRecordFromState(installed));
  assert.equal(lifecycleLabel(restored), 'Previously installed');
  assert.deepEqual(restored.installation, {
    cardId: installation.cardId,
    projectRevision: installation.projectRevision,
    projectFingerprint: installation.projectFingerprint,
    studioFingerprint: '',
    verified: false,
  });

  const reverified = markInstalled(restored, installation);
  assert.equal(lifecycleLabel(reverified), 'Installed on card');
});

test('legacy installed records remain compatible without claiming a current verified install', () => {
  const restored = lifecycleForRestoredProject({
    version: 1,
    dirty: false,
    persistedDestination: 'file',
    installed: true,
  });

  assert.equal(lifecycleLabel(restored), 'Previously installed');
  assert.equal(restored.installation.verified, false);
  assert.equal(hasUnsavedChanges(restored), false);
});

test('replacement generation rejects missing and stale async install acknowledgements even when revisions collide', () => {
  const original = createProjectLifecycle();
  const replaced = replaceProjectLifecycle(original);
  assert.equal(original.editedRevision, 0);
  assert.equal(replaced.editedRevision, 0);
  assert.equal(replaced.generation, original.generation + 1);

  const missingGeneration = markInstalled(replaced, {
    ...exactInstallation(0),
    generation: undefined,
  });
  assert.deepEqual(missingGeneration, replaced);

  const staleGeneration = markInstalled(replaced, {
    ...exactInstallation(0),
    generation: original.generation,
  });
  assert.deepEqual(staleGeneration, replaced);

  const currentGeneration = markInstalled(replaced, {
    ...exactInstallation(0),
    generation: replaced.generation,
  });
  assert.equal(lifecycleLabel(currentGeneration), 'Installed on card');
});

test('dirty installed lifecycle records retain unverified install history and the recovery guard', () => {
  const edited = markEdited(createProjectLifecycle());
  const installed = markInstalled(edited, {
    ...exactInstallation(edited.editedRevision),
    generation: edited.generation,
  });
  const record = lifecycleRecordFromState(installed);
  assert.equal(record.dirty, true);
  assert.deepEqual(record.installation, {
    cardId: 'lw-aabbccddeeff',
    projectRevision: 7,
    projectFingerprint: 'a1b2c3d4e5f60708',
  });

  const restored = lifecycleForRestoredProject(record);
  assert.equal(lifecycleLabel(restored), 'Previously installed');
  assert.equal(restored.installation.verified, false);
  assert.equal(hasUnsavedChanges(restored), true);
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
  state = markInstalled(state, exactInstallation(requestedRevision));
  assert.equal(state.installedRevision, 1);
  assert.equal(state.editedRevision, 2);
  assert.equal(lifecycleLabel(state), 'Unsaved changes');
});

test('installing the current revision does not count as saving the project', () => {
  const edited = markEdited(createProjectLifecycle());
  const installedOnly = markInstalled(edited, exactInstallation(edited.editedRevision));
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

test('a restored installation re-verifies only on an exact three-way match with fresh card evidence', () => {
  const installation = {
    revision: 0,
    generation: 0,
    cardId: 'lw-aabbccddeeff',
    projectRevision: 7,
    projectFingerprint: 'a1b2c3d4e5f60708',
  };
  const restored = lifecycleForRestoredProject(
    lifecycleRecordFromState(markInstalled(createProjectLifecycle(), installation)),
  );
  assert.equal(restored.installation.verified, false);

  const evidence = {
    cardId: 'lw-aabbccddeeff',
    projectId: 'lotus-gate',
    projectRevision: 7,
    projectFingerprint: 'A1B2C3D4E5F60708',
    studioProjectId: 'Lotus Gate',
  };

  // The card sanitizes ids, so the Studio id has to cross the same boundary.
  const verified = reverifyInstallation(restored, evidence);
  assert.equal(verified.installation.verified, true);
  assert.equal(lifecycleLabel(verified), 'Installed on card');

  // Every single disagreement leaves the record untouched.
  for (const override of [
    { cardId: 'lw-000000000000' },
    { projectRevision: 8 },
    { projectRevision: undefined },
    { projectFingerprint: 'ffffffffffffffff' },
    { projectFingerprint: 'not-hex' },
    { projectId: 'other-piece' },
    { studioProjectId: '' },
  ]) {
    assert.equal(
      reverifyInstallation(restored, { ...evidence, ...override }).installation.verified,
      false,
      JSON.stringify(override),
    );
  }

  // An edit since the restore means the card no longer holds this project.
  assert.equal(reverifyInstallation(markEdited(restored), evidence).installation.verified, false);
  // Nothing installed ⇒ nothing to re-verify.
  assert.equal(reverifyInstallation(createProjectLifecycle(), evidence).installation, null);
});
