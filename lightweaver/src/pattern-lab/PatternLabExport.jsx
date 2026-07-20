import { useState } from 'react';
import { download } from '../lib/export.js';
import { createArtNetSetupNotes, toMadrixFixtureCsv } from '../lib/madrixPatchExport.js';
import { toXlightsXmodel } from '../lib/xlightsExport.js';
import { useProject } from '../state/ProjectContext.jsx';

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

function exportSlug(name) {
  return String(name || 'lightweaver-layout')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'lightweaver-layout';
}

export default function PatternLabExport({
  compatibility,
  onBake,
  onSimplify,
  onRemoveFeature,
}) {
  const project = useProject();
  const [layoutExportStatus, setLayoutExportStatus] = useState(null);
  if (!compatibility) return null;

  const copy = CLASSIFICATION_COPY[compatibility.classification] || {
    title: 'Compatibility unavailable',
    detail: 'Re-run the compatibility check before exporting this pattern.',
  };
  const actions = Array.isArray(compatibility.actions) ? compatibility.actions : [];
  const reasons = Array.isArray(compatibility.reasons) ? compatibility.reasons : [];
  const changes = compatibility.simplification?.changes || [];
  const changesResolveCompatibility = compatibility.simplification?.resolvesCompatibility === true;
  const activeController = (project.controllerProfiles || []).find(
    profile => profile.id === project.activeControllerId,
  ) || null;
  const layoutExportInput = {
    name: project.projectName,
    strips: project.strips,
    groups: project.layoutLayerGroups,
    wiring: project.wiring,
    artnet: {
      ...(activeController?.artnet || {}),
      targetIp: activeController?.ip || '',
    },
  };

  function exportLayout(kind) {
    try {
      const slug = exportSlug(project.projectName);
      if (kind === 'xlights') {
        download(toXlightsXmodel(layoutExportInput), `${slug}.xmodel`, 'application/xml');
        setLayoutExportStatus({ error: false, message: 'Exported xLights model.' });
      } else if (kind === 'madrix') {
        download(toMadrixFixtureCsv(layoutExportInput), `${slug}.madrix-fixtures.csv`, 'text/csv;charset=utf-8');
        setLayoutExportStatus({ error: false, message: 'Exported MADRIX fixture CSV.' });
      } else if (kind === 'artnet-notes') {
        download(createArtNetSetupNotes(layoutExportInput), `${slug}.artnet-setup.txt`, 'text/plain;charset=utf-8');
        setLayoutExportStatus({ error: false, message: 'Exported Art-Net setup notes.' });
      }
    } catch (error) {
      setLayoutExportStatus({
        error: true,
        message: error instanceof Error ? error.message : 'Layout export could not be generated.',
      });
    }
  }

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

      <div className="plab-runtime-cleanup">
        <h3>Layout and lighting software</h3>
        <p>These files use the locked physical wiring order. They do not change the current project or connected lights.</p>
        <div className="plab-export-actions" role="group" aria-label="Lighting software exports">
          <button type="button" className="btn" onClick={() => exportLayout('xlights')}>Export xLights model</button>
          <button type="button" className="btn" onClick={() => exportLayout('madrix')}>Export MADRIX fixture CSV</button>
          <button type="button" className="btn" onClick={() => exportLayout('artnet-notes')}>Export Art-Net setup notes</button>
        </div>
        {layoutExportStatus && (
          <p
            data-testid="pattern-lab-layout-export-status"
            role={layoutExportStatus.error ? 'alert' : 'status'}
          >{layoutExportStatus.message}</p>
        )}
      </div>
    </section>
  );
}
