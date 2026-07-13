# Lightweaver Experience Hardening Design

**Date:** 2026-07-13
**Status:** Approved
**Scope:** Active Lightweaver Studio and ESP32-S3 card visitor interface

## Purpose

Lightweaver already has a credible professional-tool foundation, but several interactions can misstate whether work is saved, live, or installed. Layout is difficult to use on phones, Pattern previews do not reflect the actual artwork, and important operations lack accessible controls or visible recovery paths.

This project hardens the existing experience without replacing its visual identity or changing the ESP32-only runtime architecture. The deferred Raspberry Pi server and visitor UI remain out of scope.

## Success criteria

The work is complete when:

1. Opening or importing a project cannot silently replace unsaved work.
2. The interface distinguishes local edits, browser or file persistence, and card installation.
3. Card actions expose pending, confirmed, and failed states and never report success before confirmation.
4. Layout remains meaningfully usable at a 390 by 844 viewport.
5. Primary Layout and Pattern interactions support pointer, touch, and keyboard input.
6. Pattern previews use the current artwork geometry and symmetry configuration.
7. Destructive firmware flashing requires an explicit final confirmation.
8. The installer can resume checklist progress and clearly identify a ready-to-ship card.
9. The card visitor page rolls failed optimistic changes back and gives the visitor a recovery action.
10. Initial Studio loading and the Pattern library avoid unnecessary work while preserving existing functionality.
11. Existing unit, workflow, Layout, Pattern, build, and launch checks continue to pass.

## Chosen approach

Use shared state contracts, then improve each surface against those contracts.

This is preferred over a screen-by-screen patch sweep because saving and card communication must mean the same thing everywhere. It is preferred over a wholesale redesign because the current visual language, navigation, and Draw, Size, Wire model are strong and should remain familiar.

## Experience model

### Project lifecycle

The Studio tracks three separate facts:

- **Edited in Studio:** the current project differs from the last browser or file persistence point.
- **Saved:** the current revision has been persisted to the selected browser or file destination.
- **Installed on card:** the card has confirmed receiving the current installable revision.

These facts are not collapsed into a single generic “saved” state. User-facing labels use the destination explicitly, such as “Saved in browser,” “Project file downloaded,” or “Installed on card.”

Opening a project from the top bar, Settings, Layout project controls, or the project library goes through one replacement guard. If the current project has unsaved changes, the guard presents the project name, the consequence, and two choices: keep editing or replace the project. The replacement only clears undo state after the new project validates and applies successfully.

Autosave remains a recovery mechanism. It must not silently redefine an imported file or card installation as saved.

### Card action contract

Studio card actions share these states:

- `idle`: no current operation
- `pending`: request sent, controls that would conflict are disabled
- `confirmed`: the card acknowledged the requested revision or value
- `failed`: the previous confirmed state remains authoritative and retry is available

Actions must not set a live or selected state before confirmation. Failure text names the failed action, preserves the user’s work, and offers retry or a concrete local-network recovery step.

The ESP32 visitor page follows the same behavioral contract in its embedded JavaScript. Scene selection, brightness, and blackout controls may preview intent while pending, but must roll back to the last confirmed value on failure and expose a compact inline error.

## Surface design

### Shell and navigation

- Use the canonical “Lightweaver” spelling everywhere.
- Surface project lifecycle status persistently without turning the top bar into a dashboard.
- Lazy-load major screens behind the existing navigation boundary.
- Retain the current information architecture and route names.
- Replace unsupported theme choices with two complete themes: Studio, the current dark working environment, and Daylight, a warm light environment for bright workshops.

### Layout

Draw, Size, and Wire remain the primary modes.

- The toolbar shows mode-relevant creation and editing actions first. Project file actions and card calibration tools move to clearly named secondary groups.
- Switching modes preserves unfinished waypoints and pending paths. Explicit cancel or project replacement discards them.
- Manual LED count changes and resets participate in the existing undo and redo history.
- Mouse-specific handlers move to pointer events, with pointer capture where a drag must continue outside the source element.
- Selectable and editable SVG paths expose keyboard focus and useful accessible names. Keyboard actions cover selection, deletion, and the existing nudge behavior where applicable.
- At narrow widths, the fixed inspector becomes a bottom sheet or stacked panel with a visible handle and a useful collapsed state. The canvas retains enough height and width for drawing.
- Wire mode includes a short in-context scaffold explaining start point, chain order, and validation.
- Mixed-content fallback presents Copy payload, Open card installer, and Retry actions instead of raw JSON alone.

### Patterns

