import { useEffect, useReducer, useRef, useState } from 'react';
import { canPushDirectlyToCard } from '../../../lib/cardConnection.js';
import { cardBridgeFeatureGap, openCardBridge } from '../../../lib/cardBridge.js';
import { pushLivePreviewToCard } from '../../../lib/cardLiveControl.js';
import {
  buildWiringChaseFrame,
  buildWiringChaseSteps,
  createWiringChaseSession,
  wiringChaseReducer,
} from '../../../lib/wiringChase.js';
import { UiCard } from '../../ui/UiCard.jsx';
import '../../../styles/lw-bench.css';

const ILLUS_CELLS = 9;

// Schematic strip: blue first LED, green middle, red last — matching the
// frame buildWiringChaseFrame actually sends. 'dark' renders unlit cells for
// cable / reserved steps.
function LedIllustration({ variant = 'marked' }) {
  return (
    <div className="lwb-illus" aria-hidden="true">
      {Array.from({ length: ILLUS_CELLS }, (_, index) => {
        const cls = variant === 'dark' ? ''
          : index === 0 ? ' is-first'
            : index === ILLUS_CELLS - 1 ? ' is-last'
              : ' is-mid';
        return <i key={index} className={`lwb-illus-cell${cls}`} />;
      })}
    </div>
  );
}

