# Lightweaver Physical Map Mode Design

Date: 2026-05-24
Project: Lightweaver
Status: Approved direction, ready for implementation planning

## Summary

Physical mapping belongs inside Layout as a spatial editing mode, not as a separate spreadsheet-style section. The current Patch Board data model is useful and should remain the export contract, but the primary interaction should become point-and-click on the artwork.

The goal is to let the artist describe the real wiring path visually: start here, end there, jump here, resume there, reverse this run, skip these cut-off LEDs, then save that physical order into the project.

## Problem

The current embedded Patch Board proves the model, but it asks the artist to think mostly in LED index numbers:

- start LED
- end LED
- output order
- off counts
- row reorder buttons

Those fields are correct for debugging, but they are not the right main interface. In the studio, the artist is looking at the artwork and the real wire path. The natural workflow is spatial:

1. The wire starts on this dot.
2. It travels to that dot.
3. It jumps to another physical area.
4. It resumes there.
5. A run is backwards.
6. Some physical LEDs are hidden, cut off, or intentionally black.

Numbers should stay available for precision edits, but they should not be the first thing the artist sees.

## Product Context

Lightweaver is a professional creative tool for the artist/operator. The preview is the hero. The UI should be dense, restrained, and functional, but the mapping workflow itself must be understandable without reading a table.

Scene sentence: the artist is in a studio or beside the installation, looking between the browser and the physical LED art, trying to make software match reality without losing flow.

Color strategy: restrained dark product UI. Use the existing accent only for selected runs, active tools, and confirmation states. Avoid decorative color.

Anchor references:

- Figma pen/path editing for direct manipulation on a canvas.
- Ableton clip/rack density for compact ordered chips and inspector controls.
- DaVinci Resolve viewer-first layout, where the canvas stays dominant and panels support the work.

## Primary User Action

The user should be able to define a physical LED run by clicking two points on the artwork:

```text
Click start dot -> click end dot -> Lightweaver creates a mapped run
```

Then the user can click another start point to jump and resume the physical wiring order.

## Conceptual Model

Keep the current `patchBoard` model as the saved/exported truth:

- `patches` remain physical runs or off blocks.
- `chains[0].rowIds` remains the physical output order.
- direction is still inferred from start/end source LEDs.
- off blocks still reserve physical addresses and output black.
- export and frame remapping still use expanded patch-board pixels.

The new UX changes how the artist creates and edits that model.

## Layout Strategy

Add a **Physical Map** mode inside Layout. It should sit beside existing modes like LEDs, Light, Heat, and Dots, or as a clearly related sub-mode when LEDs are active.

When Physical Map mode is active:

- the canvas remains the main surface
- sampled LED dots become selectable physical map points
- current physical runs are drawn as highlighted directional paths
- jumps are shown as quiet connector indicators, not as real LED geometry
- a compact physical-order ribbon appears at the bottom or lower right
- a small inspector shows details for the selected run

The existing large Patch Board panel should be reduced to an advanced/debug inspector. It should not consume the whole right panel by default.

## Main Workflow

### 1. Enter Physical Map Mode

The user clicks `Physical Map` from Layout. The app shows:

- selectable LED dots
- current physical run overlays
- a compact order ribbon
- map status: unlocked, unsaved changes, or locked

### 2. Create A Run

The user clicks one LED dot as the start, then another dot as the end.

Lightweaver creates a patch from that sampled source range:

```text
Run 01: Layer A, LED 2 -> LED 10
```

If the second dot has a lower source index, the run is reversed automatically:

```text
Run 01: Layer A, LED 10 -> LED 2
```

### 3. Jump And Resume

After a run is created, the next click can start a new run anywhere on the artwork. This supports wiring that leaves one area and resumes somewhere else.

The order ribbon makes the physical chain explicit:

```text
01 Outer A 2 -> 10 | 02 Inner B 11 -> 20 | 03 Off x3 | 04 Outer C 30 -> 21
```

### 4. Edit A Run

Selecting a run shows:

- start handle
- end handle
- reverse action
- output mode: on/off
- rename
- delete
- advanced numeric range

Full target behavior: dragging a handle snaps to sampled LED dots. The first implementation can use click-to-replace start/end points before drag handles exist. Clicking reverse swaps start/end. The numeric range stays available in an advanced drawer for precision and debugging.

### 5. Reorder Physical Output

The physical order ribbon uses compact chips. Full target behavior: dragging chips changes output order. The first implementation can use selected-chip move actions if that reduces risk.

Each chip should show:

- order number
- run name or source layer
- direction arrow
- LED count
- off state if applicable

Example:

```text
01 Outer A 9 leds -> 02 Jump -> 03 Inner B 10 leds <- 04 Off 3
```

The chip ribbon replaces the current tall row list as the default control.

### 6. Add Off Or Cut-Off LEDs

The user can insert an off block between chips:

```text
Insert off LEDs after selected run
```

The first interaction can ask only for count. Later, hardware verification can help detect hidden or cut-off LEDs, but this design does not require that yet.

### 7. Lock The Map

Once the physical wiring is correct, the user locks the map. Locked mode:

- keeps preview and export behavior active
- prevents accidental run creation, deletion, reorder, or handle movement
- still allows selecting runs and inspecting them
- requires an explicit unlock to edit physical order

## Key States

### Empty Map

No physical map has been created yet. Show a quiet prompt in the canvas area:

