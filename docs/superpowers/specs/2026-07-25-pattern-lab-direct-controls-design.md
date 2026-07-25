# Pattern Lab Direct Controls Design

**Date:** 2026-07-25

**Status:** Approved for implementation planning

**Scope:** Pattern Lab only

## Purpose

Make Pattern Lab's everyday controls behave the way their names imply:

- Brightness directly changes the total Pattern Lab output.
- Speed directly changes how quickly the pattern advances.
- Movement changes the way the pattern moves, not its speed.

The result remains an easy authoring surface for long, non-obviously-repeating patterns. This change does not reorganize or replace the existing Patterns, Layout, Show, Playlist, or card-control sections.

## Current problem and root cause

The current five-control model combines unrelated responsibilities:

- **Energy** resolves one slider into brightness (`0.15–1.0`), dynamic range (`0.1–1.0`), and rare-event strength (`0–0.8`).
- **Movement** resolves one slider into speed (`0.25–2.0×`), drift-to-pulse character (`0–1`), and modulation depth (`0.05–0.75`).

Long Evolution then calculates brightness destinations with `Math.min(currentEnergyBrightness, destinationBrightness)`. Energy therefore acts as an upper ceiling that evolution may dim beneath, rather than an obvious master-output control. Raising it can produce a muted or inconsistent visual response depending on the sampled evolution point. Equivalent control resolution is repeated across interactive preview, screen-level preview state, and sequence baking, which creates a parity risk.

Movement has the complementary problem: changing how motion feels also changes how fast time advances. The user cannot independently choose a drifting, flowing, pulsing, or surging motion and then set its pace.

## Approved control model

The main **Sculpt the look** surface has six always-visible controls in this order:

1. **Color** — palette travel, warmth, saturation, and color relationships.
2. **Brightness** — direct master output from `0–100%`.
3. **Movement** — motion character across four continuous semantic anchors: Drift, Flow, Pulse, and Surge.
4. **Speed** — direct master time multiplier from `0.25–2.0×`.
5. **Shape** — spatial scale, radial emphasis, symmetry, and focus.
6. **Texture** — detail, crispness, density, and trail character.

Energy is removed from the main UI. Its former dynamic-range and rare-event responsibilities become internal Long Evolution settings; they are not added as replacement primary controls.

Brightness and Speed must not be hidden behind Advanced. Advanced may display their resolved values, but it must not introduce a second source of truth for either control.

### Control presentation

- Color, Brightness, Speed, Shape, and Texture remain continuous sliders.
- Movement is a continuous slider with four labeled anchors:
  - `0%`: Drift
  - `33%`: Flow
  - `67%`: Pulse
  - `100%`: Surge
- Values between anchors interpolate smoothly so the interface remains simple and the output does not jump between presets.
- Brightness displays a percentage.
- Speed displays a multiplier.
- Movement displays its nearest character plus its continuous position when focused or announced, for example, “Flow, 42%.”
- Changing any main control updates the preview immediately. Reduced-quality interaction rendering may remain in place, followed by a full-quality frame after release.

At `100%`, Brightness means the maximum allowed by the installation's configured hardware/current safety limit. It does not bypass the controller's electrical brightness cap, calibration, gamma, or power limiting.

## Behavioral contracts

### Brightness

Brightness is a direct master output gain:

```text
final RGB = rendered RGB × evolution brightness factor × master brightness
```

- `master brightness` is the user's Brightness value in `0–1`.
- `evolution brightness factor` creates quiet and bright passages within the selected master output and never exceeds `1`.
- Long Evolution does not interpolate the master value toward a destination and does not use `Math.min(masterBrightness, destinationBrightness)`.
- Raising Brightness at a fixed recipe, seed, and preview time produces monotonically greater or equal RGB output for every non-black channel.
- Brightness is applied exactly once in every rendering and delivery path.
- A Brightness value of `0%` is valid and produces black output without stopping the pattern clock. Raising it restores the current evolving frame.

### Speed

Speed is a direct master time multiplier:

```text
effective time rate = base time rate × master speed × evolution rate factor
```

- `master speed` is the user's Speed value from `0.25–2.0×`.
- Long Evolution may make bounded, gradual pace variations through `evolution rate factor`; the Speed slider remains the obvious overall multiplier.
- The final effective rate remains inside the engine's existing safe `0.1–3.0×` range.
- Changing Speed does not alter motion-character weights, spatial parameters, brightness, or palette.
- The same multiplier is used by playback, scrubbing, worker rendering, baking, and project handoff.

### Movement

Movement chooses how values travel through the sculpture. It never changes the master time multiplier.

- **Drift:** smooth, continuous wandering or translation.
- **Flow:** directional traveling motion across paths, sections, or fields.
- **Pulse:** cyclical expansion, contraction, or breathing emphasis.
- **Surge:** bounded directional or intensity waves with short-lived emphasis.

The resolver converts the continuous Movement value into interpolated character weights. Pattern adapters map those weights to the capabilities of each generator. A generator may use different internal techniques, but changing Movement with Speed fixed must leave the effective time rate unchanged.

