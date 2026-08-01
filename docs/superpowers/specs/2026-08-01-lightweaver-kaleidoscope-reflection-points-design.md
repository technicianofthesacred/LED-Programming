# Lightweaver Kaleidoscope Reflection Points Design

## Goal

Lightweaver must let an artist calibrate repeated or mirrored pattern motion to the real turning points of one physical LED strip. A typical installation is a 400-pixel strip wrapped around a rectangular frame, but the design must work for any loop with two or more reflection points, including triangles, hexagons, and irregular frames.

The physical mapping belongs to each strip/layer in **Layout**. Pattern and show tools consume the mapping after Layout is calibrated; patterns do not define their own copies of the physical points.

The feature is named **Kaleidoscope** in the Layout interface.

## User experience

### Toolbar placement

Use the existing expanded strip/layer toolbar in Layout.

- Keep path direction, data direction, and first-LED controls on the left.
- Add a compact Kaleidoscope button in the current visibility-button position.
- Move visibility to the right-side management group, between Duplicate and Delete.
- Do not change the behavior of visibility, duplicate, delete, first LED, path direction, or data direction.
- The Kaleidoscope button must have an accessible name such as `Edit Kaleidoscope reflection points` and a concise tooltip.

The final toolbar grouping is:

```text
Physical setup:   Flip path · Data direction · First LED · Kaleidoscope
Layer management: Duplicate · Visibility · Delete
```

### Compact Kaleidoscope panel

Clicking Kaleidoscope opens a compact, collapsible editor within that strip/layer's existing expanded row. Normal Layout remains uncluttered when the editor is closed.

The editor contains:

1. A point-count control. It accepts every integer from 2 through the strip's current LED count. It is not restricted to presets such as 4, 6, or 8. A new mapping defaults to 4 when the strip has at least 4 LEDs and otherwise defaults to the strip's LED count.
2. A **Pick starting point** action. The artist clicks an LED on the Layout canvas to establish reflection point 1.
3. Previous/next LED arrows for the starting point. Nudging the starting point rotates the complete automatically spaced set without changing individual fine-tune offsets.
4. A **Fine-tune LEDs** action. It expands the individual point selector and previous/next LED arrows.
5. A compact summary such as `4 points · start LED 101` when the details are collapsed.

Changing the point count recomputes even spacing from the current starting point. If individual fine-tune offsets are non-zero, Lightweaver confirms before clearing those offsets.

### Automatic spacing

For a strip with `N` LEDs, `C` reflection points, and starting LED `S`, the automatic source-local LED index for point `k` is:

```text
auto(k) = modulo(S + round(k × N / C), N), for k = 0 … C - 1
```

This treats the physical frame as a cyclic pattern domain. It works whether the SVG path is explicitly closed or its first and final physical LEDs merely meet at the frame seam.

The starting point is the phase control for the whole set. Moving it by one LED moves every automatically positioned reflection point by one LED.

### Fine tuning

Fine tuning stores one signed, source-local LED offset per reflection point. The final point is:

```text
final(k) = modulo(auto(k) + offset(k), N)
```

Offsets default to zero. Individual nudges must preserve cyclic point order and may not cross or collide with neighboring reflection points. Invalid nudges remain unapplied and the editor explains that the neighboring point is the limit.

The first point's normal phase adjustment is the starting-point control. Fine tuning may also adjust point 1, but that change is an individual offset and must not rotate the other points.

### Live physical calibration

Opening point placement or fine tuning starts a transient calibration preview through the existing card frame-streaming path:

- Every configured reflection-point LED is steady red.
- The selected point pulses brighter red so it is unambiguous on the physical piece.
- All non-point LEDs are off.
- Clicking a point in the canvas or point list selects the same physical point.
- Dragging a point on the canvas snaps to the nearest LED on that strip.
- Previous/next arrows move the selected point by exactly one source LED and update the physical preview immediately.
- Closing, cancelling, changing strips, leaving Layout, losing ownership, or finishing calibration stops the diagnostic frame stream and restores the prior output source safely.

If the card is unavailable, canvas editing remains functional. The panel reports that physical preview is unavailable and offers the existing reconnect/open-card recovery action. A failed preview must never report that the physical point moved.

## Persistent model

Kaleidoscope is editable Layout metadata on each strip. It is not a wiring cut, output run, section look, or global pattern setting.

```js
strip.kaleidoscope = {
  enabled: true,
  pointCount: 4,
  startLed: 0,
  offsets: [0, 0, 0, 0],
}
```

Rules:

- Missing or disabled metadata means the strip uses ordinary progress.
- `pointCount` is an integer in `[2, pixelCount]`.
- `startLed` is an integer in `[0, pixelCount - 1]`.
- `offsets` has exactly `pointCount` integer entries in `[-(pixelCount - 1), pixelCount - 1]`; the final ordered points must also satisfy the no-crossing and no-collision rules.
- Derived coordinates, angles, final indices, distances, masks, and physical output indices are not persisted in the editable project.
- Duplicating a strip copies its Kaleidoscope mapping.
- Reversing a strip transforms the mapping so the same physical LEDs remain reflection points.
- Moving, scaling, or recoloring a strip does not change its source-local reflection indices.
- Changing LED count reprojects the starting point and final reflection points proportionally into the new source index range, then derives valid offsets around the reprojected automatic set. It must not silently drop the mapping.
- Removing a strip removes its mapping with the strip.

Kaleidoscope edits are pattern/layout calibration only. They must not invalidate, unlock, rewrite, or mark dirty an otherwise verified wiring plan.

## Pattern semantics

### Derived per-pixel values

For every pixel on a Kaleidoscope-enabled strip, the shared renderer derives:

- `reflectionProgress`: normalized `0…1` progress between the two neighboring reflection points;
- `kaleidoscopeProgress`: the folded progress used for mirrored pattern evaluation;
- `reflectionDistance`: normalized distance to the nearest reflection point;
- `reflectionSegment`: zero-based interval index;
- `reflectionPoint`: the nearest reflection-point index when one is unambiguous;
- `isReflectionPoint`: true on a configured reflection LED.

Intervals alternate evaluation direction:

```text
even interval: kaleidoscopeProgress = reflectionProgress
odd interval:  kaleidoscopeProgress = 1 - reflectionProgress
```

This makes neighboring intervals meet as mirrors at every configured point. The renderer uses the same deterministic boundary rule in Studio, workers, baking, and firmware.

### Compatibility with existing patterns

When Kaleidoscope is enabled, compatible strip-progress patterns evaluate against `kaleidoscopeProgress`. Existing patterns that rely on global `x/y`, radius, or angle continue to receive their existing spatial coordinates; Kaleidoscope must not corrupt their coordinate space.

The new reflection values are additionally available to browser-authored patterns and Pattern Lab layers. This allows patterns to flare, pause, change color, or otherwise react as motion reaches a physical reflection point without every pattern searching point arrays.

The renderer must precompute the ordered final point list once per strip/frame context. It must not scan all reflection points for every pixel.

## Studio integration

One normalization helper must provide the same source-local Kaleidoscope context to:

- the Layout light preview;
- the Pattern preview;
- normal Studio live frame rendering;
- Pattern Lab main-thread and worker rendering;
- show playback;
- `.lwseq` baking;
- card-frame streaming.

The physical mapping remains attached to the Layout strip even when a Pattern Lab recipe uses multiple visual layers. Every visual layer targeting that strip receives the same calibrated reflection context.

Stock WLED `ledmap.json`, coordinate-map, CSV, FastLED, Madrix, and xLights geometry exports remain unchanged. They do not gain Lightweaver-specific reflection metadata.

## Standalone card support

Supported Lightweaver firmware must persist and apply the same compact mapping for standalone procedural playback.

- The Studio project keeps source-local values.
- Runtime compilation maps them through reversed runs, wiring seams, split runs, inactive gaps, and outputs without changing their physical identity.
- Firmware stores a compact point count, starting phase, and fine-tune offsets per applicable runtime zone/strip mapping.
- Firmware derives ordered points once when configuration changes or a zone activates, not once per pixel.
- The procedural renderer supplies the same folded progress and reflection proximity semantics used by Studio.
- Browser streaming and `.lwseq` playback remain exact because their RGB frames are already fully rendered.

The runtime contract and card capability response gain an explicit Kaleidoscope-reflection-points feature version. Studio must capability-gate standalone installation. An older card may still receive transient RGB calibration frames, but Studio must not claim that the standalone mapping was installed when the firmware cannot persist or render it.

The compact representation must remain within the card's current configuration budget for the supported 400–453-pixel installation cases. If a valid mapping would exceed the budget, installation fails loudly before writing partial configuration.

## Gentle breathing and slow ambient motion

### Desired behavior

Slow means calm, smooth, and clearly alive—not a multi-minute dark-to-light transition. Breathing must separate cycle length from brightness range.

Default breathing behavior:

- cycle length: 9 seconds;
- lower brightness: 85%;
- upper brightness: 100%;
- smooth continuous sine/eased interpolation;
- no forced blackout at the low point.

### Adjustable range

The existing simple Breathe toggle remains. Its Advanced controls add:

- lower brightness, `0–100%`;
- upper brightness, `0–100%`;
- cycle length, `4–30 seconds`.

The normal collapsed presentation shows a concise summary such as `Breathe · 85–100% · 9s`. The controls enforce lower brightness less than or equal to upper brightness. Equal bounds produce a steady level. The live preview and firmware must use the same values.