```text
Click the first physical LED, then the last LED in that run.
```

Do not show a large onboarding card. Keep the preview dominant.

### Creating Run

After the first click:

- highlight selected start dot
- show a live preview from start dot to hovered dot when possible
- show count and direction near the cursor or inspector
- allow Escape to cancel

### Existing Map

Show physical runs as subtle overlays:

- selected run gets accent color
- inactive/off runs are dim
- jumps are visible but visually distinct from LED paths
- stacked or reused source LEDs show a small count marker

### Out Of Range After LED Count Changes

If a saved range is longer than the actual LED length, Lightweaver keeps the saved intent but only exports existing LEDs. The UI should show a warning on the affected chip:

```text
Range ends past current LED count. Missing LEDs are skipped.
```

### Locked Map

The map is viewable but not editable. Editing controls are disabled. The unlock action should be clear and deliberate.

### No Artwork Or No Strips

Physical Map mode is disabled or shows a compact empty state:

```text
Create LED strips before mapping physical order.
```

## Interaction Details

### Dot Selection

LED dots should be easy to target. On hover, enlarge the hit area without changing layout. Show source label and LED index in a small tooltip or status line.

### Path Preview

When start and hover points are on the same source strip, preview the inclusive range between them. If they are on different strips, treat the second click as an invalid end for the current run unless multi-source run support is explicitly added later.

First implementation should keep one run tied to one source strip. Jumps create new runs.

### Direction

Direction is inferred:

- start index less than end index means forward
- start index greater than end index means reverse

The UI should show direction visually with a small arrow on the run overlay and chip.

### Reused Coordinates

The model can allow stacked/reused source LEDs, but the UI should warn. Reuse can be useful for advanced art mappings, but it should not happen silently.

### Advanced Numeric Drawer

Every selected run can expose advanced fields:

- source strip
- start LED
- end LED
- output start
- output end
- source LED count
- exported LED count

This drawer is for correction and debugging. It is not the default workflow.

## Content Requirements

Use direct tool labels:

- Physical Map
- Start run
- End run
- Reverse
- Insert off LEDs
- Lock map
- Unlock map
- Advanced

Avoid abstract labels like Patch Board in the primary interface. `Patch Board` can remain an internal model name or advanced inspector title, but user-facing copy should prefer physical language: run, jump, off LEDs, order, map.

## Implementation Scope Recommendation

Do not implement this as a large all-at-once redesign. Split it into two implementation plans.

### Plan 1: Canvas-First Run Creation

Deliver:

- Physical Map mode in Layout
- click start dot, click end dot to create a run
- selected run overlay
- compact physical-order chips
- run selection
- reverse/delete actions
- selected-chip move actions for physical order
- advanced numeric drawer
- save/load/export still using existing `patchBoard`
- e2e coverage for point-click creation and export order

Defer:

- drag handles
- chip drag reorder
- hardware verification
- multi-output controllers
- group playback UI
- automatic wire path detection

### Plan 2: Direct Manipulation Polish

Deliver:

- draggable start/end handles
- live hover preview
- better jump visualization
- chip drag reorder
- off-block insertion between chips
- stacked LED badges
- locked-map interaction polish

## Non-Goals

- Do not replace the patch-board data model.
- Do not build hardware verification in the first point-click pass.
- Do not support one run spanning multiple source strips yet.
- Do not make a separate Patch screen.
- Do not make the right panel larger or more table-like.
- Do not turn physical mapping into a wizard. This should stay inside Layout.

## Risks

The biggest risk is hiding too much precision. LED work still needs exact numbers when debugging hardware. The fix is not to keep the current spreadsheet as the main UI, but to preserve a compact advanced numeric drawer per selected run.

The second risk is making canvas point-click ambiguous. The first implementation should keep the rules strict: one run comes from one source strip, jumps create new runs, and invalid clicks explain what happened.

## Success Criteria

This redesign works when the artist can map a non-linear LED installation without typing start and end numbers first.

Concrete acceptance criteria:

- A user can create `2 -> 10` by clicking source LED 2 then source LED 10.
- A user can create `10 -> 2` by clicking in reverse order.
- A user can jump to another region and create the next run.
- A user can reorder runs in physical output order.
- A user can insert off LEDs without leaving Layout.
- Saved projects preserve the physical map.
- LED map and frame exports use the visual physical order.
- The default visible UI is compact enough to keep the preview dominant.

## Recommended Implementation References

- `/Users/adrianrasmussen/.agents/skills/impeccable/reference/product.md` for dense product UI constraints and component-state discipline.
- `/Users/adrianrasmussen/.agents/skills/impeccable/reference/shape.md` for keeping this as a confirmed design brief before implementation.
- Existing Lightweaver Layout and patch model files for local patterns: `lightweaver/src/components/LayoutScreen.jsx`, `lightweaver/src/components/PatchBoardScreen.jsx`, and `lightweaver/src/lib/patchBoard.js`.

## Open Questions For Implementation Planning

- Should Physical Map be a top-level Layout mode beside `LEDs`, or a sub-mode under `LEDs`?
- Should the physical-order ribbon live along the bottom of the canvas or inside the right panel?
- Should clicking the same strip after a completed run immediately start the next run, or require an explicit `Start run` state?
- Should the first plan label selected-chip move actions as temporary, or are explicit move controls valuable enough to keep alongside drag reorder later?
