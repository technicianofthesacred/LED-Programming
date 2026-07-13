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
12. Wire mode represents one to four controller outputs as ordered linear lanes whose pixel totals are derived from their runs.
13. A run can be split, moved, reordered, reversed when physically possible, or connected by drag, touch, or keyboard without manual cumulative-address arithmetic.
14. Cable jumps consume no LED addresses; reserved unlit LEDs consume explicit addresses and are named distinctly.
15. Saved physical order, reversed runs, reserved addresses, ledmap export, frame remapping, card zones, and firmware output configuration compile from one canonical wiring model.
16. Auto Wire proposes deterministic, explainable routes from artwork geometry and physical constraints and never silently changes accepted wiring.
17. Closed paths support an explicit movable connector seam before installation and a fixed seam after physical verification.
18. A guided bench chase verifies output identity, first pixel, direction, and run order before the wiring can be locked.
19. Locked wiring blocks geometry, count, direction, routing, output, and pin changes that would invalidate the verified installation until the operator explicitly unlocks it.
20. The Studio can generate a concise assembly map containing connector, output, run order, LED count, direction, and jumper destination.

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

### Physical wiring workspace

Wire mode remains inside the existing Layout screen. Draw continues to own artwork geometry, Size continues to own physical scale and LED counts, and Wire becomes the sole owner of electrical order and output assignment.

The current flat chain becomes one to four output lanes. Each lane represents one real controller connector and contains an ordered list of runs. The routine interface names connectors as Output A through Output D; GPIO values remain visible but secondary and editable through advanced hardware settings. A lane derives its pixel count from its runs, so the operator never enters cumulative output totals by hand.

A run is a contiguous addressable range from one source strip. Runs expose physical `DATA IN` and `DATA OUT` endpoints, LED count, direction, source range, and verification state. The same run appears on the artwork and in the output lane. Selecting either representation selects both.

The primary interactions are:

- drag a cutter onto a strip to split it at the nearest sampled LED;
- drag a run within a lane to reorder it;
- drag a run between lanes to change its output assignment;
- drag a visible cord from `DATA OUT` to the next `DATA IN` to establish order;
- tap one endpoint and then another as the one-handed and coarse-pointer equivalent;
- use explicit Reverse, Move, Split, Remove, and Edit range controls as accessible fallbacks.

Each run has one input and one output. A controller output is a linear chain and cannot branch. A genuine branch starts at a different controller output. The interface refuses duplicate run membership, multiple outgoing connections, cycles, and connections to an output endpoint.

The artwork canvas shows numbered routes, endpoints, jumper cords, selected-run detail, and output identity without replacing the existing LED, Light, Heat, zoom, pan, draw, or selection controls. The inspector retains the existing range editor, reverse action, reserved-unlit-address support, send-to-card action, and ledmap export.

Two concepts that are currently conflated must be separated:

- **Cable jump:** a physical data wire between runs; consumes zero pixel addresses.
- **Reserved unlit LEDs:** real addressable pixels intentionally kept black; consumes an explicit positive address count.

The existing label “Add a gap” is replaced with “Reserve unlit LEDs.” Cable jumps are created only by connecting run endpoints.

### Canonical wiring model

Geometry remains in source order and wiring becomes a separate persisted model:

```js
wiring: {
  version: 1,
  locked: false,
  controllerAnchor: { x: 0, y: 0 },
  outputs: [
    { id: 'out1', name: 'Output A', pin: 16, runIds: ['run-a', 'run-b'] },
  ],
  runs: [
    {
      id: 'run-a',
      kind: 'pixels',
      source: { stripId: 'strip-1', from: 0, to: 59 },
      directionPolicy: 'flexible',
      physicalDirection: 'source-forward',
      seamLed: null,
      verified: false,
    },
    { id: 'unlit-1', kind: 'inactivePixels', count: 3, verified: false },
  ],
}
```

Output order followed by each output's `runIds` is the only physical addressing truth. Output pixel totals, global offsets, ledmap coordinates, inactive-frame masking, zones, firmware JSON, and assembly documentation are compiled from the same normalized model. Creative groups and saved looks remain separate and refer to compiled address ranges rather than mutating physical order.

Migration preserves the exact saved physical order. It must never rewrite accepted wiring to match `strips[]` array order. Existing single-chain projects migrate into Output A using their saved patch-chain order; existing configured output boundaries divide the flattened chain only when those boundaries fall between complete runs. Ambiguous boundaries are surfaced for review rather than guessed.

Hard invariants include one to four outputs, supported unique pins, unique IDs, every run referenced exactly once, no duplicate row references, valid inclusive ranges, positive reserved counts, total pixels within firmware limits, positive in-bounds zone ranges, and explicit errors when firmware zone or range limits cannot be satisfied.

