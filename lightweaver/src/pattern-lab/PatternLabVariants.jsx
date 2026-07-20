import PatternLabPreview from './PatternLabPreview.jsx';

export default function PatternLabVariants({
  recipe,
  sourceSeed,
  variantSeeds,
  geometry,
  previewTime,
  renderPreviews = true,
  comparison,
  seedLocked,
  onComparison,
  onSelectSeed,
  onSeedLock,
  onNewVariations,
}) {
  return (
    <section className="plab-control-section plab-variants" aria-labelledby="plab-variants-heading" data-testid="pattern-lab-variants">
      <div className="plab-section-heading">
        <span className="plab-section-index">04</span>
        <div>
          <h2 id="plab-variants-heading">Save variation</h2>
          <p>Compare the source or choose a seed at the journey midpoint. Selecting one turns on Long Evolution.</p>
        </div>
      </div>

      <div className="plab-ab-row">
        <span>A/B preview</span>
        <div role="group" aria-label="A/B preview">
          <button type="button" className="btn" disabled={!recipe} aria-pressed={comparison === 'source'} onClick={() => onComparison('source')}>Source</button>
          <button type="button" className="btn" disabled={!recipe} aria-pressed={comparison === 'draft'} onClick={() => onComparison('draft')}>Draft</button>
        </div>
      </div>

      <div className="plab-seed-heading">
        <span>Seed variations</span>
        <span>Current <strong data-testid="pattern-lab-seed">{recipe?.seed ?? sourceSeed ?? '—'}</strong></span>
      </div>
      <div className="plab-variation-grid">
        {variantSeeds.map((seed, index) => (
          <button
            key={seed}
            type="button"
            className="plab-variation"
            data-seed={seed}
            disabled={!recipe}
            aria-label={`Select variation ${index + 1}`}
            aria-pressed={recipe?.seed === seed}
            onClick={() => onSelectSeed(seed)}
          >
            {renderPreviews && recipe && geometry && (
              <PatternLabPreview
                recipe={{ ...recipe, seed }}
                previewTime={previewTime}
                geometry={geometry}
                thumbnail
                seedPreview
              />
            )}
            <span>Variation {index + 1}</span>
            <small>{String(seed).padStart(8, '0').slice(-8)}</small>
          </button>
        ))}
      </div>
      <div className="plab-seed-actions">
        <label>
          <input
            type="checkbox"
            aria-label="Lock seed choices"
            checked={seedLocked}
            disabled={!recipe}
            onChange={event => onSeedLock(event.target.checked)}
          />
          <span>Lock choices</span>
        </label>
        <button type="button" className="btn" disabled={!recipe || seedLocked} onClick={onNewVariations}>New variation</button>
      </div>
      <p className="plab-seed-note">New choices leave your working draft unchanged until you select one.</p>
    </section>
  );
}
