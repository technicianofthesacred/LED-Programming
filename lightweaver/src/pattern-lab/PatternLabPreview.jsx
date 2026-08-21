import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PATTERN_LAB_WORKER_BUDGETS,
  quantizePatternLabWorkerTime,
} from '../lib/patternLabWorkerProtocol.js';
import { resolvePatternLabControls } from '../lib/patternLabControls.js';
import { createPatternLabPreviewSession } from '../lib/patternLabPreviewSession.js';
import { PatternPreview } from '../v3/PatternPreview.jsx';
import usePatternLabWorker from './usePatternLabWorker.js';
import { useCardStatus } from '../hooks/useCardStatus.js';

const INTERACTION_SETTLE_MS = 180;

// Fixed look for the mapped preview. These used to be driven by the Shape and
// Texture macros, which reached nothing else — the sliders are gone and so is
// the pretend destination. The values are exactly what the old formulas produced
// at the default macros of 0.5 (shapeScale 1.5, texture 0.5):
//   glow    = 1.4 - texture * 0.72              = 1.04
//   dotSize = 3.25 - shapeScale * 0.5 + texture * 0.18 = 2.59
const PREVIEW_GLOW = 1.04;
const PREVIEW_DOT_SIZE = 2.59;

const PREVIEW_FAILURES = {
  'no-lights': {
    message: 'This piece has no lights mapped yet. Draw a strip over the artwork, then come back and it will light up here.',
    retryLabel: 'Check again',
  },
  timeout: {
    message: 'The preview is taking too long to draw. It should catch up on its own — start it again if it stays stuck.',
    retryLabel: 'Start preview again',
  },
  'worker-error': {
    message: 'The preview stopped unexpectedly. Nothing you made was lost — start it again.',
    retryLabel: 'Start preview again',
  },
  geometry: {
    message: 'The preview stopped unexpectedly. Nothing you made was lost — start it again.',
    retryLabel: 'Start preview again',
  },
  'pattern-too-heavy': {
    message: 'This pattern is too heavy to draw here — the preview stopped twice trying. Try it once more, or pick a different pattern to keep going.',
    retryLabel: 'Try this pattern once more',
  },
  'pattern-unrenderable': {
    message: 'This pattern cannot be drawn on this piece. It never finished a single frame, so the preview has stopped rather than keep your device busy. Pick a different pattern to keep going.',
    retryLabel: null,
  },
  unsupported: {
    message: 'This browser cannot show the live preview. Open Lightweaver in Chrome, Edge, or Safari to see the piece move.',
    retryLabel: null,
  },
};

// The two failures that mean the pattern has STOPPED, not that it is merely slow.
// Everything else on this screen recovers by itself; these two do not, and while
// the owner is streaming to his piece they are the only states where the wall
// stops changing. They are what the rollback below is keyed on.
const TERMINAL_WORKER_FAILURES = new Set(['pattern-too-heavy', 'pattern-unrenderable']);

