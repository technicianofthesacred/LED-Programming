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
9. Discovery records the real GPIO and light count but currently stops before
   Layout, forcing the same physical truth to be entered again. On untouched
   projects, create proportional, non-overlapping provisional strips and wiring
   runs automatically, then ask only for artwork placement.
10. Starter, add-strip, and existing-strip count controls use different size
    behavior. Converge them on one visible rule: light count is electrical truth;
    physical artwork length changes only when the user deliberately rescales it.
11. Zone color control can accept a global acknowledgement after changing a
    specific zone. Require targeted readback of hue, saturation, speed, and hue
    shift before showing the control as applied.
12. Software-only firmware updates need a one-use owner grant, not a bypass of
    the physical gate. Bind a card-generated challenge to card ID, boot ID,
    project head, Studio origin, release build, and ticket digest; have the
    signed-in owner service sign only that short-lived update scope. Keep the
    account cookie and every secret off the card, and retain physical presence
    for guests, commissioning, and offline use.
13. Four surfaces still diagnose the same card independently. Setup should emit
    one stable task and route; the footer and Card Status should link to that
    exact task, while Connection Center and Install/update only execute the
    requested operation.

## Ordered work

1. Add regressions for stale test-strip state, its staged candidate, project-head
   changes during playlist save, and reconstruction with installed looks.
2. Make test-strip mode transactional and edit-preserving, including automatic
   cleanup of its own candidate.
3. Reacquire and verify direct-card authority after acknowledged writes; use the
   card-page bridge only as a bounded fallback.
4. Extend card reconstruction to recover installed looks and startup state.
5. Add authenticated software-owner authorization for preserving updates.
6. Carry discovered GPIO/count truth into a ready-to-place provisional Layout
   without touching an existing design.
7. Make zone color acknowledgements and readback exact and testable.
8. Make Setup the only diagnosis controller and remove the duplicate Card Status
   setup ladder.
9. Add the one-use, update-only owner grant with a dedicated signing key and
   physical fallback.
10. Run the live loop twice from a fresh browser state: reconnect, recover,
   direct pattern/color control, edit/save playlist, reload, navigate looks, and
   preserving firmware update.

## Done when

One fresh Studio visit can recover and control the exact card, save a playlist,
reload, and update firmware without opening another tab or touching hardware;
every success is confirmed by UI and machine-readable card state, and test-only
state can never alter production wiring implicitly.
