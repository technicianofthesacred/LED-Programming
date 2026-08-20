import {
  PATTERN_LAB_GENERATOR_CONTROLS,
  PATTERN_LAB_GENERATOR_IDS,
} from '../lib/patternLabGenerators.js';
import PatternKnobPanel from './PatternKnobPanel.jsx';
import PatternTileBrowser from './PatternTileBrowser.jsx';

const GENERATOR_LABELS = {
  particles: 'Particle Drift',
  ripple: 'Living Ripples',
  'random-walkers': 'Wandering Trails',
  'cellular-field': 'Cellular Field',
  'gray-scott-1d': 'Reaction Diffusion',
};

// Only controls that are wired end-to-end appear at all, and only where they
// are wired. Two of the sliders below are context-dependent because their
// underlying macro only reaches one half of the pattern library:
//   - macros.movement drives applyPatternLabMotionToStrips, which only the
//     130 built-in library patterns render through — shown for those only.
//   - macros.shape / macros.texture become artistic.scale / artistic.density
//     inside resolvePatternLabGeneratorInputs, consumed only by the 5
//     procedural generators — shown for those only.
// Color (warmth + saturation) and Brightness/Speed are genuinely universal:
// frameEngine.js applies masterHueShift/masterSaturation as a post-process
// over every pixel regardless of pattern kind. See
// todo/plans/patternlab-rebuild.md §4 and the Pattern Lab findings this pass
// resolved.
const UNIVERSAL_CONTROLS = [
  ['color', 'macros', 'Color', 'Warmth and how far the color travels', 0, 100],
  ['brightness', 'playback', 'Brightness', 'Master output within the installation limit', 0, 100],
  ['speed', 'playback', 'Speed', 'Overall pattern pace', 25, 200],
];
const MOVEMENT_CONTROL = [
  'movement', 'macros', 'Movement',
  'How the light travels — drifting, flowing, pulsing, or surging. Built-in patterns only.',
  0, 100,
];
const GENERATOR_ONLY_CONTROLS = [
  ['shape', 'macros', 'Shape', 'Size of the simulated forms in this live simulation.', 0, 100],
  ['texture', 'macros', 'Texture', 'How dense or sparse the simulated detail is.', 0, 100],
];

function controlsForContext(generatorId) {
  const [color, brightness, speed] = UNIVERSAL_CONTROLS;
  return generatorId
    ? [color, ...GENERATOR_ONLY_CONTROLS, brightness, speed]
    : [color, MOVEMENT_CONTROL, brightness, speed];
}

// The card derives the piece's actual on-wall color from the middle swatch
// of recipe.palette (see lookFromRecipe in patternLabHandoff.js) — that path
// is unconditional, unlike the old 6-swatch editor which only 2 of 130
// library patterns (gradient, blocks) ever read for their own preview
// pixels. So the primary control is a single honest hue: it always sets
// what the piece plays. The full palette is only shown, read-only, for the
// two patterns that actually draw every swatch on screen — showing it for
// everything else would restore the same lie the editor told.
const PALETTE_VISIBLE_PATTERNS = new Set(['gradient', 'blocks']);

// Plain-language names for the five procedural generators' own sliders.
// These are real controls — they read straight into the simulation — so the
// jargon ("Feed", "Kill", "Diffusion U/V", "Cell rule") is what had to go,
// not the sliders themselves.
const GENERATOR_ADVANCED_LABEL_OVERRIDES = {
  'cellular-field': {
    rule: 'Pattern style',
  },
  'gray-scott-1d': {
    feed: 'Growth',
    kill: 'Fade',
    diffusionU: 'Broad flow',
    diffusionV: 'Fine detail',
  },
};

function generatorControlLabel(generatorId, control) {
  return GENERATOR_ADVANCED_LABEL_OVERRIDES[generatorId]?.[control.key] || control.label;
}

