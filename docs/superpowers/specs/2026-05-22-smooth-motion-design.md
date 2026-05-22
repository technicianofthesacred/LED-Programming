# Lightweaver Smooth Motion Design

## Goal

Lightweaver should support very slow, installation-scale color movement without visible stepping. Artists should be able to run patterns that evolve over minutes, not only short demo loops, and crossfades between patterns should remain smooth in both the browser preview and the real WLED output.

## Problem

The current master speed control slows pattern time directly. At very low speeds, patterns can appear choppy because output still resolves to discrete 8-bit RGB frames, some patterns use hard time steps, and crossfade progress is updated in visible increments. Slowing down the clock alone does not guarantee subtle motion.

## Design

Add a shared smooth-motion layer used by `LEDPreview` before drawing to canvas and before pushing frames to WLED.

The layer has three jobs:

1. Keep the preview and WLED output on a steady frame cadence.
2. Smoothly blend each emitted frame toward the freshly rendered target frame.
3. Use eased crossfade progress so pattern transitions do not feel linear or stepped.

This should be exposed as a global control named **Motion Smoothing** with three modes:

- `Off`: current behavior.
- `Soft`: mild temporal smoothing for normal live use.
- `Silk`: stronger temporal smoothing for very slow ambient fades and gallery installations.

The master speed control should support much slower values than today. The useful range should include values near `0.01x`, so a pattern can drift over minutes. The UI should display small speeds with enough precision, for example `0.03x` instead of rounding to `0.0x`.

Crossfade duration should support longer times than today. The existing `0-10s` live crossfade range should expand to `0-120s`, with finer control at shorter durations. Long crossfades should use an eased curve, not a raw linear ramp.

## Architecture

Create a small frame smoothing helper in the frame generation path. It should accept:

- previous emitted pixels
- current target pixels
- smoothing mode
- elapsed frame time
- optional crossfade state

It returns the emitted pixels used for both canvas drawing and `onFrame`.

The smoothing helper should be independent of React so it can be unit tested. `LEDPreview` owns the previous-frame buffer because it already owns the persistent RAF loop and is the common source for preview drawing and WLED frame pushing.

## Pattern Time

Keep pattern time continuous. Do not lower the render or push frame rate to fake slowness. Instead, allow the artist to set very small `masterSpeed` values while the frame loop continues to render at the normal cadence.

For built-in patterns with short internal cycles, add or adjust pattern params over time so ambient patterns can be stretched. Priority patterns:

- `aurora`
- `breathe`
- `gradient`
- `lava`
- `ocean`
- `ripple`
- `twinkle`
- `stained`

Patterns with intentional hard randomness, such as sparkle, lightning, confetti, and strobe-like effects, may still step by design. Ambient variants for those patterns are out of scope for this first change; they should be tracked as follow-up pattern work.

## Crossfades

Crossfade progress should use a smooth curve such as smootherstep:

```js
t * t * t * (t * (t * 6 - 15) + 10)
```

The transition renderer should still evaluate both patterns during the fade, then blend the resulting colors. The smoothing helper should run after the blend so the final emitted frame is softened consistently.

## Controls

Live screen:

- Expand `Speed` range down to `0.01x`.
- Format speed with two decimals below `0.1x`.
- Expand `Crossfade` range to `0-120s`.
- Add `Motion Smoothing` segmented control: `Off`, `Soft`, `Silk`.

Pattern or global settings screen:

- Persist `motionSmoothing` with the project.
- Use the same smoothing setting for preview and WLED output.

## Data Flow

1. `LEDPreview` computes the target frame through `renderPixelFrame`.
2. The new smoothing helper blends the target frame with the previous emitted frame.
3. The smoothed frame is drawn to the canvas.
4. The same smoothed frame is passed to `onFrame`.
5. `useWled` pushes that same frame to WLED at its configured cadence.

This keeps browser preview and physical LEDs visually aligned.

## Error Handling

If the pixel count changes, reset the smoothing buffer to the new target frame so old frames do not smear across changed layouts.

If smoothing is disabled or there is no previous frame, return the target frame unchanged.

If a pattern returns invalid colors, keep the existing clamping behavior.

## Testing

Add unit coverage for the smoothing helper:

- `Off` returns target pixels exactly.
- `Soft` and `Silk` move toward target pixels without overshooting.
- changed pixel counts reset the buffer.
- easing returns `0`, `1`, and smooth midpoint values.

Add or update UI tests around:

- very low speed values display correctly.
- long crossfade values can be selected.
- smoothing setting persists in project autosave.

Manual verification:

- Run `aurora` at `0.01x` with `Silk`; changes should be subtle but continuous.
- Run a 30-60s crossfade between two contrasting patterns; both preview and WLED output should fade smoothly.
- Confirm hard-random patterns are still allowed to look percussive unless replaced by ambient variants.
