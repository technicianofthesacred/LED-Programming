import { resolvePatternLabMacros } from '../lib/patternLabMacros.js';

const MACROS = [
  ['color', 'Color', 'Warmth and palette travel'],
  ['movement', 'Movement', 'From drifting to animated'],
  ['shape', 'Shape', 'Broad forms to finer structure'],
  ['texture', 'Texture', 'Soft atmosphere to crisp detail'],
  ['energy', 'Energy', 'Quiet glow to luminous presence'],
];

export default function PatternLabControls({ patterns, recipe, selectedPatternId, onPatternChange, onMacroChange }) {
  const technical = recipe ? resolvePatternLabMacros(recipe) : null;

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
            {patterns.map(pattern => <option key={pattern.id} value={pattern.id}>{pattern.name}</option>)}
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

        <details className="plab-advanced" disabled={!recipe}>
          <summary>Advanced controls</summary>
          {technical ? (
            <dl>
              <div><dt>Speed</dt><dd>{technical.movement.speedMultiplier.toFixed(2)}×</dd></div>
              <div><dt>Spatial scale</dt><dd>{technical.shape.spatialScale.toFixed(2)}×</dd></div>
              <div><dt>Detail</dt><dd>{technical.texture.detailScale.toFixed(2)}×</dd></div>
              <div><dt>Brightness ceiling</dt><dd>{Math.round(technical.energy.brightness * 100)}%</dd></div>
            </dl>
          ) : <p>Choose a pattern to inspect its technical values.</p>}
        </details>
      </section>
    </div>
  );
}
