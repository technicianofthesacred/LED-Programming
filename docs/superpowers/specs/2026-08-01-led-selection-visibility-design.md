# LED Section Selection Visibility

## Goal

Make the selected LED section unmistakable at any canvas zoom level and make its draggable state clear from the pointer alone.

## Selected-state treatment

The selected section receives a cyan outer halo and a crisp white core drawn above its existing colored path. Their apparent on-screen thickness remains constant as the canvas zoom changes, so zooming far out cannot collapse the selection indicator into the artwork.

A compact locator badge appears at the section midpoint. It shows the section's display number and LED count. The badge also retains a constant on-screen size and is displayed only for the selected section.

Unselected sections and the imported artwork retain their current appearance. Selection does not dim the rest of the layout.

## Pointer and drag behavior

- Hovering an unselected section in Select mode uses the existing pointer cursor.
- Hovering the selected section uses an open-hand `grab` cursor.
- Pressing and moving the selected section uses a closed-hand `grabbing` cursor until release.
- Clicking an unselected section selects it.
- Clicking the selected section without dragging leaves it selected.
- Clicking blank canvas deselects the section and removes its halo and badge.
- Draw, Delete, pan, and connector-drag cursor behavior remains unchanged.

## Implementation boundary

Selection rendering and hit-target cursor state remain owned by `CanvasManager`. The zoom controller reports zoom changes to `CanvasManager`, which recalculates the overlay stroke widths and badge scale so their screen-space appearance stays stable. Existing strip geometry, LED positions, section selection callbacks, and saved project data do not change.

The badge is part of the non-interactive selection overlay. It cannot intercept clicks or drags and therefore does not reduce the existing section hit area.

## Verification

Verify the following in the real mapper canvas:

- Selection remains obvious at minimum, 100%, and maximum zoom.
- The halo and badge maintain consistent apparent size while zooming.
- Selecting a different section moves the halo and badge without leaving stale overlays.
- Blank-canvas deselection removes the complete selection treatment.
- Unselected hover, selected hover, active dragging, Delete mode, pan mode, and connector dragging show the intended cursors.
- Selection and dragging still work where sections overlap.
- The production build and existing mapper tests pass.

## Out of scope

- Multi-section canvas selection.
- Changes to artwork-path selection.
- Changes to layout colors, section geometry, or project serialization.
- Dimming or hiding unselected sections.
