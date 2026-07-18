import React, { useCallback, useState } from 'react';
import { runDeploymentSelfCheck } from '../../lib/deploymentSelfCheck.js';

/* Verify the deployment from the page itself — no repo clone, no Node.
   Runs on demand only (a support visit must not generate network traffic
   by itself), and never claims success it did not measure. */
export function DeploymentCheckPanel() {
  const [state, setState] = useState({ status: 'idle', outcome: null });

  const run = useCallback(async () => {
    setState({ status: 'running', outcome: null });
    try {
      const outcome = await runDeploymentSelfCheck();
      setState({ status: 'done', outcome });
    } catch (error) {
      setState({
        status: 'done',
        outcome: {
          ok: false,
          summary: null,
          results: [{ id: 'run', label: 'Deployment check', ok: false, detail: String(error?.message || error).split('\n')[0].slice(0, 300) }],
        },
      });
    }
  }, []);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const { status, outcome } = state;

  return (
    <section className="card-support-panel" data-testid="deployment-check-panel">
      <h2>Deployment check</h2>
      <p>
        Verifies that <strong>{origin || 'this site'}</strong> is serving a coherent signed release:
        manifest signature against the pinned Lightweaver release key, factory image hash,
        matching provenance, every indexed production job artifact, and the required cache policies.
        Runs entirely in this browser — no repo clone or install needed.
      </p>
      <div className="set-actions">
        <button type="button" className="btn primary" onClick={run} disabled={status === 'running'}>
          {status === 'running' ? 'Checking…' : status === 'done' ? 'Run again' : 'Run deployment check'}
        </button>
      </div>

      {status === 'done' && outcome && (
        <div className="deploy-check-results" data-testid="deployment-check-results" role="status" aria-live="polite">
          <p className={`deploy-check-verdict ${outcome.ok ? 'is-ok' : 'is-err'}`}>
            {outcome.ok
              ? 'All deployment checks passed.'
              : 'Deployment checks FAILED — do not treat this deployment as verified.'}
          </p>
          {outcome.summary && (
            <p className="deploy-check-summary">
              Firmware v{outcome.summary.firmwareVersion} · build {String(outcome.summary.buildId).slice(0, 12)} ·
              source {String(outcome.summary.sourceRevision).slice(0, 12)} · {outcome.summary.jobCount} signed
              production job{outcome.summary.jobCount === 1 ? '' : 's'}
            </p>
          )}
          <ul className="deploy-check-rows">
            {outcome.results.map(result => (
              <li key={result.id} data-check-ok={result.ok ? 'true' : 'false'}>
                <span aria-hidden="true">{result.ok ? '✓' : '✕'}</span>
                <span className="deploy-check-label">{result.label}</span>
                <span className="deploy-check-detail">{result.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="deploy-check-note">
        This self-check catches stale, partial, or corrupted deployments. The fully independent
        audit against the committed repository remains <code>npm run check:prod</code> from a
        checkout, because a page can only be as independent as the origin that served it.
      </p>
    </section>
  );
}
