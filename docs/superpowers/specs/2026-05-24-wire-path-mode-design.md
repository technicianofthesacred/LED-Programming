# Lightweaver Wire Path Mode Design

Date: 2026-05-24
Project: Lightweaver
Status: Approved direction, ready for implementation planning

## Summary

Physical mapping belongs inside Layout as a spatial, visual wire-path mode, not as a separate spreadsheet-style section. The current Patch Board data model is useful and should remain the export contract, but the artist-facing interaction should feel like drawing the real wire path across the artwork.

The goal is to let the artist describe reality visually: this path is one continuous shape, chop it here, chop it there, the wire starts here, travels there, jumps here, resumes there, reverses this run, skips these cut-off LEDs, then saves that physical order into the project. Numbers are an advanced bonus, not the main surface.

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

Numbers should stay available for precision edits, but they should not be the first thing the artist sees. The first read should be visual: colored runs, direction arrows, jump connectors, off spacers, and a compact order strip.

The current LED layer/path list also feels too technical. Names such as `Layer_1: Path 7`, long rows, tiny utility icons, and visible counts are useful internally, but they should not dominate the mapping workflow. The canvas should be the primary way to pick and split paths; the layer/path UI should collapse into a quiet source browser.

## Product Context

Lightweaver is a professional creative tool for the artist/operator. The preview is the hero. The UI should be dense, restrained, and functional, but the mapping workflow itself must be understandable without reading a table.

Scene sentence: the artist is in a studio or beside the installation, looking between the browser and the physical LED art, trying to make software match reality without losing flow.

Color strategy: restrained dark product UI. Use the existing accent only for selected runs, active tools, and confirmation states. Avoid decorative color.

Anchor references:

- Figma pen/path editing for direct manipulation on a canvas.
- Ableton clip/rack density for compact ordered chips and inspector controls.
- DaVinci Resolve viewer-first layout, where the canvas stays dominant and panels support the work.

## Primary User Action

The user should be able to chop a visible source path into physical runs by clicking directly on the path:

```text
Select path -> click cut point -> click another cut point -> Lightweaver shows visible run segments
```

Then the user can click a segment to set direction, split again, or jump to another path and resume the physical wiring order.

## Conceptual Model

Keep the current `patchBoard` model as the saved/exported truth:

- `patches` remain physical runs or off blocks.
- `chains[0].rowIds` remains the physical output order.
- direction is still inferred from start/end source LEDs.
- off blocks still reserve physical addresses and output black.
- export and frame remapping still use expanded patch-board pixels.

The new UX changes how the artist creates and edits that model.

## Layout Strategy

Add a **Wire Path** mode inside Layout. It should sit beside existing modes like LEDs, Light, Heat, and Dots, or as a clearly related sub-mode when LEDs are active.

When Wire Path mode is active:

- the canvas remains the main surface
- sampled LED dots become selectable path points
- a selected source path is shown as one readable shape before it is chopped
- click-created cut marks split the selected source path into visual segments
- current runs are drawn directly on the artwork as highlighted directional paths
- jumps are shown as dashed connectors between runs, not as real LED geometry
- off or hidden LEDs appear as small black spacers in the order strip
- a compact wire-order ribbon appears along the bottom edge of the canvas
- a tiny floating inspector appears only when a run is selected

The existing large Patch Board panel should disappear from the default workflow. Keep its fields only as an advanced/debug inspector for the selected run. It should not consume the whole right panel by default.

The imported layer/path list should also be reduced. In Wire Path mode it becomes a compact **Source Paths** drawer:

- collapsed by default after a path is selected
- friendly path names first, technical SVG IDs hidden in tooltips
- one active source path summary instead of a tall repeated row list
- counts shown only as small secondary metadata
- no permanent utility icon cluster unless a row is hovered or selected
- canvas selection preferred over row selection

## Main Workflow

### 1. Enter Wire Path Mode

The user clicks `Wire Path` from Layout. The app shows:

- selectable LED dots
- current run overlays
- a compact wire-order ribbon
- map status: unlocked, unsaved changes, or locked

### 2. Pick A Source Path

The user clicks an existing LED strip/path on the canvas. Lightweaver emphasizes that full path as the current source:

- the path line becomes brighter
- sampled dots become clearer
- the first and last available LED points are subtly marked
- the source drawer collapses to a compact active-path summary

This step replaces hunting through a tall technical layer list.

### 3. Chop The Path Into Runs

The user clicks on the selected path to place cut marks. Each cut mark snaps to the nearest sampled LED point. The visual output is immediate:

- the path is split into colored run segments
- each segment gets a small direction arrow
- the wire-order ribbon adds or updates matching chips
- the selected segment is highlighted on both canvas and ribbon

This is the preferred first workflow because it matches the artist's mental model: "I am on this visible path, and I want to chop it here."

### 4. Create A Run By Endpoints