Long Evolution may move gently around the chosen Movement character or introduce rare bounded events. It must not replace the user's chosen character with an unrelated mode or create an obvious short loop.

## Shared control resolution and data flow

One pure control resolver is the source of truth for all Pattern Lab paths. Given a normalized recipe and an evolution time, it returns:

- creative macro values;
- motion-character weights;
- master brightness;
- master speed;
- bounded evolution brightness and rate factors;
- the final effective render values.

The preview, worker protocol, `.lwseq` baker, project handoff, recipe export, and physical preview consume this shared result rather than reimplementing interpolation.

The rendering contract is:

1. Normalize or migrate the recipe.
2. Sample deterministic Long Evolution at the requested time.
3. Resolve Color, Movement, Shape, and Texture.
4. Resolve effective time from Speed and the bounded evolution rate factor.
5. Render the generator or composed layers.
6. Apply the evolution brightness factor and master Brightness once at final frame output.
7. Apply the existing output gamma, calibration, power, and hardware-safety pipeline.

The worker is authoritative for both stateful and built-in browser previews. While a new validated worker frame is unavailable, the UI displays a non-blocking “Preparing accurate preview…” state rather than a differently resolved main-thread approximation. Worker frames explicitly declare that Pattern Lab controls were applied, and the display path passes `1` for speed and brightness rather than scaling twice.

## Long Evolution behavior

Long Evolution remains the easy mechanism for five-to-fifteen-minute patterns. It continues to combine deterministic clocks, seeded micro-variation, palette travel, spatial emphasis, motion changes, and rare events without requiring a timeline.

The separation of direct controls changes its responsibilities:

- Brightness supplies the master output.
- Speed supplies the master pace.
- Evolution brightness creates quieter and brighter passages only within the master output.
- Evolution rate creates bounded relative pace changes around the master speed.
- Movement supplies the motion-character anchor.
- Evolution may make slow, bounded variations around that anchor.
- Dynamic range and rare-event strength are derived from the selected evolution character and Change amount, including migrated internal values where present.

Beginning, middle, and end previews must remain meaningfully different. The evolution clocks must not acquire a shared short reset as a result of the new control resolution.

## Recipe schema and version migration

This change introduces Pattern Lab recipe schema version 2. The normalized v2 shape separates creative macros from direct playback controls:

```json
{
  "version": 2,
  "macros": {
    "color": 0.5,
    "movement": 0.5,
    "shape": 0.5,
    "texture": 0.5
  },
  "playback": {
    "brightness": 0.575,
    "speed": 1.125
  },
  "evolution": {
    "enabled": true,
    "character": "slow-bloom",
    "durationSeconds": 600,
    "change": 0.35,
    "dynamics": {
      "dynamicRange": 0.55,
      "rareEventStrength": 0.4
    }
  }
}
```

Bounds are:

- Creative macros: `0–1`.
- Playback brightness: `0–1`.
- Playback speed: `0.25–2.0`.
- Evolution dynamic range: `0.1–1.0`.
- Evolution rare-event strength: `0–0.8`.

### Version 1 migration

Version 1 recipes load through a deterministic, non-mutating migration:

- Preserve Color, Shape, and Texture unchanged.
- Preserve the old normalized Movement value as the new motion-character value.
- Set `playback.speed = 0.25 + (oldMovement × 1.75)`.
- Set `playback.brightness = 0.15 + (oldEnergy × 0.85)`.
- Set `evolution.dynamics.dynamicRange = 0.1 + (oldEnergy × 0.9)`.
- Set `evolution.dynamics.rareEventStrength = oldEnergy × 0.8`.
- Preserve all other safe, recognized recipe fields, including base generator, parameters, palette, seed, layers, targets, requirements, and provenance.
- Remove the obsolete `macros.energy` field from the active normalized v2 control block after its values have been mapped. Safe unknown extension fields outside known control blocks remain preserved.

The v1 source object and saved draft are not modified merely by opening them. Saving or exporting the migrated recipe writes version 2. Re-normalizing a migrated v2 recipe is idempotent. Unsupported future major versions remain blocked with a specific error rather than being guessed at.

The migrated defaults intentionally reproduce the current v1 midpoint: Brightness `57.5%`, Speed `1.125×`, and Movement `50%`. Existing recipes therefore open near their prior appearance while gaining independent controls.

## Export, handoff, and live behavior

All outputs use the same normalized v2 values:

- **Browser preview:** displays the worker-authoritative frame with final resolved brightness applied once; it shows a preparation state until that frame is available.
- **Worker preview:** produces the same frame within documented sampling tolerances and cannot double-apply brightness or speed.
- **Physical Preview on Lights:** sends frames with Pattern Lab brightness applied once; the active local look must not add another brightness multiplier. Existing external-output safety and card master limits still apply.
- **Procedural project handoff:** reads `playback.brightness` and `playback.speed` from the recipe and writes them to the saved look's existing brightness and speed fields.
- **Recipe export/import:** round-trips v2 direct controls and migrated evolution dynamics without loss.
- **Baked `.lwseq`:** bakes Pattern Lab brightness and timing into frame bytes exactly once. Its generated sequence look must not repeat the recipe brightness multiplier. The sidecar records the normalized recipe and effective bake settings for reproducibility.
- **Standalone playback:** reproduces the baked or procedural result without inheriting stale Pattern Lab, active-look, or external-live brightness state.

The card's global user brightness, current limit, calibration, and power protection remain later output stages. They are installation controls, not duplicate Pattern Lab recipe controls.

## Mobile, touch, and accessibility

- The six controls use a single-column order in the mobile lower drawer and remain reachable without opening Advanced.
- Interactive targets are at least `44 × 44` CSS pixels.
- Slider tracks provide sufficient touch height even when their visual line is thinner.
- Labels, values, hints, and Movement anchor names do not rely on color or hover.
- Every range input has a programmatic label, current value, valid bounds, and keyboard support.
- Movement exposes semantic `aria-valuetext`; Brightness announces a percentage; Speed announces a multiplier.
- Focus indicators remain visible in the desktop inspector and mobile drawer.
- Live value text does not announce every intermediate drag event as an urgent alert.
- The mobile drawer respects safe-area insets, keeps the active slider above the browser chrome and on-screen keyboard, and does not cover the Stop action during physical preview.
- Reduced-motion preferences affect interface animation only, not the authored LED pattern.

## Failure handling

- Invalid direct-control values normalize to documented defaults or bounds before rendering.
- A failed migration, resolver, worker render, bake, or handoff preserves the last valid preview and draft.
- Import errors identify the unsupported version or invalid field path and do not mutate storage.
- If the worker frame contract is invalid, browser preview, physical preview, and export are blocked rather than displaying or sending an uncertain frame.
- A physical-preview failure follows the existing output-ownership rollback and restores the prior card state when acknowledgement permits.

## Non-goals

- Do not add a node graph, timeline, or keyframe editor.
- Do not add separate advanced Brightness or Speed controls.
- Do not expose dynamic range and rare-event strength as new main controls in this change.
- Do not change the installation's electrical brightness limits or power model.
- Do not refactor unrelated Studio sections.
- Do not add a Raspberry Pi runtime path.

## Tests and acceptance criteria

### Unit and contract tests

- Version 2 normalization accepts the documented bounds and preserves safe unknown fields.
- Every v1 control endpoint and midpoint migrates to the exact formulas above.
- Migration is non-mutating and v2 normalization is idempotent.
- Movement changes motion-character weights without changing master or effective base speed.
- Speed changes the time multiplier without changing motion-character weights.
- Brightness is monotonic for a fixed non-black frame at `0%`, `25%`, `50%`, `75%`, and `100%`.
- Evolution brightness remains within `0–1` and never overwrites or interpolates the master Brightness value.
- Shared control resolution returns identical values to preview, worker, bake, handoff, and export callers.

### Render and integration tests

- Fixed recipe, geometry, seed, time, and input fixtures produce the expected worker-authoritative browser frame.
- Brightness is applied once, not zero times or twice, in built-in and stateful worker previews, physical preview pixels, and baked frame bytes.
- Fixed Speed produces the same phase at the same effective time in preview and `.lwseq` baking.
- Project handoff receives the exact direct Brightness and Speed values.
- Recipe export/import and v1-to-v2 export round-trip without losing controls or evolution dynamics.
- Existing Pattern Lab drafts reopen successfully; existing non-Pattern-Lab project state is unchanged.
- The main interface contains Color, Brightness, Movement, Speed, Shape, and Texture in the approved order and contains no Energy control.
- A complete fifteen-minute deterministic evolution has meaningful beginning, middle, and end differences and no newly introduced shared short-loop reset.

### Browser and hardware gates

- Desktop and phone layouts keep all six controls usable without horizontal scrolling or opening Advanced.
- Keyboard-only and screen-reader checks confirm labels, semantic Movement values, focus order, and current values.
- Touch testing confirms reliable slider adjustment without accidental drawer dismissal or page scrolling.
- On a known non-black hardware fixture, raising Pattern Lab Brightness at a fixed time produces a visibly and measurably brighter output up to the configured installation cap.
- Drift, Flow, Pulse, and Surge are visibly distinct at the same Speed.
- The same recipe has the same pace and brightness behavior in browser preview, Preview on Lights, procedural handoff, and baked standalone playback, subject only to documented display-versus-LED calibration.
- `npm run launch:check` passes before deployment, followed by the relevant hardware smoke tests in `docs/deployment-checklist.md`.

## Success definition

A first-time user can create a long evolving pattern with six understandable controls. Brightness always behaves like brightness, Speed always behaves like pace, and Movement visibly changes the style of motion without secretly changing speed. Existing v1 drafts still open, all output paths agree, and no current Studio section is disrupted.
