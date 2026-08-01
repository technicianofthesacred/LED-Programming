# Kaleidoscope Inline Steppers Design

## Goal

Make Kaleidoscope point count and per-point calibration feel like direct LED positioning controls. Replace the plain point-count field and the shared selected-point nudge row with compact left/right steppers.

## Approved interface

The point-count control is one horizontal stepper:

`←   4 points   →`

Inside **Fine-tune LEDs**, every reflection point is its own horizontal stepper:

`←   1: LED 120   →`

There is no manual text entry. The existing orange selected state remains, and selecting or nudging a point keeps its physical calibration LED as the brighter pulsing red marker.

## Interaction

- Point-count left decreases the quantity by one; right increases it by one.
- Point count remains bounded by the existing minimum of two and the strip's LED count.
- Existing confirmation remains required before a count change clears nonzero fine-tuning offsets.
- Each fine-tune left/right button moves only that reflection point by one LED.
- A point becomes selected before its nudge is applied, keeping canvas, list, and physical calibration selection synchronized.
- Existing collision and crossing validation remains authoritative; rejected nudges show the current inline error and do not consume history.
- Remove the separate shared selected-point nudge row below the point grid.

## Visual treatment

- Reuse the existing dark field, button, focus, hover, selected-orange, and disabled styles.
- The center label takes the available width; arrow buttons remain compact, equal-sized touch targets.
- Point steppers retain the current two-column grid where space permits and collapse responsively using the existing Layout panel rules.
- Disabled boundary arrows remain visible but subdued so the limits are understandable.

## Accessibility

- Quantity arrows use the existing accessible names for decreasing and increasing reflection-point count.
- Each point arrow names the point number, direction, and one-LED movement.
- The center point label remains a selectable button with the existing `Fine-tune reflection point N` accessible name.
- All controls remain keyboard reachable with visible focus treatment.

## Verification

- Extend the Layout Kaleidoscope browser test to assert the point-count stepper, bounds, count confirmation, and updated value.
- Assert each expanded fine-tune item contains left arrow, LED label, and right arrow.
- Assert nudging a non-selected point selects it and moves only that point by one LED.
- Assert collision rejection, undo behavior, selected styling, and physical calibration selection remain intact.
- Run the focused Layout browser suite and production build, then inspect the live Layout screen at desktop and narrow panel widths.
