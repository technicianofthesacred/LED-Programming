export function createProjectLifecycle(initial = {}) {
  return {
    generation: Number.isSafeInteger(initial.generation) && initial.generation >= 0
      ? initial.generation
      : 0,
    editedRevision: initial.editedRevision ?? 0,
    persistence: initial.persistence ?? null,
    installedRevision: initial.installedRevision ?? null,
    installation: initial.installation ?? null,
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

export function repositoryPersistenceMarker(repository, lifecycle) {
  const destination = repository?.source?.kind;
  if (destination !== 'browser' && destination !== 'card') return null;
  if (!Number.isSafeInteger(lifecycle?.generation) || !Number.isSafeInteger(lifecycle?.editedRevision)) return null;
  return {
    destination,
    generation: lifecycle.generation,
    revision: lifecycle.editedRevision,
  };
}

export function markInstalled(state, revision = state.editedRevision) {
  const source = revision && typeof revision === 'object'
    ? revision
    : { revision };
  if (!Number.isSafeInteger(source.generation) || source.generation !== state.generation) {
    return state;
  }
  const installedRevision = Number.isSafeInteger(source.revision)
    ? source.revision
    : state.editedRevision;
  const cardId = String(source.cardId || '').trim();
  const projectRevision = Number(source.projectRevision);
  const projectFingerprint = String(source.projectFingerprint || '').trim().toLowerCase();
  const exactIdentity = Boolean(
    cardId
    && Number.isSafeInteger(projectRevision)
    && projectRevision >= 0
    && /^[a-f0-9]{16,64}$/.test(projectFingerprint),
  );
  return {
    ...state,
    installedRevision,
    installation: {
      cardId,
      projectRevision: Number.isSafeInteger(projectRevision) ? projectRevision : null,
      projectFingerprint,
      verified: source.verified === false ? false : exactIdentity,
    },
  };
}

export function replaceProjectLifecycle(state) {
  const generation = state.generation + 1;
  if (!Number.isSafeInteger(generation)) throw new Error('Project lifecycle generation overflow');
  return createProjectLifecycle({ generation });
}

export function markRestored(state) {
  return { ...state, restored: true };
}

export function lifecycleLabel(state) {
  const revision = state.editedRevision;
  if (state.installedRevision === revision && state.installation?.verified === true) return 'Installed on card';
  if (state.installedRevision === revision && state.installation) return 'Previously installed';
  if (state.persistence?.revision === revision) {
    if (state.persistence.destination === 'browser') return 'Saved in browser';
    if (state.persistence.destination === 'file') return 'File downloaded';
    if (state.persistence.destination === 'card') return 'Saved on card';
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

export const PROJECT_LIFECYCLE_RECORD_VERSION = 2;

export function lifecycleRecordFromState(state) {
  const persisted = state.persistence?.revision === state.editedRevision
    ? state.persistence.destination
    : null;
  const currentInstallation = state.installedRevision === state.editedRevision && state.installation
    ? {
        cardId: String(state.installation.cardId || ''),
        projectRevision: Number.isSafeInteger(state.installation.projectRevision)
          ? state.installation.projectRevision
          : null,
        projectFingerprint: String(state.installation.projectFingerprint || ''),
      }
    : null;
  return {
    version: PROJECT_LIFECYCLE_RECORD_VERSION,
    dirty: hasUnsavedChanges(state),
    persistedDestination: persisted === 'browser' || persisted === 'file' ? persisted : null,
    installation: currentInstallation,
  };
}

// Lifecycle for a project restored from the autosave at boot. Without a
// trustworthy record (or with a dirty one) the restore is "restored, unsaved":
// clean label, but still guarded against silent discard.
export function lifecycleForRestoredProject(record = null) {
  if (record && record.version === PROJECT_LIFECYCLE_RECORD_VERSION) {
    let state = record.dirty === true
      ? markRestored(createProjectLifecycle())
      : createProjectLifecycle();
    if (record.dirty !== true && (record.persistedDestination === 'browser' || record.persistedDestination === 'file')) {
      state = markPersisted(markRestored(state), record.persistedDestination);
    }
    if (record.installation && typeof record.installation === 'object') {
      state = markInstalled(state, {
        ...record.installation,
        revision: state.editedRevision,
        generation: state.generation,
        verified: false,
      });
    }
    if (record.dirty === true || state.persistence || state.installation) return state;
    // Clean with nothing persisted anywhere ⇒ the autosave held an untouched
    // new project. Reloading an untouched app stays "New project" (no guard).
    return state;
  }
  if (record?.version === 1 && record.dirty !== true) {
    let state = createProjectLifecycle();
    if (record.persistedDestination === 'browser' || record.persistedDestination === 'file') {
      state = markPersisted(markRestored(state), record.persistedDestination);
    }
    if (record.installed === true) {
      state = markInstalled(state, {
        revision: state.editedRevision,
        generation: state.generation,
        verified: false,
      });
    }
    return state;
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
