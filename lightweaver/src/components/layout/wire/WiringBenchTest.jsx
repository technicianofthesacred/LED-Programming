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

export function WiringBenchTest({ wiring, compiled, updateWiring, priorConfirmedLook = null }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [state, dispatch] = useReducer(wiringChaseReducer, null);
  const [featureGap, setFeatureGap] = useState(null);
  const sessionRef = useRef(null);

  const makeSession = () => createWiringChaseSession({
    priorLook: priorConfirmedLook,
    restoreLook: look => pushLivePreviewToCard(look, { latestOnly: false }),
  });

  useEffect(() => {
    if (!state || state.status !== 'active' || state.delivery !== 'idle' || !sessionRef.current) return;
    const requestId = state.requestId;
    const step = state.steps[state.stepIndex];
    const frame = buildWiringChaseFrame({ totalPixels: compiled.totalPixels, step });
    sessionRef.current.show(frame)
      .then(response => dispatch({ type: 'delivery', requestId, response }))
      .catch(error => {
        sessionRef.current = null;
        dispatch({ type: 'delivery', requestId, response: { ok: false, error: error.message } });
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
    sessionRef.current = makeSession();
    dispatch({ type: 'begin', compiled });
  };

  const activeStep = state?.steps?.[state.stepIndex];
  const retry = () => {
    sessionRef.current = makeSession();
    dispatch({ type: 'retry' });
  };
  const cancel = async () => {
    await sessionRef.current?.stop().catch(() => {});
    sessionRef.current = null;
    dispatch({ type: 'cancel' });
  };
  const correctDirection = () => {
    if (activeStep?.kind !== 'run') return;
    const downstream = state.steps.slice(state.stepIndex).filter(step => step.kind === 'run').map(step => step.runId);
    const result = updateWiring(draft => {
      const run = draft.runs.find(item => item.id === activeStep.runId);
      if (run) run.physicalDirection = run.physicalDirection === 'source-reverse' ? 'source-forward' : 'source-reverse';
    }, { changeKind: 'direction', runIds: downstream });
    if (result.ok) dispatch({ type: 'reverse-direction' });
  };
  const complete = async () => {
    if (!state?.canComplete) return;
    const result = updateWiring(draft => {
      draft.verified = true;
      draft.runs.forEach(run => { run.verified = true; });
    }, { changeKind: null });
    if (!result.ok) return;
    await sessionRef.current?.complete().catch(() => {});
    sessionRef.current = null;
    dispatch({ type: 'complete' });
  };

  if (!state || state.status === 'cancelled' || state.status === 'complete') return (
    <section className="lw-bench-test" data-testid="wiring-bench-test">
      <div className="lw-wire-section-title"><span>Bench test</span><strong>Low brightness · 4 fps</strong></div>
      <label className="lw-bench-ack"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)}/> I am beside the artwork and can see the LEDs.</label>
      <button className="btn primary" disabled={!acknowledged || !compiled.ok} onClick={begin}>Start wiring test</button>
      {state?.status === 'complete' && <p>Bench verification complete. Wiring can now be locked.</p>}
      {featureGap && <div className="lw-wiring-error"><p>{featureGap.message}</p><button className="btn" onClick={() => { openCardBridge(); window.location.hash = '#screen=flash'; }}>Open Flash</button></div>}
    </section>
  );

  return (
    <section className="lw-bench-test is-active" data-testid="wiring-bench-test">
      <div className="lw-wire-section-title"><span>Bench test · {state.stepIndex + 1}/{state.steps.length}</span><strong>{state.delivery === 'confirmed' ? 'Frame confirmed' : state.delivery === 'failed' ? 'Delivery failed' : 'Sending frame…'}</strong></div>
      {activeStep?.kind === 'output' ? (
        <div><h4>Identify {activeStep.label}</h4><p>GPIO {activeStep.pin} · {activeStep.count} pixels. Confirm only the expected output is lit.</p><button className="btn primary" disabled={state.delivery !== 'confirmed'} onClick={() => dispatch({ type: 'confirm-output' })}>I see {activeStep.label}</button></div>
      ) : (
        <div><h4>Run {activeStep?.runId}</h4><p>The red marker is DATA IN; the green chase shows physical direction.</p><button className="btn" disabled={state.delivery !== 'confirmed' || state.firstPixelConfirmed} onClick={() => dispatch({ type: 'confirm-first-pixel' })}>First pixel is correct</button><button className="btn primary" disabled={state.delivery !== 'confirmed' || !state.firstPixelConfirmed} onClick={() => dispatch({ type: 'confirm-direction' })}>Direction is correct</button><button className="btn" disabled={state.delivery !== 'confirmed'} onClick={correctDirection}>Reverse direction</button></div>
      )}
      {state.delivery === 'failed' && <div className="lw-wiring-error"><p>{state.error}</p><button className="btn primary" onClick={retry}>Retry</button></div>}
      <div className="lw-bench-nav"><button className="btn" disabled={state.stepIndex === 0} onClick={() => dispatch({ type: 'previous' })}>Previous</button><button className="btn" disabled={state.stepIndex === state.steps.length - 1} onClick={() => dispatch({ type: 'next' })}>Next</button><button className="btn" onClick={cancel}>Cancel test</button><button className="btn primary" disabled={!state.canComplete} onClick={complete}>Complete verification</button></div>
    </section>
  );
}