The user clicks one LED dot as the start. The dot becomes the active start point. As the cursor moves over other dots on the same strip, Lightweaver previews the possible run with:

- a lit path segment
- a direction arrow
- a small count badge
- a muted warning if the hover target is invalid

Lightweaver creates a patch from that sampled source range:

```text
Run 01: Layer A, LED 2 -> LED 10
```

If the second dot has a lower source index, the run is reversed automatically:

```text
Run 01: Layer A, LED 10 -> LED 2
```

Endpoint creation is still useful for power users and odd wiring, but path chopping should be the default interaction.

### 5. Jump And Resume

After a run is created, the next click can start a new run anywhere on the artwork. This supports wiring that leaves one area and resumes somewhere else. The jump is visible as a dashed connector from the previous run end to the new run start, making the non-linear physical path understandable at a glance.

The wire-order ribbon makes the physical chain explicit without turning into a table:

```text
01 Outer A -> | jump | 02 Inner B -> | 03 Off x3 | 04 Outer C <-
```

### 6. Edit A Run

Selecting a run shows:

- start marker on the artwork
- end marker on the artwork
- reverse icon
- off/on toggle
- rename action
- delete icon
- Advanced drawer for numeric range

Full target behavior: dragging a handle snaps to sampled LED dots. The first implementation can use click-to-replace start/end points before drag handles exist. Clicking reverse swaps start/end. The numeric range stays available in an advanced drawer for precision and debugging.

### 7. Reorder Wire Output

The wire-order ribbon uses compact chips. Full target behavior: dragging chips changes output order. The first implementation can use selected-chip move actions if that reduces risk.

Each chip should show:

- order number
- run name or source layer
- direction arrow
- LED count
- off state if applicable

Example:

```text
01 Outer A ->    jump    02 Inner B <-    03 Off x3    04 Center ->
```

The chip ribbon replaces the current tall row list as the default control. Chips should be small, visual, and glanceable. LED counts can appear in tooltips or selected state rather than always taking space.

### 8. Add Off Or Cut-Off LEDs

The user can insert an off block between chips:

```text
Insert off LEDs after selected run
```

The first interaction can ask only for count. Later, hardware verification can help detect hidden or cut-off LEDs, but this design does not require that yet.

### 9. Lock The Map

Once the physical wiring is correct, the user locks the map. Locked mode:

- keeps preview and export behavior active
- prevents accidental run creation, deletion, reorder, or handle movement
- still allows selecting runs and inspecting them
- requires an explicit unlock to edit physical order

## Key States

### Empty Map

No physical map has been created yet. Show a quiet prompt in the canvas area:

```text
Click the first LED in the real wire path.
```

Do not show a large onboarding card. Keep the preview dominant.

### Creating Run

After the first click:

- highlight selected start dot
- show a live wire preview from start dot to hovered dot when possible
- show direction near the cursor or inspector
- show LED count only as a small badge or tooltip
- allow Escape to cancel

### Existing Map

Show wire runs as subtle overlays:

- selected run gets accent color
- selected source path shows its chopped segments clearly
- inactive/off runs are dim
- jumps are dashed and visually distinct from LED paths
- stacked or reused source LEDs show a small count marker

### Out Of Range After LED Count Changes

If a saved range is longer than the actual LED length, Lightweaver keeps the saved intent but only exports existing LEDs. The UI should show a warning on the affected chip:

```text
Range ends past current LED count. Missing LEDs are skipped.
```

### Locked Map

The map is viewable but not editable. Editing controls are disabled. The unlock action should be clear and deliberate.

### No Artwork Or No Strips

Wire Path mode is disabled or shows a compact empty state:

```text
Create LED strips before mapping physical order.
```

## Interaction Details

### Dot Selection

LED dots should be easy to target. On hover, enlarge the hit area without changing layout. Show source label and LED index in a small tooltip or status line.

### Path Slicing

Clicking the selected source path places a cut marker at the nearest sampled LED. A path with no cuts is one run. One cut creates two runs. Two cuts create three runs.

Each slice should be reflected immediately:

- the canvas segment receives its own subtle color tint
- the segment appears as a chip in the wire-order ribbon
- selecting either the segment or chip selects the other
- reversing a segment flips the arrow on both the canvas and chip
- deleting a cut merges adjacent segments

The first implementation can support simple split points without draggable cut handles. Dragging cut handles can come later.

### Path Preview

When start and hover points are on the same source strip, preview the inclusive range between them as a visible wire path. If they are on different strips, treat the second click as the start of a jump only after the current run has been completed. During a single run, a different-strip hover should show an invalid target hint unless multi-source run support is explicitly added later.

First implementation should keep one run tied to one source strip. Jumps create new runs.

### Direction

Direction is inferred:

- start index less than end index means forward
- start index greater than end index means reverse

The UI should show direction visually with a small arrow on the run overlay and chip.

