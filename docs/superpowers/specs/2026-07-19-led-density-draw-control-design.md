# LED density in the draw control

## Goal

Let a maker choose the density of the LED tape for every strip they create, so
the mapper reports the physical tape length implied by their LED count instead
of silently assuming 60 LEDs per metre.

## Interaction

The draw card presents compact, clickable density choices: 30, 60, 96, and 144
LEDs/m, plus Custom. 60 LEDs/m is selected initially for a new strip. Selecting
any preset changes the active density immediately. Custom reveals a numeric
LEDs/m input.

The LED-count field remains the direct input. The existing length readout is
calculated as:

`physical length in metres = LED count / selected LEDs per metre`

For example, 120 LEDs at 60 LEDs/m displays 2.00 m; changing to 144 LEDs/m
updates the same count to 0.83 m.

## Data and compatibility

Each created strip stores its selected `ledsPerMeter` value. Existing saved
strips without that value behave as 60 LEDs/m until edited, preserving their
current appearance and exports. Pixel sampling and all existing export formats
continue to use `pixelCount`; density is planning metadata and the basis for
the physical-length display.

## Validation and testing

Only positive finite density values are accepted. Selecting a preset or changing
the custom value updates the displayed length without changing LED count.
Automated coverage will prove the calculation, the default, preset selection,
and legacy fallback; the production build will also run before handoff.