// The headline "put this on your lights" action needs one honest sentence for
// every state an owner can land in — never a silently-disabled button. Each
// entry here is plain language: no "physical pixels", "frames", "socket", or
// "endpoint". `disabled` says whether the button itself should be pressable
// in that state (streaming is always stoppable, everything else needs the
// pattern actually ready to send).
function describeLivePreviewState({ physicalPreview, cardConnected, cardChecking, hasRenderedFrame, noLightsMapped, hasPixels, patternGaveUp = false }) {
  if (physicalPreview.active) {
    return {
      key: 'streaming',
      label: 'Stop preview',
      caption: 'Live on your lights · Stop restores what they were doing before.',
      disabled: false,
    };
  }
  if (physicalPreview.state === 'starting') {
    return {
      key: 'starting',
      label: 'Connecting…',
      caption: 'Connecting to your card…',
      disabled: true,
    };
  }
  if (physicalPreview.state === 'stopping') {
    return {
      key: 'stopping',
      label: 'Stopping…',
      caption: 'Stopping · restoring what your lights were doing before.',
      disabled: true,
    };
  }
  // The pattern stopped drawing while it was live on the piece. Silence is the one
  // thing that is not allowed here: the card holds the last frame it was sent (its
  // 2 s watchdog never fires, because the streamer keeps re-sending that frame), so
  // a frozen piece looks exactly like a working one that happens to be still. The
  // session is therefore rolled back to the look the piece had before the preview
  // started — a look the card plays on its own, so the artwork keeps living — and
  // the screen says which of the two actually happened.
  if (patternGaveUp && physicalPreview.state === 'restored') {
    return {
      key: 'pattern-stopped-restored',
      label: 'Preview on Lights',
      caption: 'This pattern stopped drawing, so your lights went back to what they were showing before. Pick another pattern to put it on them again.',
      disabled: !hasPixels || !cardConnected,
    };
  }
  if (patternGaveUp) {
    return {
      key: 'pattern-stopped-frozen',
      label: 'Preview on Lights',
      caption: 'This pattern stopped drawing and your lights may still be holding its last frame — check the piece. Pick another pattern to start it moving again.',
      disabled: !hasPixels || !cardConnected,
    };
  }
  if (physicalPreview.state === 'restored') {
    return {
      key: 'restored',
      label: 'Preview on Lights',
      caption: 'Stopped · previous card look restored.',
      disabled: !hasPixels || !cardConnected,
    };
  }
  if (physicalPreview.state === 'superseded') {
    return {
      key: 'superseded',
      label: 'Preview on Lights',
      caption: 'Control moved to another Lightweaver screen.',
      disabled: !hasPixels || !cardConnected,
    };
  }
  if (physicalPreview.state === 'error') {
    // `restored` is only meaningful once a session actually reached the card.
    // A start that never connected leaves it undefined — nothing was changed,
    // so say that plainly instead of implying a failed restore.
    if (physicalPreview.restored === true) {
      return {
        key: 'dropped-restored',
        label: 'Preview on Lights',
        caption: 'The connection dropped · your lights are back to normal. Try again.',
        disabled: !hasPixels || !cardConnected,
      };
    }
    if (physicalPreview.restored === false) {
      return {
        key: 'dropped-not-restored',
        label: 'Preview on Lights',
        caption: 'The connection dropped and your lights may still be showing the preview. Try again, or check them.',
        disabled: !hasPixels || !cardConnected,
      };
    }
    return {
      key: 'start-failed',
      label: 'Preview on Lights',
      caption: 'Couldn’t reach your lights · nothing changed. Try again.',
      disabled: !hasPixels || !cardConnected,
    };
  }
  if (noLightsMapped) {
    return {
      key: 'no-lights',
      label: 'Preview on Lights',
      caption: 'This piece has no lights mapped yet — map a strip, then you can preview it here.',
      disabled: true,
    };
  }
  if (!hasRenderedFrame) {
    return {
      key: 'preparing',
      label: 'Preview on Lights',
      caption: 'Preparing your pattern…',
      disabled: true,
    };
  }
  if (!cardConnected) {
    return {
      key: 'no-card',
      label: 'Preview on Lights',
      caption: cardChecking
        ? 'Looking for your Lightweaver card…'
        : 'No card connected yet — connect your Lightweaver card to this Wi-Fi to preview here.',
      disabled: true,
    };
  }
  if (!hasPixels) {
    return {
      key: 'no-lights',
      label: 'Preview on Lights',
      caption: 'This piece has no lights mapped yet — map a strip, then you can preview it here.',
      disabled: true,
    };
  }
  return {
    key: 'ready',
    label: 'Preview on Lights',
    caption: 'Put this pattern on your lights — nothing changes until you press play.',
    disabled: false,
  };
}

