import { resolvePatternLabMacros } from '../lib/patternLabMacros.js';
import {
  PATTERN_LAB_GENERATOR_CONTROLS,
  PATTERN_LAB_GENERATOR_IDS,
} from '../lib/patternLabGenerators.js';

const GENERATOR_LABELS = {
  particles: 'Particle Drift',
  ripple: 'Living Ripples',
  'random-walkers': 'Wandering Trails',
  'cellular-field': 'Cellular Field',
  'gray-scott-1d': 'Reaction Diffusion',
};

const CONTROLS = [
  ['color', 'macros', 'Color', 'Warmth and palette travel', 0, 100],
  ['brightness', 'playback', 'Brightness', 'Master output within the installation limit', 0, 100],
  ['movement', 'macros', 'Movement', 'Drift 0% · Flow 33% · Pulse 67% · Surge 100%', 0, 100],
  ['speed', 'playback', 'Speed', 'Overall pattern pace', 25, 200],
  ['shape', 'macros', 'Shape', 'Broad forms to finer structure', 0, 100],
  ['texture', 'macros', 'Texture', 'Soft atmosphere to crisp detail', 0, 100],
];

const MOVEMENT_ANCHORS = [
  [0, 'Drift'],
  [33, 'Flow'],
  [67, 'Pulse'],
  [100, 'Surge'],
];

function movementValueText(value) {
  const [, label] = MOVEMENT_ANCHORS.reduce((nearest, anchor) => (
    Math.abs(anchor[0] - value) < Math.abs(nearest[0] - value) ? anchor : nearest
  ));
  return `${label}, ${value}%`;
}

export default function PatternLabControls({
  patterns,
  recipe,
  selectedPatternId,
  onPatternChange,
  onMacroChange,
  onPlaybackChange,
  onPaletteChange,
  onAdvancedChange,
  activeWorkflowStep,
  instrumentResponse,
}) {
  const technical = recipe ? resolvePatternLabMacros(recipe) : null;
  const generatorId = PATTERN_LAB_GENERATOR_IDS.includes(recipe?.base?.kind) ? recipe.base.kind : null;
  const generatorControls = generatorId ? PATTERN_LAB_GENERATOR_CONTROLS[generatorId] : null;

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
          <select
            id="plab-base-pattern"
            aria-label="Base pattern"
            value={selectedPatternId || ''}
            onChange={event => onPatternChange(event.target.value)}
          >
            <option value="">Choose a pattern…</option>
            <optgroup label="Living simulations">
              {PATTERN_LAB_GENERATOR_IDS.map(id => (
                <option key={id} value={`generator:${id}`}>{GENERATOR_LABELS[id]}</option>
              ))}
            </optgroup>
            <optgroup label="Built-in Lightweaver looks">
              {patterns.map(pattern => <option key={pattern.id} value={pattern.id}>{pattern.name}</option>)}
            </optgroup>
          </select>
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
          <div className="plab-macros" aria-disabled={!recipe}>
            {CONTROLS.map(([key, group, label, hint, minimum, maximum]) => {
              const fallback = key === 'brightness' ? 0.575 : key === 'speed' ? 1.125 : 0.5;
              const value = Math.round((recipe?.[group]?.[key] ?? fallback) * 100);
              const valueText = key === 'speed' ? `${(value / 100).toFixed(2)}×` : `${value}%`;
              return (
                <label className="plab-macro" key={key}>
                  <span className="plab-macro-label"><strong>{label}</strong><output aria-label={`${label} value`}>{valueText}</output></span>
                  <input
                    aria-label={label}
                    aria-valuetext={key === 'movement'
                      ? movementValueText(value)
                      : valueText}
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

          {recipe && (
            <div className="plab-palette-control">
              <div className="plab-palette-heading">
                <span><strong>Palette</strong><small>Tap a color to shape the atmosphere</small></span>
                <button
                  type="button"
                  className="btn"
                  aria-label="Rotate palette"
                  onClick={() => onPaletteChange?.([...recipe.palette.slice(1), recipe.palette[0]])}
                >Rotate</button>
              </div>
              <div className="plab-palette-swatches">
                {recipe.palette.map((color, index) => (
                  <label key={`${index}-${color}`}>
                    <input
                      type="color"
                      aria-label={`Palette color ${index + 1}`}
                      value={color}
                      onChange={event => onPaletteChange?.(recipe.palette.map((item, colorIndex) => (
                        colorIndex === index ? event.target.value : item
                      )))}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

          {recipe ? (
            <details className="plab-advanced">
              <summary>Advanced controls</summary>
              <dl>
                <div><dt>Spatial scale</dt><dd>{technical.shape.spatialScale.toFixed(2)}×</dd></div>
                <div><dt>Detail</dt><dd>{technical.texture.detailScale.toFixed(2)}×</dd></div>
              </dl>
              {generatorControls && (
                <div className="plab-generator-advanced">
                  <p>{GENERATOR_LABELS[generatorId]} details</p>
                  {generatorControls.advanced.map(control => {
                    const value = recipe.base?.params?.advanced?.[control.key] ?? control.defaultValue;
                    const integer = Number.isInteger(control.minimum)
                      && Number.isInteger(control.maximum)
                      && Number.isInteger(control.defaultValue);
                    return (
                      <label className="plab-macro" key={control.key}>
                        <span className="plab-macro-label">
                          <strong>{control.label}</strong>
                          <output>{integer ? Math.round(value) : Number(value).toFixed(3)}</output>
                        </span>
                        <input
                          aria-label={control.label}
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
            </details>
          ) : (
            <div className="plab-advanced plab-advanced-disabled">
              <span aria-disabled="true">Advanced controls</span>
              <p>Choose a pattern to inspect its technical values.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