export default function PatternLabControls({
  patterns,
  recipe,
  selectedPatternId,
  onPatternChange,
  onMacroChange,
  onPlaybackChange,
  onAdvancedChange,
  onParamChange,
  onPieceColorChange,
  pieceColorHue,
  activeWorkflowStep,
  instrumentResponse,
}) {
  const generatorId = PATTERN_LAB_GENERATOR_IDS.includes(recipe?.base?.kind) ? recipe.base.kind : null;
  const selectedPatternSource = !generatorId && recipe?.base?.patternId
    ? patterns.find(pattern => pattern.id === recipe.base.patternId)
    : null;
  const generatorControls = generatorId ? PATTERN_LAB_GENERATOR_CONTROLS[generatorId] : null;
  const activeControls = controlsForContext(generatorId);
  const palette = Array.isArray(recipe?.palette) ? recipe.palette : [];
  const hue = Math.round(Number.isFinite(pieceColorHue) ? pieceColorHue : 30);
  const showFullPalette = !generatorId && PALETTE_VISIBLE_PATTERNS.has(selectedPatternId);

  return (
    <div className="plab-control-body">
      <section
        className="plab-control-section plab-compact-step plab-source-control"
        aria-labelledby="plab-source-heading"
        data-testid="pattern-lab-step-choose"
        data-workflow-step="0"
        data-active={activeWorkflowStep === 0 ? 'true' : 'false'}
      >
        <div className="plab-compact-step-heading">
          {instrumentResponse.step === 0 && instrumentResponse.sequence > 0 && (
            <span
              key={instrumentResponse.sequence}
              className="plab-local-ack"
              data-testid="pattern-lab-step-ack"
              data-response-sequence={instrumentResponse.sequence}
              aria-hidden="true"
            />
          )}
          <span className="plab-section-index">01</span>
          <h2 id="plab-source-heading">Choose</h2>
        </div>
        <div className="plab-compact-step-body plab-source-field">
          <PatternTileBrowser
            patterns={patterns}
            selectedPatternId={selectedPatternId}
            onSelect={onPatternChange}
          />
        </div>
      </section>

      <section
        className="plab-control-section plab-compact-step plab-sculpt-control"
        aria-labelledby="plab-sculpt-heading"
        data-testid="pattern-lab-step-sculpt"
        data-workflow-step="1"
        data-active={activeWorkflowStep === 1 ? 'true' : 'false'}
      >
        <div className="plab-compact-step-heading">
          {instrumentResponse.step === 1 && instrumentResponse.sequence > 0 && (
            <span
              key={instrumentResponse.sequence}
              className="plab-local-ack"
              data-testid="pattern-lab-step-ack"
              data-response-sequence={instrumentResponse.sequence}
              aria-hidden="true"
            />
          )}
          <span className="plab-section-index">02</span>
          <h2 id="plab-sculpt-heading" tabIndex="-1">Sculpt</h2>
        </div>
        <div className="plab-compact-step-body">
          <div className="plab-piece-color">
            <label className="plab-macro plab-piece-color-control">
              <span className="plab-macro-label">
                <strong>Piece color</strong>
                <output aria-label="Piece color value">{hue}°</output>
              </span>
              <input
                aria-label="Piece color"
                aria-valuetext={`${hue} degrees`}
                type="range"
                min={0}
                max={359}
                value={hue}
                disabled={!recipe}
                style={{ '--plab-hue-thumb': `hsl(${hue}, 70%, 55%)` }}
                onChange={event => onPieceColorChange?.(Number(event.target.value))}
              />
              <small>The exact color your physical piece plays, always — not just a preview tint.</small>
            </label>
            {showFullPalette && (
              <div className="plab-piece-palette">
                <p>This pattern shows every one of these colors on screen:</p>
                <div className="plab-piece-palette-swatches" aria-label="Every color this pattern draws">
                  {palette.map((hex, index) => (
                    <span key={`${hex}-${index}`} className="plab-piece-palette-swatch" style={{ background: hex }} />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="plab-macros" aria-disabled={!recipe}>
            {activeControls.map(([key, group, label, hint, minimum, maximum]) => {
              const fallback = key === 'brightness' ? 0.575 : key === 'speed' ? 1.125 : 0.5;
              const value = Math.round((recipe?.[group]?.[key] ?? fallback) * 100);
              const valueText = key === 'speed' ? `${(value / 100).toFixed(2)}×` : `${value}%`;
              return (
                <label className="plab-macro" key={key}>
                  <span className="plab-macro-label"><strong>{label}</strong><output aria-label={`${label} value`}>{valueText}</output></span>
                  <input
                    aria-label={label}
                    aria-valuetext={valueText}
                    type="range"
                    min={minimum}
                    max={maximum}
                    value={value}
                    disabled={!recipe}
                    onChange={event => {
                      const nextValue = Number(event.target.value) / 100;
                      if (group === 'playback') onPlaybackChange?.(key, nextValue);
                      else onMacroChange(key, nextValue);
                    }}
                  />
                  <small>{hint}</small>
                </label>
              );
            })}
          </div>

          {recipe && generatorControls && (
            <div className="plab-generator-controls">
              <p className="plab-generator-controls-heading">{GENERATOR_LABELS[generatorId]} controls</p>
              {generatorControls.advanced.map(control => {
                const value = recipe.base?.params?.advanced?.[control.key] ?? control.defaultValue;
                const integer = Number.isInteger(control.minimum)
                  && Number.isInteger(control.maximum)
                  && Number.isInteger(control.defaultValue);
                const label = generatorControlLabel(generatorId, control);
                return (
                  <label className="plab-macro" key={control.key}>
                    <span className="plab-macro-label">
                      <strong>{label}</strong>
                      <output>{integer ? Math.round(value) : Number(value).toFixed(3)}</output>
                    </span>
                    <input
                      aria-label={label}
                      type="range"
                      min={control.minimum}
                      max={control.maximum}
                      step={integer ? 1 : (control.maximum - control.minimum) / 100}
                      value={value}
                      onChange={event => onAdvancedChange?.(control.key, Number(event.target.value))}
                    />
                  </label>
                );
              })}
            </div>
          )}

          {recipe && selectedPatternSource && (
            <PatternKnobPanel
              patternId={selectedPatternSource.id}
              code={selectedPatternSource.code}
              params={recipe.base?.params}
              onParamChange={onParamChange}
            />
          )}
        </div>
      </section>
    </div>
  );
}
