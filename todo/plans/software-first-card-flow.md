# Software-first card flow

## Goal

Make the ordinary Lightweaver journey work from Studio without physical card
buttons, duplicate setup surfaces, stale bridge instructions, or successful
operations reported as failures. Connection and setup simplicity are a primary
product direction, not cleanup after feature work.

## Verified baseline — 2026-08-11

- Production Studio automatically reconnected to the exact card at
  `192.168.18.70` after reload.
- Setup reconstructed the installed GPIO 18 / 41-light WS2815 project and then
  reported `Installed project matches` and `Setup complete`.
- The footer direct-control drawer and Playlist Live changed the real pattern;
  the card API confirmed Fire.
- A three-look Aurora / Fire / Ocean playlist save reached the card. The card
  reported project revision 2, known-good wiring, no candidate, and all three
  looks.
- Production Studio build 1267 and signed firmware 1.1.10 build 1266 were
  published successfully.

## Simplification defects found by the live loop

1. A production refresh can lose local-card permission and show three recovery
   states in sequence. Collapse these into automatic revalidation with one
   permission action only when the browser truly requires it.
2. `Start from card wiring` restores wiring but not installed looks. Reconstruct
   the whole editable card project or label the action honestly and offer
   `Import installed looks` beside it.
3. Test-strip mode survived across unrelated work and silently changed a
   playlist save into a 30-light wiring transaction. Make it visibly
   session-scoped, auto-expiring, and opt-in at every card save.
4. Stopping test-strip mode restored stale browser state and removed the visible
   playlist. Preserve subsequent edits or ask which state to keep; never rewind
   silently.
5. Leaving test mode must roll back its own unactivated wiring candidate and
   verify the known-good project automatically.
6. Playlist save succeeded, but post-save zone verification used a stale bridge
   after the project head changed and reported failure. Reacquire the exact
   direct card and verify status, wiring, patterns, and zones before showing an
   error. Never label a confirmed save as failed.
7. Firmware 1.1.9 enforces a recent physical control action for Wi-Fi update.
   Add authenticated software-owner authorization bound to card ID, boot ID,
   project head, release build, and a short expiry; retain physical confirmation
   as the guest/commissioning default.
8. Setup, footer attention, Connection Center, Install or update, and the card
   page still overlap. Keep Setup as the owner of diagnosis and deep-link every
   other surface to its exact active step.

## Ordered work

1. Add regressions for stale test-strip state, its staged candidate, project-head
   changes during playlist save, and reconstruction with installed looks.
2. Make test-strip mode transactional and edit-preserving, including automatic
   cleanup of its own candidate.
3. Reacquire and verify direct-card authority after acknowledged writes; use the
   card-page bridge only as a bounded fallback.
4. Extend card reconstruction to recover installed looks and startup state.
5. Add authenticated software-owner authorization for preserving updates.
6. Run the live loop twice from a fresh browser state: reconnect, recover,
   direct pattern/color control, edit/save playlist, reload, navigate looks, and
   preserving firmware update.

## Done when

One fresh Studio visit can recover and control the exact card, save a playlist,
reload, and update firmware without opening another tab or touching hardware;
every success is confirmed by UI and machine-readable card state, and test-only
state can never alter production wiring implicitly.
