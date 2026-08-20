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
      studioFingerprint: 'a1b2c3d4e5f60708',
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
  // A Studio install records its own fingerprint as the structural stand-in
  // (the two hashes are the same value there), so it stands in exactly while
  // the current structure still hashes to what was installed — and never
  // against a different or missing structure.
  const studioInstalled = markInstalled(createProjectLifecycle(), exactInstallation(0));
  assert.equal(
    structurallyInstalledRecord(studioInstalled, 'a1b2c3d4e5f60708')?.cardId,
    'lw-aabbccddeeff',
  );
  assert.equal(structurallyInstalledRecord(studioInstalled, ''), null);
  assert.equal(structurallyInstalledRecord(studioInstalled, 'c1b2c3d4e5f60708'), null);

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

test('a legacy card that reports no fingerprint binds through the structural stand-in alone', () => {
  const studioFingerprint = 'b1b2c3d4e5f60708';
  const legacy = {
    revision: 0,
    generation: 0,
    cardId: 'lw-b0fe81f61b44',
    projectRevision: 0,
    projectFingerprint: '',
    studioFingerprint,
  };

  // Adoption off a pre-fingerprint card verifies on the structural stand-in…
  const adopted = markInstalled(createProjectLifecycle(), legacy);
  assert.equal(adopted.installation.verified, true);
  assert.equal(adopted.installation.projectFingerprint, '');
  assert.equal(structurallyInstalledRecord(adopted, studioFingerprint)?.cardId, 'lw-b0fe81f61b44');

  // …but an empty fingerprint with no stand-in still binds nothing.
  assert.equal(
    markInstalled(createProjectLifecycle(), { ...legacy, studioFingerprint: '' }).installation.verified,
    false,
  );

  // A reload restores the record unverified, and the legacy evidence path
  // re-promotes it only on the full agreement: same card, same revision, the
  // card still reporting no fingerprint, same ids, same structure.
  const restored = lifecycleForRestoredProject(lifecycleRecordFromState(adopted));
  assert.equal(restored.installation.verified, false);
  const evidence = {
    cardId: 'lw-b0fe81f61b44',
    projectId: 'installed-piece-01',
    studioProjectId: 'installed-piece-01',
    projectRevision: 0,
    projectFingerprint: '',
    studioProjectFingerprint: studioFingerprint,
  };
  assert.equal(reverifyInstallation(restored, evidence).installation.verified, true);
  assert.equal(
    reverifyInstallation(restored, { ...evidence, studioProjectFingerprint: 'c1b2c3d4e5f60708' }).installation.verified,
    false,
  );
  // A card that now reports a real fingerprint no longer matches the empty record.
  assert.equal(
    reverifyInstallation(restored, { ...evidence, projectFingerprint: 'a1b2c3d4e5f60708' }).installation.verified,
    false,
  );
  // And a fingerprint-bearing record never accepts empty card evidence.
  const exactRestored = lifecycleForRestoredProject(lifecycleRecordFromState(
    markInstalled(createProjectLifecycle(), { ...exactInstallation(0), studioFingerprint }),
  ));
  assert.equal(
    reverifyInstallation(exactRestored, { ...evidence, projectRevision: 7 }).installation.verified,
    false,
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
      studioFingerprint: installation.projectFingerprint,
    },
  });

  const restored = lifecycleForRestoredProject(lifecycleRecordFromState(installed));
  assert.equal(lifecycleLabel(restored), 'Previously installed');
  assert.deepEqual(restored.installation, {
    cardId: installation.cardId,
    projectRevision: installation.projectRevision,
    projectFingerprint: installation.projectFingerprint,
    studioFingerprint: installation.projectFingerprint,
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
    studioFingerprint: 'a1b2c3d4e5f60708',
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

test('a look tap keeps the persisted installation record; a structural edit drops it', () => {
  const structural = 'a1b2c3d4e5f60708';
  const installed = markInstalled(createProjectLifecycle(), exactInstallation(0));
  const tapped = markEdited(installed);

  // Callers that cannot say what the current structure hashes to get the old
  // behaviour: a record that survived edits cannot be proven, so it drops.
  assert.equal(lifecycleRecordFromState(tapped).installation, null);

  // With the current structural fingerprint still matching the one the record
  // was bound to, the record survives serialization across the look tap.
  const record = lifecycleRecordFromState(tapped, structural);
  assert.equal(record.dirty, true);
  assert.deepEqual(record.installation, {
    cardId: 'lw-aabbccddeeff',
    projectRevision: 7,
    projectFingerprint: structural,
    studioFingerprint: structural,
  });
  // A lazy fingerprint provider is accepted (so callers only pay for the
  // structural hash when a survived record actually needs proving).
  assert.deepEqual(lifecycleRecordFromState(tapped, () => structural).installation, record.installation);

  // A structural edit changes the hash, so the record stops speaking for the
  // project and is dropped from the persisted record.
  assert.equal(lifecycleRecordFromState(tapped, 'c1b2c3d4e5f60708').installation, null);

  // An unverified record never survives an edit, whatever the structure says.
  const restoredUnverified = lifecycleForRestoredProject(lifecycleRecordFromState(installed));
  assert.equal(restoredUnverified.installation.verified, false);
  assert.equal(lifecycleRecordFromState(markEdited(restoredUnverified), structural).installation, null);
});

test('look tap → reload → live card evidence re-verifies the binding without re-adoption', () => {
  const structural = 'a1b2c3d4e5f60708';
  const tapped = markEdited(markInstalled(createProjectLifecycle(), exactInstallation(0)));
  const restored = lifecycleForRestoredProject(lifecycleRecordFromState(tapped, structural));
  assert.equal(lifecycleLabel(restored), 'Previously installed');
  assert.equal(restored.installation.verified, false);

  const evidence = {
    cardId: 'lw-aabbccddeeff',
    projectId: 'installed-piece-01',
    studioProjectId: 'installed-piece-01',
    projectRevision: 7,
    projectFingerprint: structural,
    studioProjectFingerprint: structural,
  };
  assert.equal(reverifyInstallation(restored, evidence).installation.verified, true);
  // Another look tap before the evidence arrives does not cost the binding…
  const tappedAgain = markEdited(restored);
  const reverified = reverifyInstallation(tappedAgain, evidence);
  assert.equal(reverified.installation.verified, true);
  assert.equal(structurallyInstalledRecord(reverified, structural)?.cardId, 'lw-aabbccddeeff');
  // …but the wrong card, a changed card revision, or a changed structure does.
  assert.equal(
    reverifyInstallation(tappedAgain, { ...evidence, cardId: 'lw-000000000000' }).installation.verified,
    false,
  );
  assert.equal(
    reverifyInstallation(tappedAgain, { ...evidence, projectRevision: 8 }).installation.verified,
    false,
  );
  assert.equal(
    reverifyInstallation(tappedAgain, { ...evidence, studioProjectFingerprint: 'c1b2c3d4e5f60708' }).installation.verified,
    false,
  );
});

test('v2 records written before the structural stand-in still parse and heal', () => {
  const structural = 'a1b2c3d4e5f60708';
  const legacyV2 = {
    version: 2,
    dirty: false,
    persistedDestination: null,
    installation: {
      cardId: 'lw-aabbccddeeff',
      projectRevision: 7,
      projectFingerprint: structural,
    },
  };
  const restored = lifecycleForRestoredProject(legacyV2);
  assert.equal(lifecycleLabel(restored), 'Previously installed');
  assert.equal(restored.installation.verified, false);
  // The restore records the exact fingerprint it verified as the structural
  // stand-in, so matching evidence re-verifies even after a look tap.
  assert.equal(restored.installation.studioFingerprint, structural);
  const evidence = {
    cardId: 'lw-aabbccddeeff',
    projectId: 'installed-piece-01',
    studioProjectId: 'installed-piece-01',
    projectRevision: 7,
    projectFingerprint: structural,
    studioProjectFingerprint: structural,
  };
  assert.equal(reverifyInstallation(markEdited(restored), evidence).installation.verified, true);
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
    // The record now names the structure it was bound to (the install
    // fingerprint), so the open project must still hash to it.
    studioProjectFingerprint: 'a1b2c3d4e5f60708',
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

  // An edit since the restore no longer blocks re-verification by itself: the
  // record carries the structure it was bound to, and the matching
  // studioProjectFingerprint proves a look tap changed nothing structural.
  assert.equal(reverifyInstallation(markEdited(restored), evidence).installation.verified, true);
  // A structural change since the restore still refuses.
  assert.equal(
    reverifyInstallation(
      markEdited(restored),
      { ...evidence, studioProjectFingerprint: 'ffffffffffffffff' },
    ).installation.verified,
    false,
  );
  // Nothing installed ⇒ nothing to re-verify.
  assert.equal(reverifyInstallation(createProjectLifecycle(), evidence).installation, null);
});