function useSettledWorkerMode({ playing, recipe, time, renderOptions }) {
  const [settled, setSettled] = useState(() => ({ recipe, time, renderOptions }));
  const changed = settled.recipe !== recipe
    || settled.time !== time
    || settled.renderOptions !== renderOptions;

  useEffect(() => {
    if (playing) return undefined;
    const timeout = setTimeout(() => {
      setSettled({ recipe, time, renderOptions });
    }, INTERACTION_SETTLE_MS);
    return () => clearTimeout(timeout);
  }, [playing, recipe, renderOptions, time]);

  return playing || changed ? 'preview' : 'final';
}

function workerColorLookup(frame) {
  if (!frame?.colors?.length || !frame?.indices?.length) return null;
  const { colors, indices } = frame;
  return index => {
    let low = 0;
    let high = indices.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (indices[middle] < index) low = middle + 1;
      else high = middle;
    }
    let selected = low;
    if (selected > 0 && Math.abs(indices[selected - 1] - index) <= Math.abs(indices[selected] - index)) {
      selected -= 1;
    }
    return {
      r: colors[selected * 3],
      g: colors[selected * 3 + 1],
      b: colors[selected * 3 + 2],
    };
  };
}

function byteHex(value) {
  return Math.max(0, Math.min(255, Number(value) || 0)).toString(16).padStart(2, '0').toUpperCase();
}

export function patternLabFrameToCardPixels(frame) {
  const total = Number(frame?.totalSamples);
  const lookup = workerColorLookup(frame);
  if (!lookup || !Number.isSafeInteger(total) || total < 1) return null;
  return Array.from({ length: total }, (_, index) => {
    const color = lookup(index);
    return `${byteHex(color.r)}${byteHex(color.g)}${byteHex(color.b)}`;
  });
}

