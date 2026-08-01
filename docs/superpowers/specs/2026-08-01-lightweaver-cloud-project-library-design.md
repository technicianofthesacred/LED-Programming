# Lightweaver Cloud Project Library Design

## Purpose

Lightweaver projects represent physical artworks that may return for revisions years later. The Studio at `led.mandalacodes.com` must therefore be the private working home for Adrian and authorized workers, while every project and the whole library remain independently downloadable and restorable.

This release makes cloud persistence part of the active Studio. It does not create public project pages, client sharing, collaboration invitations, or a cloud relay for LED commands.

## Chosen approach

Use Cloudflare Pages Functions on the existing `lightweaver` Pages project, Cloudflare Access for individual authentication, D1 for searchable metadata and access-controlled revision indexes, and a private R2 bucket for immutable JSON snapshots. The existing 500 ms browser recovery copy remains in place. Cloud synchronization is a second, slower persistence layer and never enters the ESP32 command path.

Two alternatives were rejected:

- Browser storage plus manual downloads cannot provide cross-device access or a real online backup.
- A new third-party application backend would duplicate the existing Cloudflare deployment, credentials, and operational surface without improving the single-team workflow.

The static Studio and firmware assets remain public because the card installer and public support surface depend on them. Cloudflare Access protects only `/api/library/*`. No R2 bucket or object receives a public URL.

## Access model

Cloudflare Access allows only explicitly approved individual identities. Workers use their own login rather than a shared site password. Pages Functions validate the Access JWT and enforce permissions again at the API boundary.

| Capability | Owner | Worker | Unauthenticated |
| --- | --- | --- | --- |
| List and open the full library | Yes | Yes | No |
| Create, rename, edit, duplicate, import, export | Yes | Yes | No |
| View and restore version history | Yes | Yes | No |
| Archive and unarchive projects | Yes | Yes | No |
| Permanently delete cloud data | Yes | No | No |
| Download or restore the master backup | Yes | Yes | No |
| Manage worker access or roles | Yes | No | No |

The owner role is assigned from a deployment variable containing Adrian's approved identity. Other identities admitted by the Access policy are workers. The API returns `403` for every worker delete attempt even if a hidden UI action is manually invoked.

## Data model

The portable project remains the existing versioned `.lw.json` document produced by `serializeProject()`. Cloud metadata is not embedded into that file.

D1 stores:

- `projects`: remote ID, embedded Lightweaver project ID, title, active/archive state, current revision number, current object key, creation/update timestamps, and creator/editor identity;
- `project_revisions`: immutable revision number, R2 object key, content hash, byte size, project schema version, timestamp, and actor identity;
- `workspace_asset_heads` and `workspace_asset_revisions`: current and historical snapshots for reusable custom patterns and Pattern Lab drafts;
- `library_imports`: idempotency key, actor, timestamp, and restore summary for master-backup imports.

R2 stores private JSON objects at stable prefixes:

- `projects/<remote-project-id>/revisions/<revision>.lw.json`;
- `workspace-assets/<asset-kind>/revisions/<revision>.json`.

Remote IDs are separate from the embedded `project.id`. Duplicating or collision-safe master restore creates a new remote ID and a new embedded project ID. Opening and editing an existing project preserves both identities.

## API contract

All responses use `Cache-Control: no-store`. Mutations accept an idempotency key, validate complete JSON before writing, and return the authoritative head revision.

- `GET /api/library/session` returns the authenticated identity and `owner` or `worker` role.
- `GET /api/library/projects?state=active|archived` returns metadata only.
- `POST /api/library/projects` validates and creates a named project with revision 1.
- `GET /api/library/projects/:id` returns metadata and the current portable project snapshot.
- `PUT /api/library/projects/:id` requires `baseRevision`, creates one immutable revision, and returns `409` when the head changed.
- `POST /api/library/projects/:id/duplicate` creates an independent project.
- `POST /api/library/projects/:id/archive` and `/unarchive` change reversible state.
- `DELETE /api/library/projects/:id` is owner-only and removes metadata and private objects after an explicit confirmation token.
- `GET /api/library/projects/:id/revisions` lists history.
- `POST /api/library/projects/:id/revisions/:revision/restore` creates a new head from an older snapshot; it never rewrites history.
- `GET` and `PUT /api/library/assets/:kind` synchronize `custom-patterns` and `pattern-lab-drafts` with optimistic revision checks.
- `GET /api/library/backup` downloads the versioned master envelope containing active and archived projects, every retained project revision, reusable assets, and their revisions.
- `POST /api/library/restore` validates the whole envelope before writing and imports additively. ID collisions become clearly named restored copies; restore never deletes existing cloud data.

Unknown methods, malformed paths, invalid or forward-version projects, oversized request bodies, and missing bindings fail with bounded JSON errors that contain no project contents.

## Saving and recovery behavior

Local browser recovery continues every 500 ms and remains the first defense against a crash, reload, or connection loss. It never claims that work reached the cloud.

