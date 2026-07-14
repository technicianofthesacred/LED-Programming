import { useEffect, useReducer, useRef, useState } from 'react';
import { canPushDirectlyToCard } from '../../../lib/cardConnection.js';
import { cardBridgeFeatureGap, openCardBridge } from '../../../lib/cardBridge.js';
import { pushLivePreviewToCard } from '../../../lib/cardLiveControl.js';
import {
  buildWiringChaseFrame,
  createWiringChaseSession,
  createWiringChaseState,
  wiringChaseReducer,
} from '../../../lib/wiringChase.js';

export function WiringBenchTest({
  wiring, compiled, updateWiring, priorConfirmedLook = null, cardHost,
  strips = [], adjustableRunIds = [], onAdjustBoundary,
  adjustableOutputIds = [], onAdjustOutput,
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [state, dispatch] = useReducer(wiringChaseReducer, null);
  const [featureGap, setFeatureGap] = useState(null);
  const sessionRef = useRef(null);
  const mountedRef = useRef(false);
  const compiledRef = useRef(compiled);
  const skipNextCompiledSyncRef = useRef(false);
  const highWaterPixelsRef = useRef(compiled.totalPixels);

  const makeSession = () => createWiringChaseSession({
    host: cardHost,
    priorLook: priorConfirmedLook,
    restoreLook: look => pushLivePreviewToCard(look, { host: cardHost, latestOnly: false }),
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) void session.stop().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (compiledRef.current === compiled) return;
    compiledRef.current = compiled;
    highWaterPixelsRef.current = Math.max(highWaterPixelsRef.current, compiled.totalPixels);
    if (skipNextCompiledSyncRef.current) {
      skipNextCompiledSyncRef.current = false;
      return;
    }
    if (state?.status === 'active') dispatch({ type: 'sync-compiled', compiled });
  }, [compiled, state?.status]);

  useEffect(() => {
    if (!state || state.status !== 'active' || state.delivery !== 'idle' || !sessionRef.current) return;
    const requestId = state.requestId;
    const step = state.steps[state.stepIndex];
    const frame = buildWiringChaseFrame({ totalPixels: highWaterPixelsRef.current, step });
    const session = sessionRef.current;
    session.show(frame)
      .then(response => {
        if (mountedRef.current && sessionRef.current === session) dispatch({ type: 'delivery', requestId, response });
      })
      .catch(error => {
        if (sessionRef.current === session) sessionRef.current = null;
        if (mountedRef.current) dispatch({ type: 'delivery', requestId, response: { ok: false, error: error.message } });
      });
  }, [compiled.totalPixels, state]);

  if (wiring.locked) return null;

  // useReducer cannot lazily initialize on an event without replacing the
  // reducer state, so keep the inactive shell outside and mount the active
  // reducer through this small reset action.
  const begin = () => {
    if (!acknowledged || !compiled.ok) return;
    if (!canPushDirectlyToCard()) {
      const gap = cardBridgeFeatureGap('frame');
      if (gap) { setFeatureGap(gap); return; }
    }
    setFeatureGap(null);
    highWaterPixelsRef.current = compiled.totalPixels;
    sessionRef.current = makeSession();
    dispatch({ type: 'begin', compiled });
  };

  const activeStep = state?.steps?.[state.stepIndex];
  const activeStrip = strips.find(strip => strip.id === activeStep?.source?.stripId);
  const activeLabel = activeStrip?.name || activeStep?.label || activeStep?.runId || 'Run';
  const stepLabel = activeStep?.kind === 'output' ? activeStep.label
    : activeStep?.kind === 'cable' ? 'Cable jump'
      : activeStep?.kind === 'inactive' ? 'Reserved · unlit'
        : activeLabel;
  const retry = () => {
    sessionRef.current = makeSession();
    dispatch({ type: 'retry' });
  };
  const cancel = async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    await session?.stop().catch(() => {});
    highWaterPixelsRef.current = compiled.totalPixels;
    dispatch({ type: 'cancel' });
  };
  const correctDirection = () => {
    if (activeStep?.kind !== 'run') return;
    skipNextCompiledSyncRef.current = true;
    const downstream = state.steps.slice(state.stepIndex).filter(step => step.kind === 'run').map(step => step.runId);
    const result = updateWiring(draft => {
      const run = draft.runs.find(item => item.id === activeStep.runId);
      if (run) run.physicalDirection = run.physicalDirection === 'source-reverse' ? 'source-forward' : 'source-reverse';
    }, { changeKind: 'direction', runIds: downstream });
    if (result.ok) dispatch({ type: 'reverse-direction' });
    else skipNextCompiledSyncRef.current = false;
  };
  const adjustBoundary = delta => {
    if (activeStep?.kind !== 'run' || !onAdjustBoundary) return;
    onAdjustBoundary(activeStep.runId, delta);
  };
  const adjustOutput = delta => {
    if (activeStep?.kind !== 'output' || !onAdjustOutput) return;
    onAdjustOutput(activeStep.outputId, delta);
  };
  const confirmRun = () => {
    dispatch({ type: 'confirm-first-pixel' });
    dispatch({ type: 'confirm-direction' });
  };
  const complete = async () => {
    if (!state?.canComplete) return;
    const result = updateWiring(draft => {
      draft.verified = true;
      draft.runs.forEach(run => {
        if (state.confirmedRuns[run.id]) run.verified = true;
      });
    }, { changeKind: null });
    if (!result.ok) return;
    const session = sessionRef.current;
    sessionRef.current = null;
    await session?.complete().catch(() => {});
    highWaterPixelsRef.current = compiled.totalPixels;
    dispatch({ type: 'complete' });
  };

  if (!state || state.status === 'cancelled' || state.status === 'complete') return (
    <section className="lw-bench-test" data-testid="wiring-bench-test">
      <div className="lw-bench-idle-row">
        <div><span className="lw-bench-kicker">Physical check</span><strong>Verify the real LEDs</strong></div>
        <button className="btn primary" disabled={!acknowledged || !compiled.ok} onClick={begin}>Start wiring test</button>
      </div>
      <label className="lw-bench-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/> I can see the strip</label>
      {state?.status === 'complete' && <p>Bench verification complete. Wiring can now be locked.</p>}
      {featureGap && <div className="lw-wiring-error"><p>{featureGap.message}</p><button className="btn" onClick={() => { openCardBridge(); window.location.hash = '#screen=flash'; }}>Open Flash</button></div>}
    </section>
  );

  return (
    <section className="lw-bench-test is-active" data-testid="wiring-bench-test">
      <header className="lw-bench-head">
        <span className="lw-bench-step">{state.stepIndex + 1}/{state.steps.length}</span>
        <div><span className="lw-bench-kicker">Now checking</span><h4>{stepLabel}</h4></div>
        <span className={`lw-bench-delivery is-${state.delivery}`}>{state.delivery === 'confirmed' ? 'Live' : state.delivery === 'failed' ? 'Offline' : 'Sending'}</span>
      </header>
      <div className="lw-bench-legend" aria-label="Pixel marker legend">
        <span><i className="is-blue"/>Blue <small>first</small></span>
        <span><i className="is-green"/>Green <small>between</small></span>
        <span><i className="is-red"/>Red <small>last</small></span>
      </div>
      {activeStep?.kind === 'output' ? (
        <div className="lw-bench-run">
          <div className="lw-bench-count-adjust">
            <button className="lw-bench-nudge" aria-label={`Remove one pixel from ${activeStep.label}`} disabled={state.delivery !== 'confirmed' || !adjustableOutputIds.includes(activeStep.outputId) || activeStep.count <= 1} onClick={() => adjustOutput(-1)}>−</button>
            <strong data-testid="active-output-count">{activeStep.count} pixels</strong>
            <button className="lw-bench-nudge" aria-label={`Add one pixel to ${activeStep.label}`} disabled={state.delivery !== 'confirmed' || !adjustableOutputIds.includes(activeStep.outputId)} onClick={() => adjustOutput(1)}>+</button>
          </div>
          <span className="lw-bench-boundary-hint">GPIO {activeStep.pin} · Move red to the output’s final LED.</span>
          <div className="lw-bench-action-row"><button className="btn primary" disabled={state.delivery !== 'confirmed'} onClick={() => dispatch({ type: 'confirm-output' })}>I see {activeStep.label}</button></div>
        </div>
      ) : activeStep?.kind === 'run' ? (
        <div className="lw-bench-run">
          <div className="lw-bench-count-adjust">
            <button className="lw-bench-nudge" aria-label={`Remove one pixel from ${activeLabel}`} disabled={state.delivery !== 'confirmed' || !adjustableRunIds.includes(activeStep.runId) || activeStep.count <= 1} onClick={() => adjustBoundary(-1)}>−</button>
            <strong data-testid="active-run-count">{activeStep.count} pixels</strong>
            <button className="lw-bench-nudge" aria-label={`Add one pixel to ${activeLabel}`} disabled={state.delivery !== 'confirmed' || !adjustableRunIds.includes(activeStep.runId)} onClick={() => adjustBoundary(1)}>+</button>
          </div>
          <span className="lw-bench-boundary-hint">Blue and red set the artwork mapping; electrical data direction does not change.</span>
          <div className="lw-bench-action-row"><button className="btn primary" disabled={state.delivery !== 'confirmed'} onClick={confirmRun}>Boundary is correct</button><button className="btn" disabled={state.delivery !== 'confirmed'} onClick={correctDirection}>Flip mapping</button></div>
        </div>
      ) : activeStep?.kind === 'cable' ? (
        <div className="lw-bench-action"><strong>Zero-address cable</strong><button className="btn primary" disabled={state.delivery !== 'confirmed'} onClick={() => dispatch({ type: 'confirm-cable' })}>Cable is connected</button></div>
      ) : (
        <div className="lw-bench-action"><strong>{activeStep?.count || 0} pixels stay dark</strong><button className="btn primary" disabled={state.delivery !== 'confirmed'} onClick={() => dispatch({ type: 'confirm-inactive' })}>Reserved LEDs stay unlit</button></div>
      )}
      {state.delivery === 'failed' && <div className="lw-wiring-error"><p>{state.error}</p><button className="btn primary" onClick={retry}>Retry</button></div>}
      <div className="lw-bench-nav"><button className="btn" disabled={state.stepIndex === 0} onClick={() => dispatch({ type: 'previous' })}>Back</button><button className="btn" disabled={state.stepIndex === state.steps.length - 1} onClick={() => dispatch({ type: 'next' })}>Skip</button><button className="btn" onClick={cancel}>Stop</button><button className="btn primary" disabled={!state.canComplete} onClick={complete}>Finish</button></div>
    </section>
  );
}
