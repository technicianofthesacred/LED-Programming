import { sanitizeProjectId } from './projectIdentity.js';

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
  if (destination !== 'card') return null;
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
  // What `cardProjectFingerprint` computed for the Studio project at the moment
  // it was bound to this card. Installs performed FROM Studio need it for
  // nothing — the two fingerprints are the same hash. It exists for the project
  // adopted back OFF a card, whose reconstruction can never recompute the bytes
  // the card hashed: it is the only way to later tell "this is still the
  // structure that was installed" from "this has been rewired since".
  const studioFingerprint = String(source.studioFingerprint || '').trim().toLowerCase();
  // A card flashed before fingerprint reporting answers with an empty
  // `projectFingerprint` for a project it genuinely holds. Adoption from such
  // a card still carries real evidence — the structural fingerprint of the
  // project that was just rebuilt from the card's own readback — so that
  // stand-in verifies the record. An empty fingerprint with no structural
  // stand-in still binds nothing.
  const exactIdentity = Boolean(
    cardId
    && Number.isSafeInteger(projectRevision)
    && projectRevision >= 0
    && (/^[a-f0-9]{16,64}$/.test(projectFingerprint)
      || (!projectFingerprint && /^[a-f0-9]{16,64}$/.test(studioFingerprint))),
  );
  return {
    ...state,
    installedRevision,
    installation: {
      cardId,
      projectRevision: Number.isSafeInteger(projectRevision) ? projectRevision : null,
      projectFingerprint,
      studioFingerprint: /^[a-f0-9]{16,64}$/.test(studioFingerprint) ? studioFingerprint : '',
      verified: source.verified === false ? false : exactIdentity,
    },
  };
}

// Re-verify a restored installation record against fresh evidence from the
// card that is actually connected right now.
//
// `lifecycleForRestoredProject` deliberately restores the installation with
// `verified: false` — the persisted record on its own is a memory, not proof
// that the card still holds that project. But nothing ever cleared that
// doubt again, so a reload permanently demoted a correctly installed card to
// `project-mismatch` and stranded the owner in Setup with no way out except a
// re-install.
//
// This is the missing evidence path, and it stays evidence-based: the record is
// promoted back to verified ONLY on an exact three-way match — same card id,
// same project revision, same project fingerprint as the record names, plus the
// open Studio project being the same project the card names. Any single
// disagreement (or any missing field) leaves the state untouched, so a
// different card, a re-installed card, or an edited project still has to earn
// verification through a real install.
export function reverifyInstallation(state, evidence = {}) {
  const installation = state.installation;
  if (!installation || installation.verified === true) return state;
  // A record that no longer describes the project as it stands is not a
  // candidate — an edit since the restore means the card holds something else.
  if (state.installedRevision !== state.editedRevision) return state;

  const cardId = String(evidence.cardId || '').trim();
  if (!cardId || cardId !== String(installation.cardId || '').trim()) return state;

  const projectRevision = Number(evidence.projectRevision);
  if (!Number.isSafeInteger(projectRevision)
    || projectRevision < 0
    || projectRevision !== installation.projectRevision) return state;

  const projectFingerprint = String(evidence.projectFingerprint || '').trim().toLowerCase();
  const recordedStudioFingerprint = String(installation.studioFingerprint || '');
  if (/^[a-f0-9]{16,64}$/.test(projectFingerprint)) {
    if (projectFingerprint !== String(installation.projectFingerprint || '')) return state;
  } else if (projectFingerprint
    || String(installation.projectFingerprint || '')
    || !recordedStudioFingerprint) {
    // A legacy card that reports no fingerprint can still re-verify a record
    // that was bound to it with no fingerprint — but only through the
    // structural stand-in check below, which such a record must carry.
    return state;
  }

  const cardProjectId = sanitizeProjectId(evidence.projectId);
  const studioProjectId = sanitizeProjectId(evidence.studioProjectId);
  if (!cardProjectId || !studioProjectId || cardProjectId !== studioProjectId) return state;

  // A record that names the Studio structure it was bound to must still match
  // it. Re-verification is about proving the open project is the installed one,
  // and a project rewired since the install is not.
  if (recordedStudioFingerprint
    && recordedStudioFingerprint !== String(evidence.studioProjectFingerprint || '').trim().toLowerCase()) return state;

  return { ...state, installation: { ...installation, verified: true } };
}

// The installation record ONLY while it still describes the project as it
// stands. One edit since the install and the card holds something else, so the
// record stops speaking for the open project.
export function currentInstallation(state) {
  return state?.installedRevision === state?.editedRevision && state?.installation
    ? state.installation
    : null;
}

// The verified installation record for a project whose STRUCTURE is still the
// one that was installed — the record's `studioFingerprint` against the
// project's `cardProjectFingerprint` as it stands right now.
//
// Why structure rather than the edited revision: a project adopted back off a
// card can never recompute the fingerprint the card holds, so identity checks
// that compare the two refuse a correctly installed card forever. The record
// carries the card's own value and is the binding the contract intends. But it
// may only stand in while the thing both fingerprints describe — project id,
// name, strips, patch board, wiring, controller — is unchanged. Choosing a
// look or a colour is not that, and it is exactly what the Patterns screen
// does before every send; gating on the revision instead would revoke a card's
// own project the moment the owner tapped a pattern on it.
//
// Records written by a Studio install carry no `studioFingerprint` (the two
// hashes are the same value there, so nothing needs standing in) and are
// deliberately not eligible.
export function structurallyInstalledRecord(state, studioFingerprint) {
  const installation = state?.installation;
  if (installation?.verified !== true) return null;
  const recorded = String(installation.studioFingerprint || '');
  const current = String(studioFingerprint || '').trim().toLowerCase();
  return recorded && recorded === current ? installation : null;
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
        // Only records that actually carry one write it, so an install made
        // from Studio (where the two fingerprints are the same hash) keeps the
        // record shape it has always had.
        ...(state.installation.studioFingerprint
          ? { studioFingerprint: String(state.installation.studioFingerprint) }
          : {}),
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
