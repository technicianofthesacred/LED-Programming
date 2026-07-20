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
    detail: 'Card compatibility is not proven yet. Resolve the unknown or unsupported requirements before export.',
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

const BUDGET_STATUS_LABELS = {
  unknown: 'Unknown',
  invalid: 'Invalid',
  'too-low': 'Too low',
  'over-limit': 'Over limit',
  fits: 'Fits',
};

function formatCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Unknown';
  return new Intl.NumberFormat().format(Number(value));
}

function budgetValues(key, budget) {
  if (key === 'microSdBytes') return [budget.required, budget.available];
  return [budget.used, budget.limit];
}

function budgetStatus(budget) {
  if (BUDGET_STATUS_LABELS[budget.status]) return budget.status;
  if (budget.known === false) return 'unknown';
  return budget.ok ? 'fits' : 'over-limit';
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
  const changesResolveCompatibility = compatibility.simplification?.resolvesCompatibility === true;

  return (
    <section className="plab-control-section plab-export" aria-labelledby="plab-export-heading" data-testid="pattern-lab-export">
      <div className="plab-section-heading">
        <span className="plab-section-index">06</span>
        <div>
          <h2 id="plab-export-heading">Card export</h2>
          <p>Compatibility is evaluated against the firmware descriptor and declared or measured output budgets.</p>
        </div>
      </div>

      <div className="plab-export-status" data-classification={compatibility.classification} role="status">
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </div>

      <dl className="plab-export-budgets" aria-label="Card compatibility budgets">
        {Object.entries(compatibility.budgets || {}).map(([key, value]) => {
          const [used, limit] = budgetValues(key, value);
          const status = budgetStatus(value);
          const usedLabel = used === null && status === 'invalid' ? 'Invalid' : formatCount(used);
          return (
            <div
              key={key}
              data-budget-status={status}
            >
              <dt>{BUDGET_LABELS[key] || key}</dt>
              <dd>
                {usedLabel} / {formatCount(limit)}{' '}
                <span>{BUDGET_STATUS_LABELS[status]}</span>
              </dd>
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
          <summary>{changesResolveCompatibility ? 'Proposed card-safe changes' : 'Optional cleanup changes'}</summary>
          <ul>{changes.map((change, index) => <li key={`${change.action}-${index}`}>{change.label}</li>)}</ul>
          <p>
            {changesResolveCompatibility
              ? 'Your original recipe stays unchanged. Simplify creates a separately validated variant.'
              : 'These changes do not resolve every card blocker. They are cleanup only, not a card-safe export.'}
          </p>
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