Source ranges are always stored in ascending source order. `physicalDirection` records whether data travels from `source.from` toward `source.to` (`source-forward`) or from `source.to` toward `source.from` (`source-reverse`). `directionPolicy` records whether Auto Wire may change that fact (`flexible`) or must preserve it (`fixed`). These are separate from creative/software reversal. Legacy descending ranges migrate to an ascending range plus `physicalDirection: 'source-reverse'`; legacy runs without direction evidence default to `source-forward`, `directionPolicy: 'flexible'`, and an unverified state. A closed path stores its connector `seamLed` independently, and the compiler rotates the sampled source sequence at that seam before applying physical direction.

### Auto Wire

Auto Wire is a deterministic route proposal, not generative AI and not an automatic hardware mutation. It uses sampled artwork endpoints, physical scale from Size mode, controller position, available outputs, run direction constraints, closed-path seams, LED counts, and firmware limits.

The only required new-project gesture is placing the controller anchor at its planned mounting position. Available outputs come from a connected card when possible; otherwise the standard card profile is used. The operator may leave output count on Automatic or constrain it to one through four.

Each run has a `directionPolicy` of `flexible` or `fixed` and a separate `physicalDirection`. Flexible means the strip is not installed and Auto Wire may propose changing which source endpoint becomes physical `DATA IN`. Fixed means physical `DATA IN` and `DATA OUT` are known and cannot be changed. Software reversal must never be presented as a repair for a cable connected to the wrong physical end.

Closed paths expose a connector seam. Auto Wire may propose moving the seam on a flexible, uninstalled path to reduce jumper length. Verified or fixed seams cannot move.

Candidate routes are rejected if they branch, cycle, duplicate or omit runs, use unsupported or duplicate pins, violate fixed direction, exceed output or total-pixel limits, or produce invalid firmware ranges. Auto Wire evaluates all candidates for up to nine pixel runs and two outputs, capped at 250,000 candidates in stable ID order. Larger inputs use deterministic spatial clustering, nearest-end insertion, and stable 2-opt route improvement; they use the same 250,000-candidate-operation cap and return an explicit warning if the cap prevents exhausting improvements. Runtime is therefore bounded by work count rather than machine timing.

Remaining candidates are scored lexicographically in this order:

1. fewest outputs that satisfy hard firmware limits and any operator constraint;
2. shortest total jumper length;
3. shortest worst individual jumper;
4. lowest largest-output pixel count, then lowest difference between largest and smallest output;
5. fewest unnecessary reversals and seam moves;
6. fewest avoidable crossed connections;
7. run IDs, output IDs, direction, and seam index serialized in lexical order as the final tie-break.

Jumper length is the straight-line endpoint distance after Size-mode scaling. Crossings are proper intersections between those straight jumper segments; shared endpoints do not count. If physical scale is missing or invalid, routing may proceed in normalized artwork units, but the preview labels lengths as relative and requires the user to acknowledge that cable lengths are not physical estimates. Alternatives are materially equivalent only when hard validity, output count, largest-output count, reversal count, and seam-move count match and total jumper length differs by no more than the greater of 10 mm or 2 percent (or 0.2 percent of the artwork bounding-box diagonal when scale is unavailable).

Auto Wire previews the proposed lanes, run order, physical-direction changes, seam changes, output totals, estimated jumper lengths, and unresolved assumptions. It applies only after the operator chooses Accept routing. When alternatives meet the exact equivalence rule, one quiet Try alternative action is available. The same normalized inputs always produce byte-for-byte identical proposals.

### Bench verification and assembly map

Test wiring runs a guided low-brightness chase. It identifies each output, lights each run in order, asks the operator to confirm first pixel and direction, records corrections into the canonical model, and advances only after confirmation. Completion permits locking the wiring.

The chase uses the existing full-frame stream contract: a complete `RRGGBB[]` frame over direct WebSocket or card-page bridge `frame` feature version 1. Non-target pixels are black; target pixels are capped at 10 percent channel brightness, with a distinct first-pixel marker. A step becomes confirmable only after a delivery acknowledgement (`ok` and not `wsOpen: false`) within 1.5 seconds. While the step is visible, the frame pump refreshes at 4 fps and retains the existing under-two-second watchdog keepalive. Timeout, closed relay socket, or missing bridge feature keeps the step in place with Retry; an HTTPS session with old firmware offers Open Flash and cannot falsely mark the run verified. Starting the chase snapshots the last Studio-confirmed look. Cancel, completion, or failure stops streaming with `cancelStream: true` and reapplies that look; if no confirmed look exists, it releases the stream and lets the card return to its prior firmware state.

