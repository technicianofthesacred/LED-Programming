# Top-Bar Save and Load Design

## Goal

Make routine project storage available from Lightweaver's main bar without
turning the bar into a project-management screen. Move long-lived recovery and
save copy out of the project breadcrumb.

## Main-bar actions

Keep five actions so the bar continues to fit narrow phones:

1. New
2. Load
3. Preferences
4. Export
5. Save

`Load` replaces the current computer-file `Import project` action. It opens a
compact dialog containing the signed-in user's active online projects, a small
search field, and an **Open** action for each result. **Import from computer**
stays available as a secondary action inside this dialog. Archived projects,
revision history, account administration, and master backups remain in
Preferences.

## Save behavior

- When the current project is already associated with an online project,
  **Save** writes a new online revision using the existing conflict-safe save
  path.
- When signed in with an unassociated project, **Save** opens one compact title
  prompt. Confirming creates the online project from the current workspace.
- When signed out, **Save** retains the existing browser-library fallback so
  work is not lost.
- Customer accounts keep their existing draft-only behavior; Save never writes
  directly to an official project.

## Load dialog behavior

The dialog reuses the existing online-library state and `openProject` action so
discard confirmation, stale-request protection, conflict handling, and account
visibility rules stay unchanged. It must not mount a second copy of the full
Preferences library panel.

The dialog supports Escape, focus restoration, a labelled close control, and
44-pixel touch targets on phone widths. If the user is signed out, it shows the
existing sign-in guidance and a route to Preferences rather than exposing any
projects.

## Workspace notices

Remove the save/recovery chip from the top-bar breadcrumb. Short operational
feedback appears in a minimal notice at the upper-right of the active artboard.
The notice is event-driven: recovery, successful save, conflict, offline state,
or error feedback may show it. Ordinary success and recovery notices clear
automatically after a short interval and can be dismissed immediately. Conflict,
offline, and error notices remain until resolved or dismissed. When no relevant
event exists, the artboard contains no notice.

## Scope boundaries

This change does not alter storage formats, account roles, authorization,
revision semantics, master backups, or Cloudflare resources. It only improves
the entry points and placement of existing storage behavior.

## Verification

- Browser tests cover Load opening the compact online list, project opening,
  computer import, signed-out guidance, first online Save, associated online
  Save, browser fallback, and customer draft Save.
- Interaction tests cover Escape, focus restoration, dismissal, and notice
  timeout behavior.
- Responsive tests retain five main-bar controls, 44-pixel phone targets, no
  overlap, and no horizontal overflow at 320 and 390 pixels.
- Existing project-library, conflict, replacement-confirmation, account, and
  launch suites must remain green.
