const CLASSIFICATION_COPY = {
  'live-on-card': {
    title: 'Live on card',
    detail: 'This recipe and its current budgets are supported by the connected card descriptor.',
  },
  'bake-to-card': {
    title: 'Bake to card',
    detail: 'The card cannot run every feature live, but it can play a baked LWSEQ file.',
  },
  'simplify-for-card': {
    title: 'Simplify for card',
    detail: 'A separate card-safe variant can be created with the explicit changes below.',
  },
  'studio-only': {
    title: 'Studio only',
    detail: 'This recipe currently needs Studio capabilities and cannot be sent to the card safely.',
  },
};

const BUDGET_LABELS = {
  pixelCount: 'Pixels',
  fps: 'Frames / second',
  operationsPerFrame: 'Operations / frame',
  stateBytes: 'State memory',
  framebufferBytes: 'Framebuffer',
  nativeConfigBytes: 'Native config',
  lwseqBytes: 'Baked sequence',
  microSdBytes: 'microSD capacity',
};

function formatCount(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function budgetValues(key, budget) {
  if (key === 'microSdBytes') return [budget.required, budget.available];
  return [budget.used, budget.limit];
}

function runAction(action, compatibility, handlers) {
  if (action.id === 'bake') handlers.onBake?.(compatibility);
  if (action.id === 'simplify') {
    handlers.onSimplify?.(compatibility.simplification?.variant, compatibility);
  }
  if (action.id === 'remove-feature') {
    const removals = compatibility.simplification?.changes?.filter(change => change.action === 'remove-feature') || [];
    handlers.onRemoveFeature?.(removals, compatibility);
  }
}

export default function PatternLabExport({
  compatibility,
  onBake,
  onSimplify,
  onRemoveFeature,
}) {
  if (!compatibility) return null;

  const copy = CLASSIFICATION_COPY[compatibility.classification] || {
    title: 'Compatibility unavailable',
    detail: 'Re-run the compatibility check before exporting this pattern.',
  };
  const actions = Array.isArray(compatibility.actions) ? compatibility.actions : [];
  const reasons = Array.isArray(compatibility.reasons) ? compatibility.reasons : [];
  const changes = compatibility.simplification?.changes || [];

  return (
    <section className="plab-control-section plab-export" aria-labelledby="plab-export-heading" data-testid="pattern-lab-export">
      <div className="plab-section-heading">
        <span className="plab-section-index">06</span>
        <div>
          <h2 id="plab-export-heading">Card export</h2>
          <p>Compatibility is evaluated against the firmware descriptor and real output budgets.</p>
        </div>
      </div>

      <div className="plab-export-status" data-classification={compatibility.classification} role="status">
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </div>

      <dl className="plab-export-budgets" aria-label="Card compatibility budgets">
        {Object.entries(compatibility.budgets || {}).map(([key, value]) => {
          const [used, limit] = budgetValues(key, value);
          return (
            <div key={key} data-budget-ok={value.ok ? 'true' : 'false'}>
              <dt>{BUDGET_LABELS[key] || key}</dt>
              <dd>{formatCount(used)} / {formatCount(limit)} <span>{value.ok ? 'Fits' : 'Over'}</span></dd>
            </div>
          );
        })}
      </dl>

      {reasons.length > 0 && (
        <div className="plab-export-reasons">
          <h3>What needs attention</h3>
          <ul>{reasons.map((reason, index) => <li key={`${reason.code}-${reason.feature || ''}-${index}`}>{reason.message}</li>)}</ul>
        </div>
      )}

      {changes.length > 0 && (
        <details className="plab-advanced">
          <summary>Proposed card-safe changes</summary>
          <ul>{changes.map((change, index) => <li key={`${change.action}-${index}`}>{change.label}</li>)}</ul>
          <p>Your original recipe stays unchanged. Simplify creates a separate variant.</p>
        </details>
      )}

      {actions.length > 0 && (
        <div className="plab-export-actions" role="group" aria-label="Card export actions">
          {actions.map(action => (
            <button
              key={action.id}
              type="button"
              className="btn"
              onClick={() => runAction(action, compatibility, { onBake, onSimplify, onRemoveFeature })}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
