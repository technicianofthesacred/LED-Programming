# Lightweaver Project-Switch Save Barrier

## Goal

Before Studio replaces the current workspace with the exact project reported by a connected Lightweaver card, it must save the current work automatically. A failed or unconfirmed save must leave the current project open and must not begin replacement.

## Save contract

Every non-current card-project switch uses one ordered save barrier:

1. Capture the current project generation, edited revision, serialized project, storage association, and card-resolution correlation.
2. Synchronously flush the captured project to the existing browser autosave and backup keys. If this fails, stop the switch.
3. Save the captured project to its authoritative home:
   - If it is associated with an active cloud project, call the immediate cloud save path and require an acknowledged successful save of the captured generation and revision.
   - Otherwise, create or update its browser project-library record and mark that captured revision persisted in the browser library.
4. Recheck that the open project generation/revision, card identity, firmware build, boot ID, installed-project evidence, and selected match are unchanged.
5. Replace the workspace and navigate to Patterns only after every preceding check succeeds.

The browser autosave is a recovery layer. For a cloud-associated project it is not permission to continue after a queued, offline, conflicted, superseded, or rejected cloud save.

## User experience

The explicit card-project action changes to a short saving state before loading, such as `Saving current project…`.

On success, Studio proceeds directly to the matched project. No discard confirmation is needed because the captured current revision has been persisted.

On failure, Studio remains on the Hardware overview with the current project untouched. The project-match panel shows a specific message and a retry action:

- Browser recovery save failed: explain that Studio could not safely preserve the workspace.
- Cloud offline or queued: explain that the online project has not been confirmed saved and offer Retry.
- Cloud conflict/session failure: explain the relevant account or conflict state and do not switch.
- Project or card changed while saving: explain that the operation was cancelled and require a fresh match.

## Concurrency and integrity

- The save barrier operates on one captured project generation and revision.
- Edits made while the save is in flight invalidate the switch. Studio preserves those edits and requires the user to retry, rather than opening the card project after saving an older snapshot.
- A second project-switch click cannot start a parallel save or replacement.
- Cloud acknowledgement must correspond to the captured remote association and project marker.
- Browser-library persistence must return a record containing the captured project identity before the switch may continue.
- Existing exact-card and exact-project correlation checks remain mandatory after saving.

## Scope

This barrier applies when Hardware is about to load a different production, cloud, or browser project for the connected card. It does not run when the exact current workspace is already open and Studio is only navigating to Patterns.

No new persistence format, cloud API, or background synchronization system is introduced. The implementation reuses the existing browser autosave, browser project library, cloud `saveNow`, and project lifecycle markers.

## Verification

Automated coverage must demonstrate:

- A dirty browser project is saved to autosave and the browser library before replacement.
- A dirty cloud-associated project receives a confirmed cloud save before replacement.
- Offline, queued, conflicted, unauthorized, or failed cloud saves block replacement.
- Browser autosave failure blocks every replacement source.
- An edit made during the save blocks replacement and remains in the current workspace.
- A card identity, boot, installed-project, selected-match, or project-generation change during saving blocks replacement.
- Duplicate clicks start one save operation.
- An already-open exact project with preserved card edit intent navigates without an unnecessary save or replacement.
- Production, cloud, and browser matched-project switches retain their existing exact-match behavior after the barrier succeeds.

