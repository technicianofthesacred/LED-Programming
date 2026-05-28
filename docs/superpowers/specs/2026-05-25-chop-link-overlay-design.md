# Lightweaver Chop And Link Overlay Design

Date: 2026-05-25
Project: Lightweaver
Status: Approved design direction, awaiting implementation plan

## Summary

Wire Path should become a temporary overlay tool inside Layout. The artist stays on the real artwork, turns on `Chop`, clicks cut points directly on the LED/vector path, tunes those cuts, then turns `Chop` off to lock the segmentation into the canvas. After chopping, `Link` records the physical wire order by clicking the resulting segments in sequence.

This builds on `2026-05-24-wire-path-mode-design.md`, but makes the main interaction more explicit: the canvas is the authoring surface, and the Details area is only for tuning the selected cut, segment, or jump.

## Product Context

Lightweaver is used beside a physical LED artwork. The operator is not thinking in tables first; they are looking at the art and asking, "where does the wire break, and where does it resume?" The UI should therefore feel like a route editor over the installation drawing, not a separate patch spreadsheet.

Scene sentence: an artist is standing next to the installation with a laptop or phone, using the artwork preview to make software match the real soldered wire path.

Design register: product UI. Keep the preview dominant, controls compact, and language concrete.

## Core Model

The saved/exported truth remains the existing `patchBoard` model:

- `patches` represent physical LED runs or off blocks.
- `chains[0].rowIds` represents physical output order.
- segment direction remains encoded as `startLed -> endLed` or `endLed -> startLed`.
- off blocks reserve exported addresses and output black.
- exports and live remapping continue to expand through `patchBoard`.

The new overlay changes how the user authors that model. It does not create a second mapping system.

## Modes

### Normal Layout

Normal Layout keeps the current artwork editing behavior: select paths, move strips, import SVGs, edit layers, and preview light.

Existing Wire Path overlays remain visible as passive context when useful, but the canvas is not in route-edit mode.

### Chop Mode

`Chop` is a toolbar mode over Layout. When active:

- the selected LED strip/path becomes the editable source path
- sampled LED points become snap targets
- clicking on the path places a cut marker at the nearest real LED index
- each marker splits the source path into visual segments
- segment overlays update immediately on the artwork
- the Details area switches to cut/segment tuning
- normal path selection and strip dragging are suspended

Chop mode is draft-like while active. Toggling `Chop` off commits the current cut set to `patchBoard`. Pressing `Esc` cancels uncommitted cuts and restores the previously saved segmentation.

If implementation risk is high, the first version may commit after each click while still preserving `Esc` as "clear current mode selection," but the target behavior is commit-on-exit.

After chopping, Lightweaver may use natural path order as a temporary route so existing exports keep working. Once the user enters Link mode and starts recording a custom route, that explicit route becomes authoritative.

### Link Mode

`Link` is a second toolbar mode over Layout. When active:

- each chopped segment is clickable
- clicking a segment assigns the next physical route number
- numbered badges appear directly on the canvas
- dashed jump lines connect the end of each route segment to the start of the next one
- the Wire Order chips update from the clicked route
- clicking an already linked segment removes it from the route and renumbers the remaining route

Link mode is the answer to wacky physical wiring. A segment can be first even if it is visually the tenth layer. A segment can jump across the artwork and resume anywhere.

## Details Area

The Details area edits only the selected object. It should not become the primary authoring surface.

### Selected Cut Marker

Show:

- selected source path name
- LED index
- `-` and `+` buttons to move the cut one LED earlier or later
- Delete cut
- optional numeric LED index field in Advanced

The `-` and `+` controls move the cut marker along the same source strip by one sampled LED at a time. They do not change segment order.

### Selected Segment

Show:

- route number, if linked
- source path name
- LED count
- direction
- Reverse
- Skip/Off
- Earlier/Later for route order tuning
- Delete segment from route
- Advanced start/end LED fields

Reverse swaps the segment's exported direction. It should not move the segment visually.

### Selected Jump

Show:

- from segment
- to segment
- Insert off LEDs
- delete or clear route link

This supports hidden LEDs, cut-off tails, physical wire extensions, and intentional blackout addresses between two visible runs.

## Canvas Visuals

Chop and Link must be readable directly on the artwork:

- cut markers use small high-contrast ticks or dots on the path
- selected cut markers get a larger ring
- chopped segments use subtle colored strokes over the real LED path
- route numbers appear as compact circular badges
- reversed segments show direction arrows
- unlinked segments are muted and labeled only when selected or hovered
- jumps use dashed lines that are visually distinct from real LED geometry
- off blocks appear in the order chips and selected jump details, not as fake geometry on the artwork

The visual hierarchy should make the current mode obvious without covering the artwork. The overlay is a tool layer, not a new page.

## Workflow

### Chop A Path

1. Select or hover a source LED path.
2. Click `Chop`.
3. Click cut points directly on the actual vector/LED path.
4. Use `-`, `+`, or Delete in Details if a cut needs tuning.
5. Click `Chop` again to commit and leave chop mode.

The result is visible as locked-in canvas segments.

### Link A Route

1. Click `Link`.
2. Click the segment that physically receives LED address 1 first.
3. Continue clicking segments in real wire order.
4. Watch numbered badges and dashed jumps appear.
5. Click `Link` again to commit the route.

The resulting order updates `chains[0].rowIds`.

### Tune After Linking

1. Select a cut, segment, or jump on the canvas.
2. Use Details for small adjustments.
3. Lock the physical map when the installation matches reality.

## Error Handling

Invalid operations should be blocked or explained in place:

- chopping at the first or last LED does not create a cut
- two cuts cannot occupy the same LED index
- cuts cannot cross each other when nudged with `-` or `+`
- a segment cannot be linked twice in the same route
- after a custom route exists, unlinked segments are visibly muted and do not export unless included in the route
- if a saved range exceeds the actual LED count after LED length changes, the UI warns and export skips missing LEDs
- locked maps disable Chop, Link, cut deletion, route edits, and nudges

## Component Boundaries

Keep the implementation modular:

- `patchBoard.js`: pure helpers for cut normalization, segment generation, route ordering, and validation.
- `LayoutScreen.jsx`: owns overlay mode state, canvas hit targets, and canvas rendering.
- `PatchBoardScreen.jsx`: becomes a compact Details/Wire Order support panel rather than the main chopping surface.
- CSS: add dedicated overlay classes for chop markers, route badges, jump lines, and selected details.
- tests: model tests verify cut and route behavior; Playwright tests verify the user-facing canvas workflow.

## Testing Strategy

Model tests should cover:

- cuts snap to valid LED indexes
- endpoint cuts are ignored
- duplicate cuts are deduplicated
- nudging a cut by `-` or `+` updates adjacent segments
- deleting a cut merges adjacent segments
- route ordering from clicked segment IDs updates `chains[0].rowIds`
- natural path order remains usable before a custom route exists
- unlinked segments do not export as active route rows after a custom route exists

Playwright tests should cover:

- importing an SVG and adding a strip
- entering Chop mode from the canvas toolbar
- clicking the actual strip path to create a cut
- seeing canvas cut markers and segment overlays
- tuning a selected cut with `+` or `-`
- entering Link mode
- clicking segments in physical order
- saving project JSON and confirming `patchBoard` contains the expected segment order

## Open Decisions Resolved

- `+` and `-` tune the selected cut marker by one LED index, not route order.
- route order is created by Link mode and fine-tuned by Earlier/Later controls.
- the right panel is Details, not the primary chopping UI.
- the canvas is the source of truth for authoring chops and links.
- this is an overlay over Layout, not a separate Patch screen.
