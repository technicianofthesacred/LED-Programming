export default function PatternLabVariants({
  recipe,
  sourceSeed,
  variantSeeds,
  comparison,
  onComparison,
  onSelectSeed,
}) {
  return (
    <section className="plab-control-section plab-variants" aria-labelledby="plab-variants-heading">
      <div className="plab-section-heading">
        <span className="plab-section-index">04</span>
        <div>
          <h2 id="plab-variants-heading">Save variation</h2>
          <p>Compare the untouched source or try a repeatable seed.</p>
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
            disabled={!recipe}
            aria-pressed={recipe?.seed === seed}
            onClick={() => onSelectSeed(seed)}
          >
            <span>Variation {index + 1}</span>
            <small>{String(seed).padStart(8, '0').slice(-8)}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
