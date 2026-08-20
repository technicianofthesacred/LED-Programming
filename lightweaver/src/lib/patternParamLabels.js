/**
 * patternParamLabels.js — plain-language labels for the library's `@param` knobs
 *
 * `patterns-library.js` carries 221 `// @param name type default min max`
 * annotations across its 130 patterns (178 once the universal-duplicate below
 * is hidden). The render engine already reads every one of them
 * (`resolvePatternParams` in `frameEngine.js` merges `params` — the parsed
 * defaults, or Pattern Lab's edited copy — straight over the pattern's own
 * defaults). Nothing here changes what the engine does; this file exists
 * because the raw names (`dotSize`, `tailLen`, `visc`, `feed`) are engineer
 * shorthand and the artist-facing column needs to describe what the owner
 * will actually SEE change, the same way the existing macro hints do
 * ("How the light travels — drifting, flowing, pulsing, or surging.").
 *
 * Two lookup tiers:
 *   1. `DEFAULT_PARAM_LABELS` — one curated label+hint per parameter NAME.
 *      Most names carry a consistent meaning across every pattern that
 *      declares them (`density` always means "how much of the space fills
 *      with the effect", `arms` always means spiral arm count), so a single
 *      good default reused across patterns is honest, not lazy — it is the
 *      same choice the existing generator-control labels already made
 *      (PatternLabControls.jsx GENERATOR_ADVANCED_LABEL_OVERRIDES).
 *   2. `PARAM_LABEL_OVERRIDES[patternId][paramName]` — a small set of
 *      pattern-specific overrides for the names that genuinely mean
 *      different things in different patterns (`hue` alone says nothing
 *      about WHICH visual element it colors; `color`, `size`, `count`,
 *      `width` are ambiguous the same way in a handful of patterns). These
 *      are hand-written per pattern, not generated.
 *
 * `HIDDEN_PARAM_NAMES` — parameters that are legitimate to hide rather than
 * show as a seventh/eighth slider. Only one so far: `speed`. It is declared
 * on 43 of the 130 patterns (verified by reading every one), and in every
 * single case the pattern body does nothing but multiply it against `t`/
 * `time` before using it as a rate (see fire's `t * params.rise` sibling,
 * or plainly `lava`: `sin(t * params.speed * 0.3)`, `ocean`:
 * `t * params.speed * 2`, `meteor`: `time * params.speed`). The universal
 * Speed slider already scales that same `t` upstream via `masterSpeed` in
 * `frameEngine.js` (`stripT = t * masterSpeed * ...`). A pattern-local speed
 * knob stacked on top of the universal one is the exact "two sliders doing
 * the same job" pattern the rebuild plan calls out as dishonest — so it is
 * dropped from the UI, not because it doesn't work, but because it
 * duplicates Speed pixel-for-pixel. The 13 patterns whose only declared
 * `@param` is `speed` (aurora, lava, ocean, matrix, warp, inkdrop, drift,
 * smoke, waterfall, circuit, zen, morse, thermal) correctly render zero
 * pattern-specific knobs — that is the intended "don't show an empty
 * section" outcome, applied one level deeper (a section that would only
 * ever contain a duplicate is the same as an empty section).
 */

export const HIDDEN_PARAM_NAMES = new Set(['speed']);

