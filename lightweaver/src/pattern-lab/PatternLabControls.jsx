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

const MACROS = [
  ['color', 'Color', 'Warmth and palette travel'],
  ['movement', 'Movement', 'From drifting to animated'],
  ['shape', 'Shape', 'Broad forms to finer structure'],
  ['texture', 'Texture', 'Soft atmosphere to crisp detail'],
  ['energy', 'Energy', 'Quiet glow to luminous presence'],
];

export default function PatternLabControls({
  patterns,
  recipe,
  selectedPatternId,
  onPatternChange,
  onMacroChange,
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
            {MACROS.map(([key, label, hint]) => {
              const value = Math.round((recipe?.macros?.[key] ?? 0.5) * 100);
              return (
                <label className="plab-macro" key={key}>
                  <span className="plab-macro-label"><strong>{label}</strong><output aria-label={`${label} value`}>{value}%</output></span>
                  <input
                    aria-label={label}
                    type="range"
                    min="0"
                    max="100"
                    value={value}
                    disabled={!recipe}
                    onChange={event => onMacroChange(key, Number(event.target.value) / 100)}
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
                <div><dt>Speed</dt><dd>{technical.movement.speedMultiplier.toFixed(2)}×</dd></div>
                <div><dt>Spatial scale</dt><dd>{technical.shape.spatialScale.toFixed(2)}×</dd></div>
                <div><dt>Detail</dt><dd>{technical.texture.detailScale.toFixed(2)}×</dd></div>
                <div><dt>Brightness ceiling</dt><dd>{Math.round(technical.energy.brightness * 100)}%</dd></div>
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
