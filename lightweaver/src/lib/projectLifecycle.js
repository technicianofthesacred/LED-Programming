export function createProjectLifecycle(initial = {}) {
  return {
    editedRevision: initial.editedRevision ?? 0,
    persistence: initial.persistence ?? null,
    installedRevision: initial.installedRevision ?? null,
    // True when this project was restored from the autosave recovery copy at
    // boot and has not been replaced since. A restored-but-never-saved project
    // is NOT dirty (nothing changed since the copy), but it still guards
    // New/Load/replace until the user saves it somewhere real.
    restored: initial.restored === true,
  };
}

export function markEdited(state) {
  return { ...state, editedRevision: state.editedRevision + 1 };
}

export function markPersisted(state, destination, revision = state.editedRevision) {
  if (destination === 'recovery') return state;
  return { ...state, persistence: { destination, revision } };
}

export function markInstalled(state, revision = state.editedRevision) {
  return { ...state, installedRevision: revision };
}

export function markRestored(state) {
  return { ...state, restored: true };
}

export function lifecycleLabel(state) {
  const revision = state.editedRevision;
  if (state.installedRevision === revision) return 'Installed on card';
  if (state.persistence?.revision === revision) {
    if (state.persistence.destination === 'browser') return 'Saved in browser';
    if (state.persistence.destination === 'file') return 'File downloaded';
  }
  if (revision > 0) return 'Unsaved changes';
  if (state.restored) return 'Restored from recovery copy';
  return 'New project';
}

export function hasUnsavedChanges(state) {
  const revision = state.editedRevision;
  if (state.persistence?.revision === revision) return false;
  // Restored-from-recovery work was never saved anywhere the user chose, so
  // discarding it still needs a confirmation even before the first new edit.
  return revision > 0 || state.restored === true;
}

// ── Persisted lifecycle record (survives reload alongside the autosave) ────
//
// A tiny sanitized summary written whenever the lifecycle changes, so a boot
// that restores the autosave can show the truthful state ("Saved in browser")
// instead of always claiming "Unsaved changes". Revisions are intentionally
// NOT persisted — after a reload the restored content IS revision 0.

export const PROJECT_LIFECYCLE_RECORD_VERSION = 1;

export function lifecycleRecordFromState(state) {
  const persisted = state.persistence?.revision === state.editedRevision
    ? state.persistence.destination
    : null;
  return {
    version: PROJECT_LIFECYCLE_RECORD_VERSION,
    dirty: hasUnsavedChanges(state),
    persistedDestination: persisted === 'browser' || persisted === 'file' ? persisted : null,
    installed: state.installedRevision !== null && state.installedRevision === state.editedRevision,
  };
}

// Lifecycle for a project restored from the autosave at boot. Without a
// trustworthy record (or with a dirty one) the restore is "restored, unsaved":
// clean label, but still guarded against silent discard.
export function lifecycleForRestoredProject(record = null) {
  if (record && record.version === PROJECT_LIFECYCLE_RECORD_VERSION && record.dirty !== true) {
    if (record.persistedDestination === 'browser' || record.persistedDestination === 'file') {
      let state = markPersisted(markRestored(createProjectLifecycle()), record.persistedDestination);
      if (record.installed === true) state = markInstalled(state);
      return state;
    }
    // Clean with nothing persisted anywhere ⇒ the autosave held an untouched
    // new project. Reloading an untouched app stays "New project" (no guard).
    return createProjectLifecycle();
  }
  return markRestored(createProjectLifecycle());
}

export async function replaceProjectSafely({
  candidate,
  validate,
  apply,
  dirty = false,
  confirmDiscard = () => true,
}) {
  const validated = await validate(candidate);
  if (!validated) return { ok: false, reason: 'invalid' };
  if (dirty && !(await confirmDiscard(validated))) return { ok: false, reason: 'cancelled' };
  await apply(validated);
  return { ok: true, project: validated };
}