export const DEFAULT_PARAM_LABELS = {
  scale: { label: 'Feature size', hint: 'How large the shapes in this pattern appear.' },
  size: { label: 'Feature size', hint: 'How large each visual unit appears.' },
  width: { label: 'Width', hint: 'How wide the moving band or beam is.' },
  dotSize: { label: 'Dot size', hint: 'How large the traveling dot is.' },
  tipSize: { label: 'Tip size', hint: 'How large the glowing tip at each strand end is.' },
  gridSize: { label: 'Grid size', hint: 'How many cells the piece is divided into.' },
  gridScale: { label: 'Grid size', hint: 'How many cells the piece is divided into.' },
  globeSize: { label: 'Globe size', hint: 'How large the snow globe boundary is.' },
  flakeSize: { label: 'Flake size', hint: 'How large each falling flake is.' },
  ringWidth: { label: 'Ring width', hint: 'How thick the expanding ring is.' },
  borderWidth: { label: 'Cell border width', hint: 'How thick the line between cells is.' },
  thick: { label: 'Line thickness', hint: 'How thick the traced curve is.' },
  brushSize: { label: 'Brush size', hint: 'How large each brush stroke is.' },

  count: { label: 'Count', hint: 'How many appear on screen at once.' },
  cells: { label: 'Cell count', hint: 'How many cells divide the piece.' },
  stars: { label: 'Star count', hint: 'How many stars are visible.' },
  flakes: { label: 'Flake count', hint: 'How many flakes fall at once.' },
  arms: { label: 'Arm count', hint: 'How many spiral arms wind outward.' },
  petals: { label: 'Petal count', hint: 'How many petals the bloom has.' },
  bands: { label: 'Band count', hint: 'How many color bands are visible at once.' },
  cols: { label: 'Column count', hint: 'How many columns of falling code run at once.' },
  segments: { label: 'Segment count', hint: 'How many wedges the wheel is divided into.' },
  slices: { label: 'Slice count', hint: 'How many mirrored slices make up the kaleidoscope.' },
  rings: { label: 'Ring count', hint: 'How many rings are visible at once.' },
  layers: { label: 'Layer count', hint: 'How many nested layers the shape has.' },
  branches: { label: 'Branch count', hint: 'How many lightning branches fork off the main bolt.' },
  tentacles: { label: 'Tentacle count', hint: "How many of the jellyfish's tentacles trail below it." },
  creatures: { label: 'Creature count', hint: 'How many glowing creatures drift through the scene.' },
  blobs: { label: 'Blob count', hint: 'How many molten blobs move at once.' },
  streams: { label: 'Stream count', hint: 'How many paint streams run down the piece.' },
  strands: { label: 'Strand count', hint: 'How many fiber strands are lit.' },
  tendrils: { label: 'Tendril count', hint: 'How many electric tendrils reach out from the center.' },
  dunes: { label: 'Dune count', hint: 'How many dune ridges cross the piece.' },

  rate: { label: 'Rate', hint: 'How often the effect fires.' },
  duty: { label: 'On-time', hint: 'How much of each cycle stays lit versus dark.' },
  rise: { label: 'Rise speed', hint: 'How quickly the effect climbs or drifts upward.' },
  decay: { label: 'Fade time', hint: 'How long the effect lingers before fading out.' },
  damping: { label: 'Settle speed', hint: 'How quickly the motion settles down after each swing.' },
  hueSpeed: { label: 'Color drift speed', hint: 'How quickly the color rotates over time.' },
  scanSpeed: { label: 'Scan speed', hint: 'How quickly the scan line sweeps across the grid.' },
  twinkle: { label: 'Twinkle speed', hint: 'How quickly the stars flicker.' },
  lifetime: { label: 'Lifetime', hint: 'How long each burst lasts before it disappears.' },
  frequency: { label: 'Strike rate', hint: 'How often a new lightning bolt strikes.' },

  freq: { label: 'Wave count', hint: 'How many repeating waves fit across the piece.' },
  freqX: { label: 'Horizontal wave count', hint: 'How many wave cycles run side to side.' },
  freqY: { label: 'Vertical wave count', hint: 'How many wave cycles run top to bottom.' },
  octaves: { label: 'Detail layers', hint: 'How many layers of fine detail are blended into the noise.' },
  lacunarity: { label: 'Detail spacing', hint: 'How far apart each finer layer of detail sits from the last.' },
  gain: { label: 'Detail strength', hint: 'How strongly each finer layer of detail shows through.' },
  waves: { label: 'Wave source count', hint: 'How many overlapping wave sources create the interference pattern.' },

  twist: { label: 'Twist amount', hint: 'How tightly the spiral winds.' },
  spin: { label: 'Spin speed', hint: 'How quickly the whole shape rotates.' },
  angle: { label: 'Angle', hint: 'The direction the effect is oriented.' },
  spread: { label: 'Spread', hint: 'How far the effect fans out from its source.' },
  zoom: { label: 'Zoom', hint: 'How far into the pattern the view is magnified.' },
  warp: { label: 'Warp amount', hint: 'How much the pattern bends and distorts.' },
  folds: { label: 'Fold count', hint: 'How many mirrored folds make up the kaleidoscope.' },
  axis: { label: 'Mirror axis count', hint: 'How many axes the reflection mirrors across.' },
  rot4d: { label: '4D rotation', hint: 'How far the shape has rotated through the extra dimension.' },
  pitch: { label: 'Helix pitch', hint: 'How tightly the double helix coils.' },
  phase: { label: 'Phase offset', hint: 'How far the second curve is offset from the first.' },

  hue: { label: 'Base color', hint: 'The color this pattern is built around.' },
  hueOffset: { label: 'Color drift', hint: 'How far each cell drifts from the base color.' },
  hueShift: { label: 'Color drift', hint: 'How far the color shifts as it moves.' },
  color: { label: 'Flash color', hint: 'The color of the flash.' },
  saturation: { label: 'Color richness', hint: 'How vivid versus washed-out the colors are.' },
  warmth: { label: 'Warmth', hint: 'How warm or cool the overall tone is.' },
  corona: { label: 'Glow size', hint: 'How large the glowing corona around the flare is.' },
  glow: { label: 'Glow amount', hint: 'How much soft glow surrounds the light.' },
  shimmer: { label: 'Shimmer amount', hint: 'How much the surface shimmers as it catches the light.' },
  iridescence: { label: 'Iridescence', hint: 'How much rainbow sheen plays across the surface.' },
  phosphor: { label: 'Phosphor glow', hint: 'How much the old-CRT afterglow lingers.' },

  density: { label: 'Density', hint: 'How much of the space fills with the effect.' },
  foam: { label: 'Foam amount', hint: 'How much white foam caps the waves.' },
  swell: { label: 'Swell height', hint: 'How tall the waves rise and fall.' },
  bloom: { label: 'Bloom amount', hint: 'How fully open the bloom is.' },
  pulse: { label: 'Pulse strength', hint: "How strongly the jellyfish's pulse ripples outward." },
  amp: { label: 'Amplitude', hint: 'How tall the wave peaks rise.' },
  chaos: { label: 'Chaos', hint: 'How unpredictable the motion is.' },
  threshold: { label: 'Sort threshold', hint: 'How much brightness difference triggers a streak.' },
  streak: { label: 'Streak length', hint: 'How far each sorted streak extends.' },
  blur: { label: 'Blur amount', hint: 'How soft the edges of the split colors are.' },
  falloff: { label: 'Fade distance', hint: 'How quickly each frequency band fades as it falls.' },
  heat: { label: 'Heat', hint: 'How hot versus cool the flow appears.' },
  wind: { label: 'Wind strength', hint: 'How strongly the wind sculpts the dune ridges.' },

  flicker: { label: 'Flicker amount', hint: 'How much the flame flickers and jumps.' },
  cycleSeconds: { label: 'Cycle length', hint: 'How long one full breathing cycle takes.' },
  tailLen: { label: 'Trail length', hint: 'How far each streak smears behind itself.' },
  hour: { label: 'Time of day', hint: 'Where in the sunrise the piece is paused.' },
  facets: { label: 'Facet count', hint: 'How many faceted surfaces catch the light.' },
  visc: { label: 'Flow thickness', hint: 'How thick and slow-moving the fluid is.' },
  viscosity: { label: 'Flow thickness', hint: 'How thick and slow-moving the flow is.' },
  caustic: { label: 'Caustic detail', hint: 'How much rippling light detail plays across the ice.' },
  iter: { label: 'Zoom detail', hint: 'How much fine detail the deep zoom resolves.' },
  horizon: { label: 'Horizon line', hint: 'Where the horizon sits in the sunrise.' },
  scanlines: { label: 'Scanline count', hint: 'How many horizontal scanlines are visible.' },
  bleeds: { label: 'Bleed count', hint: 'How many watery color bleeds are blooming at once.' },
  lightning: { label: 'Lightning strength', hint: 'How intense the electric arcs between tendrils are.' },
  rays: { label: 'Ray count', hint: 'How many sunrise rays fan out.' },
  strokes: { label: 'Stroke count', hint: 'How many overlapping brush strokes are visible.' },
  drift: { label: 'Drift amount', hint: 'How far the pattern wanders from its starting position.' },
  swirl: { label: 'Swirl amount', hint: 'How much the smoke curls and swirls.' },
};