export function WiringBenchTest({
  wiring, compiled, updateWiring, priorConfirmedLook = null, cardHost,
  strips = [], adjustableRunIds = [], onAdjustBoundary,
  adjustableOutputIds = [], onAdjustOutput,
  onDefer,
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [state, dispatch] = useReducer(wiringChaseReducer, null);
  const [featureGap, setFeatureGap] = useState(null);
  const [troubleOpen, setTroubleOpen] = useState(false);
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

  // Collapse the "Something's wrong" panel whenever the wizard moves.
  useEffect(() => { setTroubleOpen(false); }, [state?.stepIndex, state?.status]);

  if (wiring.locked) return null;

  // useReducer cannot lazily initialize on an event without replacing the
  // reducer state, so keep the inactive shell outside and mount the active
  // reducer through this small reset action. Starting always requires a fresh
  // visibility acknowledgement (the "I can see them" screen).
  const startChase = () => {
    if (!compiled.ok) return;
    if (!canPushDirectlyToCard()) {
      const gap = cardBridgeFeatureGap('frame');
      if (gap) { setFeatureGap(gap); return; }
    }
    setFeatureGap(null);
    highWaterPixelsRef.current = compiled.totalPixels;
    sessionRef.current = makeSession();
    dispatch({ type: 'begin', compiled });
  };
  const acknowledgeAndStart = () => {
    if (!compiled.ok) return;
    setAcknowledged(true);
    startChase();
  };

  const activeStep = state?.steps?.[state.stepIndex];
  const activeStrip = strips.find(strip => strip.id === activeStep?.source?.stripId);
  const activeLabel = activeStrip?.name || activeStep?.label || activeStep?.runId || 'Run';
  // Wizard copy talks about "wires" (redesign change 6 — the question the
  // user answers is about the physical wire), keyed by the same A/B letters
  // the mapping lanes use, instead of the stored output ids/names.
  const outputDisplayName = outputId => {
    const index = wiring.outputs.findIndex(output => output.id === outputId);
    return index >= 0 ? `Wire ${String.fromCharCode(65 + index)}` : null;
  };
  const activeOutputLabel = activeStep?.kind === 'output'
    ? (outputDisplayName(activeStep.outputId) || activeStep.label)
    : null;
  const stepLabel = activeStep?.kind === 'output' ? activeOutputLabel
    : activeStep?.kind === 'cable' ? 'Cable jump'
      : activeStep?.kind === 'inactive' ? 'Reserved LEDs'
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
    setAcknowledged(false);
    dispatch({ type: 'cancel' });
    // With no step rail to land on, deferring exits the check flow entirely.
    onDefer?.();
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
    setAcknowledged(false);
    dispatch({ type: 'complete' });
  };

  if (!state || state.status === 'cancelled' || state.status === 'complete') {
    const totalScreens = buildWiringChaseSteps(compiled).length + 1;
    return (
      <section className="lw-bench-test lwb-wizard" data-testid="wiring-bench-test">
        <p className="lwb-progress">LED CHECK · 1 OF {totalScreens}</p>
        {state?.status === 'complete' && (
          <p className="lwb-complete" role="status">All checked. Review and lock the wiring before installation.</p>
        )}
        {!acknowledged ? (
          <>
            <h4 className="lwb-question">Stand where you can see the LED strips</h4>
            <p className="lwb-hint">The card lights the first LED blue and the last LED red on each strip. You’ll confirm what you see at each step.</p>
            <LedIllustration />
            {!compiled.ok && <p className="lwb-note" role="status">Fix the LED output mapping errors before starting the check.</p>}
            <button
              type="button"
              className="btn primary lwb-btn"
              aria-label="I can see the LED strips"
              disabled={!compiled.ok}
              onClick={acknowledgeAndStart}
            >I can see them</button>
            {onDefer && (
              <button
                type="button"
                className="btn btn-ghost lwb-btn lwb-btn-row"
                onClick={onDefer}
              >Do this later</button>
            )}
          </>
        ) : (
          <>
            <h4 className="lwb-question">Ready when you are</h4>
            <p className="lwb-hint">You said you can see the strips. Start the check whenever you’re ready.</p>
            <button type="button" className="btn primary lwb-btn" disabled={!compiled.ok} onClick={() => { if (acknowledged) startChase(); }}>Start the check</button>
            <button type="button" className="btn btn-ghost lwb-btn lwb-btn-row" onClick={() => setAcknowledged(false)}>Do this later</button>
          </>
        )}
        {featureGap && (
          <UiCard
            tone="warning"
            description={featureGap.message}
            footer={<button type="button" className="btn lwb-btn-compact" onClick={() => { openCardBridge(); window.location.hash = '#screen=flash'; }}>Open Flash</button>}
          />
        )}
      </section>
    );
  }

  const confirmedDelivery = state.delivery === 'confirmed';
  const kind = activeStep?.kind;
  let question; let hint; let primaryLabel; let onPrimary; let illusVariant = 'marked';
  if (kind === 'output') {
    question = `Do you see ${activeOutputLabel} lit up?`;
    hint = 'The first LED should be blue and the last LED red, with green in between.';
    primaryLabel = `Yes — I see ${activeOutputLabel}`;
    onPrimary = () => dispatch({ type: 'confirm-output' });
  } else if (kind === 'run') {
    question = `Is the first LED of ${activeLabel} lit blue?`;
    hint = `Blue marks the start of ${activeLabel}. Red marks the end.`;
    primaryLabel = 'Yes — blue at the start, red at the end';
    onPrimary = confirmRun;
  } else if (kind === 'cable') {
    question = 'Is the connecting cable plugged in?';
    hint = 'This hop has no LEDs of its own — just make sure the cable between strips is connected.';
    primaryLabel = 'Yes — the cable is connected';
    onPrimary = () => dispatch({ type: 'confirm-cable' });
    illusVariant = 'dark';
  } else {
    question = 'Are the reserved LEDs staying dark?';
    hint = `${activeStep?.count || 0} reserved LEDs should stay unlit during this check.`;
    primaryLabel = 'Yes — they stay dark';
    onPrimary = () => dispatch({ type: 'confirm-inactive' });
    illusVariant = 'dark';
  }

  return (
    <section className="lw-bench-test lwb-wizard is-active" data-testid="wiring-bench-test">
      <p className="lwb-progress">LED CHECK · {state.stepIndex + 2} OF {state.steps.length + 1}</p>
      <p className="lwb-context">{stepLabel}</p>
      <h4 className="lwb-question">{question}</h4>
      <LedIllustration variant={illusVariant} />
      <p className="lwb-hint">{hint}</p>
      {state.delivery === 'idle' && <p className="lwb-sending" role="status">Lighting up the LEDs…</p>}
      {state.delivery === 'failed' && (
        <UiCard
          tone="warning"
          title="The lights didn’t reach the card"
          description={state.error}
          footer={<button type="button" className="btn primary lwb-btn-compact" onClick={retry}>Try again</button>}
        />
      )}
      <button type="button" className="btn primary lwb-btn" disabled={!confirmedDelivery} onClick={onPrimary}>{primaryLabel}</button>
      <button
        type="button"
        className="btn btn-ghost lwb-btn lwb-btn-row"
        aria-expanded={troubleOpen}
        onClick={() => setTroubleOpen(open => !open)}
      >Something’s wrong</button>
      {troubleOpen && (
        <div className="lwb-trouble" role="group" aria-label="Fix this step">
          <p className="lwb-trouble-title">What looks wrong?</p>
          {kind === 'run' && (
            <>
              <div className="lwb-trouble-item">
                <span>Blue is at the wrong end of the strip</span>
                <button type="button" className="btn lwb-btn-compact" disabled={!confirmedDelivery} onClick={correctDirection}>Flip the direction</button>
              </div>
              <div className="lwb-trouble-item">
                <span>Red isn’t on the strip’s last LED</span>
                <div className="lw-bench-count-adjust">
                  <button type="button" className="lw-bench-nudge" aria-label={`Remove one LED from ${activeLabel}`} disabled={!confirmedDelivery || !adjustableRunIds.includes(activeStep.runId) || activeStep.count <= 1} onClick={() => adjustBoundary(-1)}>−</button>
                  <strong data-testid="active-run-count">{activeStep.count} LEDs</strong>
                  <button type="button" className="lw-bench-nudge" aria-label={`Add one LED to ${activeLabel}`} disabled={!confirmedDelivery || !adjustableRunIds.includes(activeStep.runId)} onClick={() => adjustBoundary(1)}>+</button>
                </div>
              </div>
              <p className="lwb-detail">Blue and red set the artwork mapping; electrical data direction does not change.</p>
            </>
          )}
          {kind === 'output' && (
            <>
              <div className="lwb-trouble-item">
                <span>Red isn’t on this wire’s last LED</span>
                <div className="lw-bench-count-adjust">
                  <button type="button" className="lw-bench-nudge" aria-label={`Remove one LED from ${activeOutputLabel}`} disabled={!confirmedDelivery || !adjustableOutputIds.includes(activeStep.outputId) || activeStep.count <= 1} onClick={() => adjustOutput(-1)}>−</button>
                  <strong data-testid="active-output-count">{activeStep.count} LEDs</strong>
                  <button type="button" className="lw-bench-nudge" aria-label={`Add one LED to ${activeOutputLabel}`} disabled={!confirmedDelivery || !adjustableOutputIds.includes(activeStep.outputId)} onClick={() => adjustOutput(1)}>+</button>
                </div>
              </div>
              <p className="lwb-detail">GPIO {activeStep.pin} · Move red to this wire’s final LED.</p>
            </>
          )}
          {(kind === 'cable' || kind === 'inactive') && (
            <p className="lwb-trouble-note">If something else looks off, use Back to re-check the previous step, or choose Do this later and fix the mapping first.</p>
          )}
        </div>
      )}
      <div className="lwb-nav">
        <button type="button" className="btn btn-ghost" disabled={state.stepIndex === 0} onClick={() => dispatch({ type: 'previous' })}>Back</button>
        <button type="button" className="btn btn-ghost" disabled={state.stepIndex === state.steps.length - 1} onClick={() => dispatch({ type: 'next' })}>Skip</button>
        <button type="button" className="btn btn-ghost" onClick={cancel}>Do this later</button>
        <button type="button" className="btn primary" disabled={!state.canComplete} onClick={complete}>Finish</button>
      </div>
    </section>
  );
}