- Pattern cards remain compact controls with native button semantics and visible selected state.
- The preview uses current artwork paths, LED counts, physical order, and symmetry. It shares the established frame or geometry pipeline rather than introducing a second effect interpretation.
- Filters and the first useful results appear within the initial desktop viewport.
- The library initially renders a bounded result batch and progressively reveals more. Search and category filtering operate on the complete data set.
- Sending a pattern uses the shared card action contract and reports the destination accurately.

### Show and Playlist

- Live state changes only after the target confirms the operation.
- Failed playback, load, or save operations remain visible and retryable.
- Narrow-screen controls stack without leaving a fixed inspector that crowds the working area.
- Existing spatial audio and physical chain behavior remains unchanged.

### Settings and installer

- Every range, input, toggle, and select has a programmatic label.
- Toggle and selection state use native or ARIA state semantics.
- Importing a project uses the shared replacement guard.
- Erase before flash can remain the recommended default, but starting an erase requires a final confirmation that identifies what will be removed.
- Installer checklist progress persists per browser until explicitly reset or the card is marked ready.
- A ready-to-ship state summarizes firmware, project installation, card identity, and the next physical verification step.

### Motion, touch, and status communication

- All primary mobile controls meet a practical 44-pixel target where pointer precision is coarse.
- Status changes important to task completion use polite live announcements.
- Reduced-motion mode disables status pulsing and marching-selection effects in addition to existing transitions.
- Focus remains visible and returns to a predictable control after confirmation or dismissal.

## Performance design

- Major screens load through dynamic imports with a small route-level loading state.
- Pattern results render in batches rather than mounting the full catalog at once.
- SVG measurements used for selected-path decoration are cached or moved to effects and recomputed only when geometry changes.
- Preview geometry is shared or memoized by project revision.
- Bundle and browser measurements determine whether further splitting is worthwhile. No new runtime dependency is introduced solely for virtualization.

## Error handling

Errors are local to the action that failed and use plain language. A global toast may reinforce success, but it is not the only record of a failure.

Project validation errors leave the current project untouched. Card network errors preserve the last confirmed value. Firmware visitor errors roll back optimistic controls. Destructive actions explain consequences before execution. Recovery actions use concrete verbs such as Retry, Copy payload, Open installer, or Keep editing.

## Implementation boundaries

The work is divided into three integration-safe streams:

1. **Studio trust and application surfaces**
   - Owns active `lightweaver/src/v3/` screens, shared lifecycle and card-action utilities, shell loading, theme implementation, Settings, Patterns, Playlist, and installer behavior.
2. **Layout interaction**
   - Owns `lightweaver/src/components/LayoutScreen.jsx`, `lightweaver/src/components/layout/`, related hooks, Layout-specific styling, and Layout workflow tests.
3. **Firmware visitor reliability**
   - Owns the embedded visitor interface in `firmware/lightweaver-controller/src/LightweaverWeb.cpp` and its focused tests.

Agents must not edit the same file concurrently. Shared CSS changes are assigned to the Studio stream unless a Layout-only stylesheet already owns the rule. Root integration owns documentation, combined review, and verification.

## Testing strategy

All behavior changes follow red, green, refactor:

- Pure unit tests cover the project replacement guard, lifecycle labels, card action transitions, installer persistence, and progressive result calculations.
- Component or browser tests cover destructive import confirmation, card failure rollback, accessible Pattern selection, real artwork preview geometry, and flash confirmation.
- Layout browser tests cover pointer drawing, keyboard selection, preserved drafts, undoable sizing, mobile canvas space, and recovery controls.
- Firmware-focused tests inspect or exercise embedded visitor state transitions and rollback behavior.
- Existing workflow tests protect project export, card installation, Pattern selection, Show behavior, and screen navigation.
- Final verification runs the full unit suite, focused Playwright workflows at desktop and mobile sizes, production build, launch check, and available firmware compilation or web-interface checks.

## Delivery order

1. Establish lifecycle and card action contracts with failing tests.
2. Apply the contracts to Studio project opening, Patterns, Playlist, Settings, and installer.
3. Harden Layout interaction and responsive behavior.
4. Harden the ESP32 visitor controls.
5. Add real geometry previews, progressive Pattern rendering, lazy screens, and geometry caching.
6. Complete accessibility, theme, motion, copy, and naming consistency.
7. Run combined browser review and full verification, then resolve regressions before delivery.

## Out of scope

- Raspberry Pi proxy or Pi-hosted visitor UI work
- New backend services or cloud synchronization
- Changes to WLED compatibility contracts
- Replacement of the existing visual identity or navigation model
- New pattern algorithms unrelated to accurate previewing
- Hardware behavior changes beyond safer confirmation and error presentation