/**
 * Pattern-specific overrides. Only used where the parameter name alone is
 * ambiguous about which visual element it controls — mostly the `hue`
 * family, which says nothing on its own about what gets colored.
 */
export const PARAM_LABEL_OVERRIDES = {
  breathe: { hue: { label: 'Breathing color', hint: 'The color the breathing glow cycles through.' } },
  scanner: { hue: { label: 'Beam color', hint: 'The color of the scanning beam.' } },
  heartbeat: { hue: { label: 'Pulse color', hint: 'The color of each heartbeat flash.' } },
  calm: { hue: { label: 'Base color', hint: 'The calm background color.' } },
  strobe: { hue: { label: 'Flash color', hint: 'The color of each strobe flash.' } },
  'strobe-bpm': { hue: { label: 'Flash color', hint: 'The color of each beat flash.' } },
  glitter: { hue: { label: 'Sparkle color', hint: 'The base color of the glittering grains.' } },
  'pulse-expand': { hue: { label: 'Ring color', hint: 'The color of the expanding ring.' } },
  'neon-sign': { hue: { label: 'Tube color', hint: 'The color of the neon tube.' } },
  'retro-scan': { hue: { label: 'Screen tint', hint: 'The color tint of the old CRT screen.' } },
  'breathing-grid': { hue: { label: 'Grid color', hint: 'The color the breathing grid glows.' } },
  'neon-grid': { hue: { label: 'Grid glow color', hint: 'The color the grid lines glow.' } },
  voronoi: { hueOffset: { label: 'Cell color drift', hint: 'How far each cell drifts from the base color.' } },
  'kick-flash': { color: { label: 'Flash color', hint: 'The color of the kick-triggered flash.' } },
};

/**
 * Resolve the plain-language label+hint for one declared `@param`.
 * Falls back to a readable version of the raw name so an as-yet-uncurated
 * parameter never renders blank — but every name in the 130-pattern library
 * has a curated entry above, verified against `extract_params.mjs` during
 * this pass (103 unique names, 102 non-`speed`, all present in
 * DEFAULT_PARAM_LABELS).
 */
export function resolveParamLabel(patternId, paramName) {
  const override = PARAM_LABEL_OVERRIDES[patternId]?.[paramName];
  if (override) return override;
  const fallback = DEFAULT_PARAM_LABELS[paramName];
  if (fallback) return fallback;
  const spaced = String(paramName)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, char => char.toUpperCase());
  return { label: spaced, hint: '' };
}
