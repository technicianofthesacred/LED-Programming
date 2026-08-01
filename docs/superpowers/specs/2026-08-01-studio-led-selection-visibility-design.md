# Studio LED Selection Visibility

## Goal

Bring the proven mapper selection treatment into the live Lightweaver Studio Layout screen so a selected LED strip remains unmistakable at every supported zoom level and its draggable state is clear from the pointer.

## Live surface

The change belongs in the existing Studio Layout canvas at `led.mandalacodes.com`. It does not publish the standalone mapper or add a new public route.

## Selected-state treatment

When exactly one LED strip is selected, Studio draws a non-interactive overlay above the existing strip rail:

- a broad cyan halo that separates the strip from artwork and nearby LEDs;
- a narrow white core that keeps the selected path crisp against any color;
- a compact midpoint badge showing the strip name and LED count.

The overlay widths, badge dimensions, typography, and offsets use the canvas view-box scale so their apparent screen size remains stable from minimum through maximum zoom. The existing corner selection frame remains as a secondary locator for the strip's overall bounds.

The overlay must not dim other strips, intercept pointer events, or alter the strip's saved geometry or color.

## Pointer and drag behavior

- Hovering an unselected strip in Draw mode uses `pointer` because clicking selects it.
- Hovering a selected strip in Draw mode uses `grab` because it can be moved.
- While the selected strip is moving, its hit target uses `grabbing`.
- Size and Wire modes retain selection behavior without implying that strips can be repositioned there.
- First-LED picking, Kaleidoscope picking, drawing, panning, wiring, and other specialized cursor states retain precedence.

## Implementation boundary

`LayoutCanvas` owns the visual overlay and hit-target cursor because it already renders strip rails, LED dots, selection labels, and the zoom-scaled selection frame. Existing selection and drag state from `useLayoutCanvasInteraction` remains the source of truth.

No new persisted state, project migration, route, dependency, or deployment configuration is required.

## Verification

Automated browser coverage must prove:

- a selected strip exposes the halo, white core, and badge;
- overlay dimensions derive from the current view-box scale;
- an unselected strip uses `pointer`, a selected strip uses `grab`, and a moving selected strip uses `grabbing`;
- the overlay is non-interactive;
- selection remains visible at representative minimum, normal, and maximum zoom levels;
- existing Layout interaction tests and the production build pass.

The final check must run through the normal signed main-branch gate and the existing `Deploy site` workflow, then verify the live Studio deployment.

## Out of scope

- Publishing the standalone mapper.
- Changing multi-strip selection behavior.
- Changing artwork-path selection.
- Changing strip geometry, colors, wiring, LED addressing, or project serialization.
