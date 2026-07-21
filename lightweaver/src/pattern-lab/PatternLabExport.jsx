import { useEffect, useRef, useState } from 'react';
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
  recipe,
  onBake,
  onUseInProject,
  onSimplify,
  onRemoveFeature,
}) {
  const project = useProject();
  const [layoutExportStatus, setLayoutExportStatus] = useState(null);
  const [bakeStatus, setBakeStatus] = useState(null);
  const [completedBakeResult, setCompletedBakeResult] = useState(null);
  const [handoffStatus, setHandoffStatus] = useState(null);
  const bakeAbortRef = useRef(null);
  useEffect(() => () => bakeAbortRef.current?.abort(), []);
  useEffect(() => {
    bakeAbortRef.current?.abort();
    setCompletedBakeResult(null);
    setBakeStatus(null);
    setHandoffStatus(null);
  }, [recipe]);
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
    xlights: {
      controllerName: activeController?.name || 'Lightweaver Controller',
      protocol: String(activeController?.led?.type || 'ws2811').trim().toLowerCase(),
      firstPort: 1,
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

  async function bakeSequence() {
    if (bakeAbortRef.current || typeof onBake !== 'function') return;
    const controller = new AbortController();
    bakeAbortRef.current = controller;
    setBakeStatus({ state: 'rendering', message: 'Baking deterministic frames…' });
    try {
      const result = await onBake(compatibility, { signal: controller.signal });
      if (!result?.bytes || !result?.sidecarJson) {
        setBakeStatus(null);
        return;
      }
      const slug = exportSlug(project.projectName);
      download(result.bytes, `${slug}.lwseq`, 'application/octet-stream');
      download(`${result.sidecarJson}\n`, `${slug}.lwseq.json`, 'application/json');
      setCompletedBakeResult(result);
      setBakeStatus({
        state: 'complete',
        message: `Exported ${result.sidecar.frameCount} frames for ${result.sidecar.pixelCount} pixels with verified hashes.`,
      });
    } catch (error) {
      setBakeStatus({
        state: error?.name === 'AbortError' ? 'canceled' : 'error',
        message: error?.name === 'AbortError'
          ? 'Bake canceled. No partial file was exported.'
          : (error instanceof Error ? error.message : 'Pattern Lab bake failed.'),
      });
    } finally {
      if (bakeAbortRef.current === controller) bakeAbortRef.current = null;
    }
  }

  async function useInProject() {
    if (typeof onUseInProject !== 'function') return;
    setHandoffStatus({ state: 'adding', message: 'Adding the reviewed item…' });
    try {
      const result = await onUseInProject({ bakeResult: completedBakeResult });
      if (!result?.ok) {
        setHandoffStatus({
          state: 'error',
          message: result?.message || 'This pattern could not be added to the project.',
        });
        return;
      }
      setHandoffStatus({ state: 'complete', message: result.message });
    } catch (error) {
      setHandoffStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'This pattern could not be added to the project.',
      });
    }
  }

  const handoffReady = compatibility.classification === 'live-on-card'
    || (compatibility.classification === 'bake-to-card' && completedBakeResult);
  const handoffReviewCopy = compatibility.classification === 'live-on-card'
    ? `A new saved look named “${recipe?.name || 'Untitled pattern'}” will be added and selected. Existing looks stay unchanged.`
    : compatibility.classification === 'bake-to-card'
      ? (completedBakeResult
          ? `A new sequence asset named “${recipe?.name || 'Untitled pattern'}” and a verified controller package will be added. Existing project items stay unchanged.`
          : 'Bake this exact recipe first. The completed sequence will be verified again before anything is added.')
      : 'This recipe is not ready to add. Use the compatibility guidance above to create a card-safe version.';

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

      {recipe?.offlineAudio && (
        <p className="plab-export-audio-status">Offline audio lanes included · Bake only</p>
      )}

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
              disabled={action.id === 'bake' && bakeStatus?.state === 'rendering'}
              onClick={() => {
                if (action.id === 'bake') void bakeSequence();
                else runAction(action, compatibility, { onSimplify, onRemoveFeature });
              }}
            >
              {action.id === 'bake' && bakeStatus?.state === 'rendering' ? 'Baking…' : action.label}
            </button>
          ))}
          {bakeStatus?.state === 'rendering' && (
            <button type="button" className="btn" onClick={() => bakeAbortRef.current?.abort()}>Cancel bake</button>
          )}
        </div>
      )}
      {bakeStatus && (
        <p
          data-testid="pattern-lab-bake-status"
          role={bakeStatus.state === 'error' ? 'alert' : 'status'}
        >{bakeStatus.message}</p>
      )}

      <div className="plab-project-handoff" data-testid="pattern-lab-project-handoff">
        <div>
          <h3>Use in Project</h3>
          <p>Review the exact addition before Pattern Lab changes your active project.</p>
        </div>
        {handoffStatus?.state !== 'review' && handoffStatus?.state !== 'adding' && (
          <button
            type="button"
            className="btn primary"
            onClick={() => setHandoffStatus({ state: 'review', message: handoffReviewCopy })}
          >Review Use in Project</button>
        )}
        {(handoffStatus?.state === 'review' || handoffStatus?.state === 'adding') && (
          <div className="plab-handoff-review" role="group" aria-label="Confirm Use in Project">
            <strong>Confirm project addition</strong>
            <p>{handoffReviewCopy}</p>
            <div className="plab-export-actions">
              <button
                type="button"
                className="btn primary"
                disabled={!handoffReady || handoffStatus.state === 'adding'}
                onClick={() => void useInProject()}
              >{handoffStatus.state === 'adding' ? 'Adding…' : 'Add to project'}</button>
              <button
                type="button"
                className="btn"
                disabled={handoffStatus.state === 'adding'}
                onClick={() => setHandoffStatus(null)}
              >Cancel</button>
            </div>
          </div>
        )}
        {handoffStatus && !['review', 'adding'].includes(handoffStatus.state) && (
          <p
            data-testid="pattern-lab-handoff-status"
            role={handoffStatus.state === 'error' ? 'alert' : 'status'}
          >{handoffStatus.message}</p>
        )}
      </div>

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