export default function PatternLabPreview({
  recipe,
  previewTime,
  playing = false,
  geometry,
  thumbnail = false,
  seedPreview = false,
  fallbackLook = {},
  onRenderStatus = null,
}) {
  const physicalSessionRef = useRef(null);
  const onRenderStatusRef = useRef(onRenderStatus);
  onRenderStatusRef.current = onRenderStatus;
  const [physicalPreview, setPhysicalPreview] = useState({ state: 'idle', active: false, error: null });
  const [patternGaveUpLive, setPatternGaveUpLive] = useState(false);
  // Card presence is only relevant to the headline "put this on your lights"
  // action, so thumbnails (which never render that control) skip the network
  // polling entirely.
  const cardStatus = useCardStatus({ enabled: !thumbnail });
  const patternId = recipe.base.patternId;
  const evolutionRecipe = useMemo(() => seedPreview && !recipe.evolution.enabled
    ? { ...recipe, evolution: { ...recipe.evolution, enabled: true } }
    : recipe, [recipe, seedPreview]);
  const timelineTime = seedPreview
    ? evolutionRecipe.evolution.durationSeconds / 2
    : previewTime;
  const controls = useMemo(
    () => resolvePatternLabControls(evolutionRecipe, timelineTime),
    [evolutionRecipe, timelineTime],
  );
  const renderOptions = useMemo(() => ({
    masterSpeed: 1,
    masterBrightness: controls.effectiveBrightness,
    masterSaturation: controls.masterSaturation,
    masterHueShift: controls.masterHueShift,
    motionWeights: controls.motionWeights,
  }), [controls]);
  const settledWorkerMode = useSettledWorkerMode({
    playing,
    recipe: evolutionRecipe,
    time: controls.renderTime,
    renderOptions,
  });
  const workerMode = thumbnail ? 'preview' : settledWorkerMode;
  const workerTime = quantizePatternLabWorkerTime(controls.renderTime, workerMode);
  const worker = usePatternLabWorker({
    recipe: evolutionRecipe,
    geometry,
    time: workerTime,
    mode: workerMode,
    renderOptions,
    enabled: true,
  });
  const workerFunction = useMemo(() => workerColorLookup(worker.frame), [worker.frame]);
  const physicalPixels = useMemo(() => patternLabFrameToCardPixels(worker.frame), [worker.frame]);
  const displayGeometry = useMemo(() => {
    if (!workerFunction) return geometry;
    return {
      ...geometry,
      strips: geometry.strips.map(strip => ({
        ...strip,
        patternId: null,
        speed: 1,
        brightness: 1,
        hueShift: 0,
      })),
    };
  }, [geometry, workerFunction]);
  const failure = useMemo(() => {
    if (!worker.failure) return null;
    const copy = PREVIEW_FAILURES[worker.failure] || PREVIEW_FAILURES['worker-error'];
    return { key: worker.failure, ...copy };
  }, [worker.failure]);
  // Report the mode actually SERVED, not the one requested. A degraded worker is
  // forced down to the preview budget, and this same frame is what gets pushed to a
  // physical card — claiming 1024 samples for a 384-sample frame would be a lie in
  // the DOM and on the piece.
  const servedWorkerMode = worker.degraded ? 'preview' : workerMode;
  const workerSampleLimit = servedWorkerMode === 'preview'
    ? PATTERN_LAB_WORKER_BUDGETS.previewSamples
    : PATTERN_LAB_WORKER_BUDGETS.finalSamples;

  useEffect(() => {
    if (physicalPreview.active && physicalPixels) physicalSessionRef.current?.push(physicalPixels);
  }, [physicalPixels, physicalPreview.active]);

  // Tell the screen the moment this pattern has actually drawn something (or has
  // failed), so the tile the owner tapped can stop showing itself as working.
  // Reported through a ref so a caller passing an inline arrow does not re-fire it.
  const hasRenderedFrame = Boolean(workerFunction);
  useEffect(() => {
    onRenderStatusRef.current?.({ hasFrame: hasRenderedFrame, failure: worker.failure ?? null });
  }, [hasRenderedFrame, worker.failure]);

  // The pattern gave up while it was live on the piece. Stop the stream and let the
  // session's existing rollback put the card back on the look it had before — see
  // describeLivePreviewState above for why holding the frozen frame in silence is
  // the one option that is not honest.
  useEffect(() => {
    if (!worker.failure || !TERMINAL_WORKER_FAILURES.has(worker.failure)) return;
    if (!physicalPreview.active) return;
    const session = physicalSessionRef.current;
    if (!session) return;
    physicalSessionRef.current = null;
    setPatternGaveUpLive(true);
    void session.stop('pattern-gave-up').catch(() => {});
  }, [physicalPreview.active, worker.failure]);

  useEffect(() => () => {
    const session = physicalSessionRef.current;
    physicalSessionRef.current = null;
    if (session) void session.stop('unmount').catch(() => {});
  }, []);

  async function togglePhysicalPreview() {
    if (physicalPreview.active) {
      await physicalSessionRef.current?.stop('user').catch(() => {});
      physicalSessionRef.current = null;
      return;
    }
    if (!physicalPixels) return;
    setPatternGaveUpLive(false);
    const session = createPatternLabPreviewSession({
      fallbackLook,
      onStateChange: setPhysicalPreview,
    });
    physicalSessionRef.current = session;
    try {
      await session.start(physicalPixels);
    } catch (error) {
      // The session's own onStateChange already ran its rollback and reported
      // whether the restore succeeded (physicalPreview.restored). Overwriting
      // that here with a fresh object would silently drop it and make every
      // start-failure read as "could not restore" even when nothing was ever
      // touched — merge instead of replacing.
      setPhysicalPreview(prev => ({ ...prev, state: 'error', active: false, error }));
    }
  }

  return (
    <div
      className={`plab-mapped-preview${thumbnail ? ' plab-mapped-preview-thumbnail' : ''}`}
      data-testid={thumbnail ? 'pattern-lab-variation-preview' : 'pattern-lab-mapped-preview'}
      aria-hidden={thumbnail ? 'true' : undefined}
      data-worker-available={String(worker.available)}
      data-worker-state={worker.status}
      data-worker-request-id={worker.requestId ?? undefined}
      data-worker-frame-id={worker.frameRequestId ?? undefined}
      data-worker-sample-limit={workerSampleLimit}
      data-worker-served-mode={servedWorkerMode}
      data-worker-degraded={worker.degraded ? 'true' : undefined}
      data-worker-error={worker.error?.message ?? undefined}
      data-worker-failure={worker.failure ?? undefined}
    >
      {workerFunction ? (
        <PatternPreview
          patternId={patternId}
          playing={playing}
          controlledTime={controls.renderTime}
          compiledFn={workerFunction}
          params={recipe.base.params}
          palette={recipe.palette}
          strips={displayGeometry.strips}
          viewBox={displayGeometry.viewBox}
          svgText={displayGeometry.svgText}
          hidden={displayGeometry.hidden}
          bpm={displayGeometry.bpm}
          masterSpeed={1}
          masterBrightness={1}
          masterSaturation={1}
          masterHueShift={0}
          gammaEnabled={false}
          gammaValue={displayGeometry.gammaValue}
          symSettings={null}
          audioBands={null}
          motionSmoothing={thumbnail ? 'off' : geometry.motionSmoothing}
          glow={PREVIEW_GLOW}
          dotSize={PREVIEW_DOT_SIZE}
          targetFps={thumbnail ? 8 : PATTERN_LAB_WORKER_BUDGETS.previewFps}
        />
      ) : null}
      {workerFunction && failure && !thumbnail ? (
        <div
          className="plab-preview-preparing plab-preview-notice"
          data-testid="pattern-lab-preview-notice"
          data-failure={failure.key}
          role="status"
        >
          <p className="plab-preview-preparing-message">{failure.message}</p>
          {failure.retryLabel && (
            <button
              type="button"
              className="plab-preview-retry"
              data-testid="pattern-lab-preview-retry"
              onClick={() => worker.retry()}
            >
              {failure.retryLabel}
            </button>
          )}
        </div>
      ) : null}
      {!workerFunction ? (
        <div
          className="plab-preview-preparing"
          data-testid="pattern-lab-preparing"
          data-failure={failure?.key || undefined}
          role={thumbnail ? undefined : 'status'}
        >
          {!thumbnail && (failure ? (
            <>
              <p className="plab-preview-preparing-message">{failure.message}</p>
              {failure.retryLabel && (
                <button
                  type="button"
                  className="plab-preview-retry"
                  data-testid="pattern-lab-preview-retry"
                  onClick={() => worker.retry()}
                >
                  {failure.retryLabel}
                </button>
              )}
            </>
          ) : 'Warming up the preview…')}
        </div>
      ) : null}
      {!thumbnail && (() => {
        const live = describeLivePreviewState({
          physicalPreview,
          cardConnected: cardStatus.connected,
          cardChecking: cardStatus.checking,
          hasRenderedFrame,
          noLightsMapped: failure?.key === 'no-lights',
          hasPixels: Boolean(physicalPixels),
          patternGaveUp: patternGaveUpLive,
        });
        // Test fixture note: this component's own copy for the "restored"
        // state must keep the literal substring "Previous card look
        // restored" — tests/pattern-lab-live-preview.spec.ts asserts on it
        // verbatim and is owned by another agent in this rebuild.
        const statusText = live.key === 'restored'
          ? 'Previous card look restored'
          : live.caption;
        return (
          <div
            className="plab-live-preview plab-live-preview-headline"
            data-state={physicalPreview.state}
            data-live-state={live.key}
            data-preview-error={physicalPreview.error?.message || undefined}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 4,
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '16px',
              background: 'linear-gradient(to top, rgba(0,0,0,0.7), rgba(0,0,0,0))',
            }}
          >
            <button
              type="button"
              className="plab-live-preview-action"
              aria-pressed={physicalPreview.active}
              disabled={live.disabled}
              onClick={togglePhysicalPreview}
              style={{
                width: '100%',
                minHeight: '52px',
                fontSize: '16px',
                fontWeight: 700,
              }}
            >
              {live.label}
            </button>
            <span role="status" aria-live="polite">
              {statusText}
            </span>
          </div>
        );
      })()}
    </div>
  );
}