For an authenticated remote project, Studio schedules cloud synchronization after a short idle period. A successful response marks the exact local revision as `Saved online`. Identical content hashes are no-ops. Offline or failed saves retain the local recovery copy, display `Waiting to save online`, and retry when the browser reconnects.

Every accepted content change creates an immutable revision with the editor identity and timestamp. Concurrent edits use `baseRevision`; last-write-wins is forbidden. On `409`, Studio keeps the local recovery copy and offers:

- open the latest online revision;
- save the local work as a new project copy.

The conflict flow never silently overwrites either version.

Existing anonymous browser-library records are not uploaded silently. After login, Studio offers a one-time **Bring browser projects online** action that validates every record, reports any rejected records, and preserves the local originals.

## Project-library interface

The current Preferences project card becomes a first-class online library surface while the top-bar actions keep their existing names.

The library shows:

- signed-in identity and role;
- online/offline/saving/conflict state;
- search by project title;
- active and archived views;
- title, last editor, last saved time, and current revision;
- Open, Duplicate, Archive/Unarchive, History, and individual Export actions;
- owner-only permanent Delete for archived projects;
- New project, Import project, Download master backup, Restore master backup, and Bring browser projects online.

Project titles remain editable. Untitled work can be recovered locally, but its first intentional online save asks for a useful title. Creating from an existing artwork uses Duplicate, preserving the source while generating independent identities.

## Portable backups

Individual export remains `<project-title>.lw.json` and stays compatible with project versions 1, 2, and 3 plus legacy `.lwproj.json` and plain `.json` imports.

The master file uses `<date>-lightweaver-master.lw-library.json` and a separate envelope format:

```json
{
  "format": "lightweaver.library-backup",
  "version": 1,
  "exportedAt": "2026-08-01T00:00:00.000Z",
  "projects": [],
  "workspaceAssets": []
}
```

It is self-contained and contains no authentication tokens, Cloudflare identifiers, card WiFi credentials, browser diagnostics, or local host addresses beyond data already intentionally present in portable project documents. Restore validates the entire envelope before mutating cloud state and produces a summary of created projects/assets and rejected entries.

## Reusable patterns

Custom patterns and Pattern Lab drafts are workspace assets rather than properties of one artwork. They synchronize online with revision history so a new browser can reproduce the patterns referenced by projects. The master backup includes them. Built-in patterns remain code assets and are not duplicated into cloud storage.

## Security and operational constraints

- Access must protect `/api/library/*` with an exact allowlist; a policy that allows every valid email is forbidden.
- Every Function validates the JWT issuer, audience, signature, and expiry before trusting identity claims.
- Authorization is server-side; hiding a button is only a usability measure.
- R2 remains private and is accessed only through bindings, never presigned or public URLs.
- Request sizes, JSON depth/shape, title lengths, and list pagination are bounded.
- All D1 statements use parameters. Writes use optimistic revision checks and idempotency records.
- Secrets live in encrypted Cloudflare bindings, never source, Wrangler variables, logs, downloads, or error messages.
- Structured logs include request ID, route, role, status, project ID, and revision, but never project bodies.
- D1 migrations are expand-only for this release because a Pages rollback does not roll back the database.
- `_routes.json` invokes Functions only for `/api/library/*`; Studio assets and firmware remain static.
- The API must not proxy, store, or relay any command to a Lightweaver card.

## Failure behavior

- Unauthenticated requests are rejected by Access and the Function middleware.
- Missing D1/R2 bindings return a safe `503` and the Studio continues local recovery.
- Invalid imports do not change the open project or cloud library.
- A cloud failure never clears local autosave, undo state, or quarantined recovery data.
- A failed master restore writes nothing unless all entries validate; object/metadata writes use idempotent keys so a safe retry completes without duplicates.
- A project from a newer unsupported Studio version is preserved as a rejected import and is never rewritten.

## Verification

Automated coverage must prove:

- authentication and the complete owner/worker permission matrix;
- no cross-project or unauthenticated reads;
- create/list/open/rename/duplicate/archive/unarchive and owner-only delete;
- immutable revisions, restore-as-new-head, idempotent retries, and `409` conflicts;
- online autosave, offline recovery, retry, and exact-revision saved labels;
- legacy individual imports and canonical exports;
- master backup round-trip with active/archived projects, all revisions, custom patterns, and Pattern Lab drafts;
- invalid/future/oversized payload rejection without partial mutation;
- Pages Function routing and private binding configuration;
- unchanged local ESP32/Card bridge behavior and a successful production build.

Release verification runs focused unit/API/UI tests, the complete `npm run launch:source` gate, a Pages preview with local/preview bindings, then a credentialed production migration and deployment. Real production is not declared complete until `led.mandalacodes.com` proves authenticated library access and an unauthenticated project request is denied.

## Explicitly deferred

- Client or public sharing links;
- public project discovery;
- invitations or self-service registration;
- fine-grained per-project worker permissions;
- comments, simultaneous collaborative editing, and presence;
- moving the public Studio or ESP32 command path behind cloud authentication.
