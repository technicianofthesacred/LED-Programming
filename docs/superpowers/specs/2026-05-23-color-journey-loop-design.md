# Color Journey Loop Design

## Goal

Make the Pattern Builder color journey behave like a looped, editable color sequence instead of a fixed Start / Middle / End trio.

## Design

The color journey starts with the existing three colors, but it is stored and rendered as an ordered list of stops. The UI shows each stop as a compact chip with a color picker, a visible swatch, and a drag handle. A plus button appends a new stop, defaulting to the selected palette color when available, then the last journey color, then white.

The journey is explicitly looped: the UI labels this as "Loops back to first", and the data model preserves all stops so the pattern runtime can interpolate from the final stop back to the first stop on repeat. Existing saved journeys with three stops continue to load without migration.

Drag behavior is scoped to color work. Journey stops can be dragged left or right to reorder. Palette swatches can be dragged onto a journey stop to replace that stop's color. The drag interactions use native drag and drop with button/input fallbacks, so the feature stays usable even if drag is awkward on a touch screen.

## Testing

Playwright coverage should verify that Graph color mode can add more than three stops, that the loop-back label is visible, that journey stops can be reordered by drag/drop, and that dragging a palette swatch onto a journey stop updates the stop color.
