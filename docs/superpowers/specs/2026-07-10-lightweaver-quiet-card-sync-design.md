# Lightweaver quiet card sync

## Goal

Lightweaver should load each card dependency at the moment it is needed. The operator should not have to understand or manually sequence sections, patterns, mixes, and playlists.

Routine preview, save, and sync work should stay out of the interface. Lightweaver should only interrupt the operator when automatic recovery failed or a safety decision is required.

## Current problem

A saved layer mix can reference multiple section looks while the connected card still has only its full-piece zone. Selecting that mix starts a live preview before the Studio section map has been installed on the card. The preview then falls back to the whole piece and tells the operator to visit Patterns and send sections manually.

The full runtime package already contains the section zones, pattern definitions, saved looks, and playlist order. The problem is orchestration and feedback state, not missing project data.

The Patterns screen also displays routine preview progress and success as a large top-level notification, including messages such as `Previewing Aurora on All sections. Not saved yet.` This competes with the pattern workflow even though no action is required.

## Chosen approach

Use quiet, dependency-aware orchestration.

- A pattern tap remains a temporary audition. It does not rewrite the card's startup playlist.
- Studio continues to autosave project edits in the browser.
- Before a section-specific preview, Studio checks the card's available zones.
- If required zones are missing, Studio installs the current runtime configuration, waits for any required reboot or reconnect, and then retries the requested preview once.
- `Load playlist to card` always sends one complete runtime package containing the current section map, pattern bank, saved mixes, playlist order, and startup look.
- A successful playlist sync clears any old section-fallback warning and confirms the card now exposes the required zones.
- Automatic recovery is bounded. Studio performs at most one dependency install and one preview retry for a user action.

## Feedback rules

Expected work is silent:

- no top banner while a preview is being sent;
- no `Not saved yet` banner after a preview succeeds;
- no banner when an older preview is superseded by a newer tap;
- no section warning when Studio can install the missing sections itself;
- no persistent success banner after routine preview or playlist sync.

Existing controls communicate ordinary state:

- the selected pattern and design-target chips show what is active;
- the physical LEDs show the live preview;
- the playlist button's temporary disabled/loading state prevents duplicate sends;
- card connection state remains in the existing card status area.

Visible feedback is reserved for failures requiring attention:

- the card cannot be reached after retry;
- the card bridge is missing or stopped responding;
- the open project does not match the paired card;
- sending the dependency package would change the physical output layout;
- the card rejects or cannot persist the configuration.

These errors should say what Lightweaver tried, what remains unchanged, and provide the one relevant recovery action. They should not redirect the operator to another screen to complete routine dependency work.

## Data flow

### Temporary pattern preview

1. Update the selected pattern and local draft immediately.
2. If card preview is enabled, send the newest preview request.
3. Ignore superseded preview completions.
4. On success, render no notification.
5. On an unrecoverable connection error, render one actionable error.

### Section-specific preview

1. Derive the required section IDs from the current patch board and selected saved look.
2. Read the card zone IDs.
3. If all required IDs exist, send the zoned preview.
4. If IDs are missing, build and push the current complete runtime package.
5. Wait for the card if the package requires a reboot, then re-read zones.
6. Retry the zoned preview once.
7. Surface an error only if installation or verification fails.

### Playlist sync

1. Build the runtime package once from the current project snapshot.
2. Push the complete configuration through the active card bridge or direct local route.
3. Reboot only when required by hardware layout changes.
4. Verify that the card exposes the package's section IDs after it becomes available.
5. Clear stale preview fallback state.
6. Leave the operator on Playlist with no success banner.

## Safety boundaries

- Automatic dependency installation must not bypass the existing project-mismatch guard.
- It must not silently change LED output counts or pins. A layout mismatch remains a blocking, actionable error.
- It must not loop indefinitely while the card reboots or reconnects.
- Live auditions must not become startup playlist entries unless the operator adds or saves them.
- When a project has no separate sections, full-piece preview remains valid and requires no zone installation.

## Testing

Add regression coverage for:

- a playlist package containing a two-section mix also contains both runtime zones;
- a missing-zone preview triggers one configuration install followed by one successful zoned retry;
- automatic recovery does not retry forever when verification fails;
- project and physical-layout guards remain blocking;
- successful routine preview produces no notification state;
- superseded previews produce no notification state;
- successful playlist sync clears stale section fallback state and produces no persistent success notification;
- unrecoverable errors still produce actionable feedback.

Run the focused unit and contract tests, the complete core test suite, the production build, and a browser smoke test of Patterns and Playlist.
