export function createProjectLifecycle(initial = {}) {
  return {
    editedRevision: initial.editedRevision ?? 0,
    persistence: initial.persistence ?? null,
    installedRevision: initial.installedRevision ?? null,
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

export function lifecycleLabel(state) {
  const revision = state.editedRevision;
  if (state.installedRevision === revision) return 'Installed on card';
  if (state.persistence?.revision === revision) {
    if (state.persistence.destination === 'browser') return 'Saved in browser';
    if (state.persistence.destination === 'file') return 'File downloaded';
  }
  return revision > 0 ? 'Unsaved changes' : 'New project';
}

export function hasUnsavedChanges(state) {
  const revision = state.editedRevision;
  return revision > 0 && state.persistence?.revision !== revision;
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