Existing looks that only contain `customBreathe: true` migrate to the gentle default. Existing `customBreathe: false` looks remain off. New optional values must be added to section looks, production-job allowlists/schema, runtime payloads, storage, API controls, preview color modifiers, and firmware zone configuration without changing unrelated look semantics.

The built-in Breathe pattern and the global Breathe modifier must no longer use deep `black…full` or approximately `34…100%` defaults. Firmware timing paths for Calm and white presets that currently ignore the look speed must honor speed consistently.

### Ambient verification set

Verify Breathe, Calm, Aurora, Lava, Twinkle, and slow crossfades. Hard-random or intentionally percussive patterns may remain sharp. The pass should confirm that slow settings retain a normal frame cadence rather than becoming slow through dropped frames.

## Migration and validation

- Current projects without `strip.kaleidoscope` load unchanged.
- Missing Kaleidoscope data means disabled. Malformed, fractional, duplicate, crossing, or out-of-range Kaleidoscope data disables that strip's mapping with an actionable project warning; it is never guessed into a different valid mapping.
- Older Breathe booleans receive the approved gentle defaults.
- Current production jobs remain immutable and valid because all new schema fields are optional.
- New job digests naturally include the new fields.
- Import limits and JSON-safety rules remain in force.
- Any project version bump must have explicit forward migration and legacy export behavior.

## Error handling

- Point count below 2 or above the strip LED count is rejected inline.
- A strip with fewer than 2 LEDs cannot enable Kaleidoscope.
- Point collisions and crossing nudges are rejected without modifying saved state.
- If LED count changes make the old fine tuning impossible, Lightweaver preserves the reprojected starting phase, resets only irreconcilable offsets, and explains what was reset.
- Leaving the calibration surface always releases transient frame ownership.
- Card disconnect, congestion, unsupported firmware, storage overflow, or failed read-back must produce an honest failure state and recovery action.
- Installing configuration requires the existing write/read-back evidence; delivery alone is not success.

## Testing and acceptance

### Unit and contract tests

- Generate exact automatic positions for evenly and unevenly divisible counts, including `400/4`, `400/6`, and `400/8`.
- Wrap starting points across LED 0 correctly.
- Shift the complete set when the starting point is nudged.
- Apply independent offsets while preserving cyclic order and rejecting collisions.
- Transform mappings through strip reversal and pixel-count changes.
- Derive folded progress, interval indices, reflection proximity, and exact boundary behavior.
- Preserve mappings through wiring compilation, reversed runs, seams, splits, inactive gaps, and multiple outputs.
- Round-trip project, production job, runtime contract, card storage, and legacy migration data.
- Prove old projects and jobs remain valid when no Kaleidoscope data exists.
- Prove unsupported firmware is capability-gated.
- Verify breathing range validation, old-boolean migration, identical Studio/firmware timing math, and speed-sensitive Calm/white paths.

### Browser tests

- The Layout toolbar uses the approved placement and retains every existing action.
- Kaleidoscope panel collapses to a compact summary.
- Point count accepts arbitrary integers from 2 through the LED count.
- Canvas picking establishes the starting reflection point.
- Start nudges rotate all points; Fine-tune LEDs adjusts one point.
- Dragging and arrow nudging remain correct under zoom and pan.
- Saving/reloading preserves mappings.
- Kaleidoscope edits do not invalidate verified wiring.
- Cancelling or changing screens releases the calibration stream.
- Breathe range and cycle controls persist and preview correctly.

### Physical acceptance

On a 400-pixel frame strip:

1. Configure 4 points, pick the first corner, and confirm automatic quarter spacing.
2. Repeat with 6 and 8 points.
3. Move the starting point and observe all red points rotate together on the physical strip.
4. Fine-tune each point and observe the selected red point move exactly one LED per nudge.
5. Save/install, disconnect Studio, and confirm supported standalone patterns still mirror between the calibrated points.
6. Run Breathe at `85–100% / 9s`; motion must be gentle, obvious, and smooth.
7. Adjust lower/upper range and cycle length and confirm browser/card correspondence.
8. Confirm a representative 400–453-pixel standalone frame maintains the project's existing minimum display-rate acceptance target of at least 28 FPS.

## Out of scope

- Turning reflection points into physical wiring cuts or output zones.
- Adding Lightweaver metadata to stock WLED or third-party geometry export formats.
- Replacing existing global 2D mirror, radial, or geometric Kaleidoscope controls.
- Adding arbitrary per-pattern copies of physical reflection points.
- Multi-minute breathing as a default.

## Completion standard

The feature is complete only when the approved Layout workflow, shared renderer semantics, live physical calibration, persisted standalone firmware behavior, adjustable gentle breathing, migrations, capability gating, automated tests, and 400-pixel physical acceptance are all present. A Studio-only preview or baked-sequence-only implementation is incomplete.