The assembly map is derived from the locked model. It lists controller position, connector label and GPIO, ordered runs, LED ranges and counts, physical direction, jumper destination and estimated length, reserved unlit addresses, and verification state. It is optimized for a phone beside the artwork and a clean print view.

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
- Pattern results initially render 24 cards and reveal 24 more when the sentinel is within 600 CSS pixels of the viewport or the operator activates Load more. Search and category filtering always evaluate the complete catalog and reset the visible count to 24.
- SVG measurements used for selected-path decoration are cached or moved to effects and recomputed only when geometry changes.
- Preview geometry is shared or memoized by project revision.
- The production manifest must show each major screen as a lazy chunk and the initial application chunk must not contain the Pattern, Show, Playlist, Settings, Flash, or Installer screen modules. Record manifest/chunk evidence and a browser assertion that the route loading fallback appears before the requested screen. No new runtime dependency is introduced solely for virtualization.

## Error handling

Errors are local to the action that failed and use plain language. A global toast may reinforce success, but it is not the only record of a failure.

Project validation errors leave the current project untouched. Card network errors preserve the last confirmed value. Firmware visitor errors roll back optimistic controls. Destructive actions explain consequences before execution. Recovery actions use concrete verbs such as Retry, Copy payload, Open installer, or Keep editing.

## Implementation boundaries

The work is divided into five integration-safe streams:

1. **Studio trust and application surfaces**
   - Owns active `lightweaver/src/v3/` screens, shared lifecycle and card-action utilities, shell loading, theme implementation, Settings, Patterns, Playlist, and installer behavior.
2. **Layout interaction**
   - Owns `lightweaver/src/components/LayoutScreen.jsx`, `lightweaver/src/components/layout/`, related hooks, Layout-specific styling, and Layout workflow tests.
3. **Firmware visitor reliability**
   - Owns the embedded visitor interface in `firmware/lightweaver-controller/src/LightweaverWeb.cpp` and its focused tests.
4. **Wiring model and compiler**
   - Owns the canonical wiring schema, migration, normalization, validation, address compilation, ledmap/frame/zone derivation, and unit/contract tests under `lightweaver/src/lib/`.
5. **Auto Wire solver**
   - Owns deterministic candidate generation and scoring in a new focused library plus exhaustive solver fixtures. It consumes the accepted wiring-model interfaces and does not edit Layout or firmware files.

Agents must not edit the same file concurrently. Shared CSS changes are assigned to the Studio stream unless a Layout-only stylesheet already owns the rule. Root integration owns documentation, combined review, and verification.

## Testing strategy

All behavior changes follow red, green, refactor:

- Pure unit tests cover the project replacement guard, lifecycle labels, card action transitions, installer persistence, and progressive result calculations.
- Component or browser tests cover destructive import confirmation, card failure rollback, accessible Pattern selection, real artwork preview geometry, and flash confirmation.
- Layout browser tests cover pointer drawing, keyboard selection, preserved drafts, undoable sizing, mobile canvas space, and recovery controls.
- Wiring unit tests cover migration order preservation, inclusive reverse ranges, reserved address totals, output flattening, unique membership, firmware limits, lock enforcement, and compiler parity across ledmap, frames, zones, and card outputs.
- Auto Wire fixtures cover one-output chains, multi-output clustering, fixed physical directions, flexible direction changes, closed-loop seams, equivalent alternatives, output balancing, impossible routes, and deterministic repeatability.
- Wiring browser tests cover drag and tap connections, cutter splitting, lane reassignment, selection synchronization, preflight blocking, Auto Wire preview/accept/cancel, guided chase correction, locking, and assembly-map output.
- Firmware-focused tests inspect or exercise embedded visitor state transitions and rollback behavior.
- Existing workflow tests protect project export, card installation, Pattern selection, Show behavior, and screen navigation.
- Final verification runs the full unit suite, focused Playwright workflows at desktop and mobile sizes, production build, launch check, and available firmware compilation or web-interface checks.

## Delivery order

1. Repair the existing saved-order, reversed-run, reserved-address, output-total, limit, and hidden-validation correctness defects.
2. Introduce the canonical output-lane/run model, migration, compiler, and lock contract.
3. Establish lifecycle and card action contracts with failing tests.
4. In parallel, build manual Wire lanes and connections, Studio surface hardening, and ESP32 visitor reliability against the accepted contracts.
5. Add controller anchors, physical endpoint state, closed-path seams, and the deterministic Auto Wire solver.
6. Add guided bench verification, assembly maps, real geometry previews, progressive Pattern rendering, lazy screens, and geometry caching.
7. Complete responsive behavior, accessibility, themes, motion, copy, and naming consistency.
8. Run combined model, browser, firmware, build, and launch verification, then resolve regressions before delivery.

## Out of scope

- Raspberry Pi proxy or Pi-hosted visitor UI work
- New backend services or cloud synchronization
- Changes to WLED compatibility contracts
- Replacement of the existing visual identity or navigation model
- New pattern algorithms unrelated to accurate previewing
- Hardware behavior changes beyond safer confirmation and error presentation
- Arbitrary node-graph branching inside a single addressable data output
- Automatic power-injection, wire-gauge, fuse, or PSU engineering in this phase
- Obstacle-aware cable routing around undocumented physical structures
- Generative-AI routing or routing that applies without explicit operator acceptance
