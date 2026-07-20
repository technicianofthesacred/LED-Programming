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
}) {
  const technical = recipe ? resolvePatternLabMacros(recipe) : null;
  const generatorId = PATTERN_LAB_GENERATOR_IDS.includes(recipe?.base?.kind) ? recipe.base.kind : null;
  const generatorControls = generatorId ? PATTERN_LAB_GENERATOR_CONTROLS[generatorId] : null;

  return (
    <div className="plab-control-body">
      <section className="plab-control-section plab-source-control" aria-labelledby="plab-source-heading">
        <div className="plab-section-heading">
          <span className="plab-section-index">01</span>
          <div>
            <h2 id="plab-source-heading">Choose pattern</h2>
            <p>Start with a built-in Lightweaver look.</p>
          </div>
        </div>
        <label className="plab-field">
          <span>Base pattern</span>
          <select id="plab-base-pattern" value={selectedPatternId || ''} onChange={event => onPatternChange(event.target.value)}>
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
        </label>
      </section>

      <section className="plab-control-section" aria-labelledby="plab-sculpt-heading">
        <div className="plab-section-heading">
          <span className="plab-section-index">02</span>
          <div>
            <h2 id="plab-sculpt-heading">Sculpt the look</h2>
            <p>Five creative controls, with no code required.</p>
          </div>
        </div>
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
      </section>
    </div>
  );
}
