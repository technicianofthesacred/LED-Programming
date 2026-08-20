// THE project-association transition module.
//
// A workspace project has at most ONE save destination — a browser-library
// record, a cloud project, or nothing (a fresh/unassociated workspace that the
// next save may claim). Historically the mutual-exclusion sequences that keep
// those stores agreeing (clear the browser pointer when a cloud project opens,
// detach the cloud record when a browser record opens, set/clear the sticky
// save block when a handoff cannot be proven) were hand-rolled inline in
// app.jsx in three different places. This module owns every transition so the
// ordering and fail-closed behavior are written — and unit tested — once.
//
// Every function takes an `io` bundle of side-effect handles supplied by the
// shell; nothing here touches storage or React state directly:
//   writeActiveRecordId(id)            — persist the browser-library pointer
//   readActiveRecordId()               — read it back (readback verification)
//   associateRecordGuarded(snapshot)   — projectStorage.associateProjectLibraryRecordGuarded
//   clearRecordAssociationGuarded(own) — projectStorage.clearProjectLibraryAssociationGuarded
//   detachCloudProject()               — CloudLibraryContext.detachProject
//   setBrowserAssociationSnapshot(s)   — the shell's in-memory association snapshot
//   setSaveBlocked(bool)               — the sticky session-wide save block
//   markProjectPersisted?() / markProjectEdited?() — lifecycle markers (browser adopt only)
//
// Fail-closed contract: any transition that cannot PROVE the stores agree
// leaves saving blocked (`setSaveBlocked(true)`) and reports
// `association-handoff-failed`, so a save can never silently overwrite the
// previous project's record. A transition superseded by a newer lifecycle
// marker reports `superseded` without changing the block.

// A cloud project is now the save destination: the browser pointer must be
// cleared (and proven cleared) so browser saves cannot shadow the cloud copy.
export function adoptCloudProjectAssociation(io) {
  io.setBrowserAssociationSnapshot(null);
  try {
    io.writeActiveRecordId('');
    if (io.readActiveRecordId() !== '') {
      throw new Error('browser project association was not cleared');
    }
    io.setSaveBlocked(false);
    return { ok: true };
  } catch {
    io.setSaveBlocked(true);
    return { ok: false, reason: 'association-handoff-failed' };
  }
}

// A browser-library record is now the save destination: detach the cloud
// project first, then run the guarded association (Web-Lock + readback) and
// record the acknowledged snapshot. A stale lifecycle marker releases the
// association it just took instead of keeping a claim the workspace has moved
// past.
export async function adoptBrowserRecordAssociation({
  recordId,
  recordSnapshot,
  isMarkerCurrent = () => true,
  io,
}) {
  io.detachCloudProject();
  try {
    if (!recordId || !recordSnapshot || recordSnapshot.recordId !== recordId) {
      throw new Error('missing browser project record snapshot');
    }
    const association = await io.associateRecordGuarded(recordSnapshot);
    if (!isMarkerCurrent()) {
      if (association?.ok) {
        await io.clearRecordAssociationGuarded({
          recordId,
          ownershipToken: association.associationOwnershipToken,
        });
      }
      return { ok: false, reason: 'superseded' };
    }
    if (!association?.ok) {
      throw new Error(association?.reason || 'browser project association failed');
    }
    io.setBrowserAssociationSnapshot(association.associationSnapshot);
    io.markProjectPersisted?.();
    io.setSaveBlocked(false);
    return { ok: true };
  } catch {
    if (!isMarkerCurrent()) return { ok: false, reason: 'superseded' };
    io.detachCloudProject();
    io.setBrowserAssociationSnapshot(null);
    io.markProjectEdited?.();
    io.setSaveBlocked(true);
    return { ok: false, reason: 'association-handoff-failed' };
  }
}

// The workspace has no save destination (new/production/unassociated project):
// detach the cloud record and prove the browser pointer is cleared so the next
// save creates a fresh record instead of overwriting the previous project's.
export function adoptUnassociatedWorkspace({ isMarkerCurrent = () => true, io }) {
  io.detachCloudProject();
  try {
    if (!isMarkerCurrent()) return { ok: false, reason: 'superseded' };
    io.writeActiveRecordId('');
    if (io.readActiveRecordId() !== '') {
      throw new Error('browser project association was not cleared');
    }
    io.setBrowserAssociationSnapshot(null);
    io.setSaveBlocked(false);
    return { ok: true };
  } catch {
    if (!isMarkerCurrent()) return { ok: false, reason: 'superseded' };
    io.detachCloudProject();
    io.setBrowserAssociationSnapshot(null);
    io.setSaveBlocked(true);
    return { ok: false, reason: 'association-handoff-failed' };
  }
}

// New-project reset: every association store cleared, save unblocked. This is
// the one non-verifying transition — a brand-new project has nothing another
// tab could be racing to protect, and a failed pointer clear surfaces on the
// next guarded save instead.
export function clearAllProjectAssociations(io) {
  io.setBrowserAssociationSnapshot(null);
  io.writeActiveRecordId('');
  io.detachCloudProject();
  io.setSaveBlocked(false);
}

// THE import cleanup bundle (Phase 7): lib/projectTransfer.js owns the order
// it runs these in after a committed replacement; this module owns what each
// handle does, so every import surface shares one audited implementation.
export function createImportAssociationCleanup(io) {
  return {
    clearBrowserAssociation: () => {
      io.setBrowserAssociationSnapshot(null);
      io.writeActiveRecordId('');
    },
    detachCloudProject: () => io.detachCloudProject(),
    clearSaveBlock: () => io.setSaveBlocked(false),
  };
}

// Retry after a failed handoff left saving blocked: re-run the transition the
// current workspace actually needs — cloud-destination projects re-prove the
// browser pointer is cleared; everything else re-establishes a safe
// unassociated workspace (the next save then creates a fresh record; nothing
// can be overwritten). Success clears the block; failure leaves it set.
export async function retryAssociationHandoff({ hasActiveCloudProject, io }) {
  if (hasActiveCloudProject) return adoptCloudProjectAssociation(io);
  return adoptUnassociatedWorkspace({ io });
}