### Visual Priority

The canvas should answer the main questions without opening a panel:

- Which source path am I editing?
- Where is this path chopped?
- Where does the wire start?
- Which direction does it travel?
- Where does it jump?
- Which runs are active or off?
- What is the current physical order?

Numbers should answer secondary debugging questions:

- What source LED index is this?
- What exported address range is this?
- How many LEDs are in this run?
- What was skipped because the actual strip is shorter?

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

### Source Path Drawer

The current layer/path UI should be reduced into a source picker, not a mapping control panel.

Default presentation:

```text
Source Paths
3 layers · 67 paths
Active: Outer Loop
```

When expanded, rows should be compact and readable:

```text
Outer Loop        52 px
Inner Return     113 px
Halo Arc          41 px
```

Avoid exposing technical names in the primary label. Keep raw SVG layer/path IDs in secondary metadata, tooltips, or an advanced details row.

## Content Requirements

Use direct tool labels:

- Wire Path
- Source Paths
- Chop path
- Add cut
- Merge segment
- Start run
- End run
- Reverse
- Insert off LEDs
- Lock path
- Unlock path
- Advanced

Avoid abstract labels like Patch Board in the primary interface. `Patch Board` can remain an internal model name, but user-facing copy should prefer physical language: wire path, run, jump, off LEDs, order, lock path.

## Implementation Scope Recommendation

Do not implement this as a large all-at-once redesign. Split it into two implementation plans.

### Plan 1: Canvas-First Run Creation

Deliver:

- Wire Path mode in Layout
- canvas selection of an existing source path
- click-to-chop source path into visible run segments
- selected source path overlay
- segment selection reflected between canvas and chip ribbon
- endpoint creation available after or alongside slicing
- live path preview while choosing an end dot or cut point
- selected run overlay with direction arrow
- compact wire-order chips
- run selection
- reverse/delete actions
- selected-chip move actions for physical order
- advanced numeric drawer hidden by default
- reduced Source Paths drawer replacing the tall layer/path mapping emphasis
- save/load/export still using existing `patchBoard`
- e2e coverage for point-click creation and export order

Defer:

- drag handles
- draggable cut handles
- chip drag reorder
- hardware verification
- multi-output controllers
- group playback UI
- automatic wire path detection

### Plan 2: Direct Manipulation Polish

Deliver:

- draggable start/end handles
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
- Do not make LED index numbers constantly visible in the default view.
- Do not make the imported layer/path list the main mapping interface.

## Risks

The biggest risk is hiding too much precision. LED work still needs exact numbers when debugging hardware. The fix is not to keep the current spreadsheet as the main UI, but to preserve a compact advanced numeric drawer per selected run.

The second risk is making canvas point-click ambiguous. The first implementation should keep the rules strict: one run comes from one source strip, jumps create new runs, and invalid clicks explain what happened.

## Success Criteria

This redesign works when the artist can map a non-linear LED installation without typing start and end numbers first.

Concrete acceptance criteria:

- A user can select a source path on the canvas without hunting through the layer list.
- A user can click the selected path to add a cut and see the path split visually.
- A user can select a chopped segment and see the matching chip selected.
- A user can create `2 -> 10` by clicking source LED 2 then source LED 10.
- A user can create `10 -> 2` by clicking in reverse order.
- A user can jump to another region and create the next run.
- A user can reorder runs in physical output order.
- A user can insert off LEDs without leaving Layout.
- Saved projects preserve the physical map.
- LED map and frame exports use the visual physical order.
- The default visible UI is mostly canvas, with numbers hidden until hover, selection, or Advanced.
- The interaction feels like tracing the real wire path, not filling out rows.
- The source layer/path list is minimized, friendlier, and secondary to canvas interaction.

## Recommended Implementation References

- `/Users/adrianrasmussen/.agents/skills/impeccable/reference/product.md` for dense product UI constraints and component-state discipline.
- `/Users/adrianrasmussen/.agents/skills/impeccable/reference/shape.md` for keeping this as a confirmed design brief before implementation.
- Existing Lightweaver Layout and patch model files for local patterns: `lightweaver/src/components/LayoutScreen.jsx`, `lightweaver/src/components/PatchBoardScreen.jsx`, and `lightweaver/src/lib/patchBoard.js`.

## Open Questions For Implementation Planning

- Should Wire Path be a top-level Layout mode beside `LEDs`, or a sub-mode under `LEDs`?
- Should the wire-order ribbon live along the bottom of the canvas or inside the right panel?
- Should clicking the same strip after a completed run immediately start the next run, or require an explicit `Start run` state?
- Should the first plan label selected-chip move actions as temporary, or are explicit move controls valuable enough to keep alongside drag reorder later?
- Should the first implementation treat each cut as splitting the current source path in source order, or should it also allow selecting arbitrary segments out of order immediately?
