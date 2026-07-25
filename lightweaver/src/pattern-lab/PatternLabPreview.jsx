import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PATTERN_LAB_WORKER_BUDGETS,
  quantizePatternLabWorkerTime,
} from '../lib/patternLabWorkerProtocol.js';
import { resolvePatternLabControls } from '../lib/patternLabControls.js';
import { createPatternLabPreviewSession } from '../lib/patternLabPreviewSession.js';
import { PatternPreview } from '../v3/PatternPreview.jsx';
import usePatternLabWorker from './usePatternLabWorker.js';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

const INTERACTION_SETTLE_MS = 180;

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
}) {
  const physicalSessionRef = useRef(null);
  const [physicalPreview, setPhysicalPreview] = useState({ state: 'idle', active: false, error: null });
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
  const workerSampleLimit = workerMode === 'preview'
    ? PATTERN_LAB_WORKER_BUDGETS.previewSamples
    : PATTERN_LAB_WORKER_BUDGETS.finalSamples;

  useEffect(() => {
    if (physicalPreview.active && physicalPixels) physicalSessionRef.current?.push(physicalPixels);
  }, [physicalPixels, physicalPreview.active]);

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
    const session = createPatternLabPreviewSession({
      fallbackLook,
      onStateChange: setPhysicalPreview,
    });
    physicalSessionRef.current = session;
    try {
      await session.start(physicalPixels);
    } catch (error) {
      setPhysicalPreview({ state: 'error', active: false, error });
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
      data-worker-error={worker.error?.message ?? undefined}
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
          glow={clamp(1.4 - controls.texture * 0.72, 0.5, 1.4)}
          dotSize={clamp(3.25 - controls.shapeScale * 0.5 + controls.texture * 0.18, 1.5, 3.3)}
          targetFps={thumbnail ? 8 : PATTERN_LAB_WORKER_BUDGETS.previewFps}
        />
      ) : (
        <div
          className="plab-preview-preparing"
          data-testid="pattern-lab-preparing"
          role={thumbnail ? undefined : 'status'}
        >
          {!thumbnail && 'Preparing accurate preview…'}
        </div>
      )}
      {!thumbnail && (
        <div
          className="plab-live-preview"
          data-state={physicalPreview.state}
          data-preview-error={physicalPreview.error?.message || undefined}
        >
          <button
            type="button"
            className="plab-live-preview-action"
            aria-pressed={physicalPreview.active}
            disabled={!physicalPixels || ['starting', 'stopping'].includes(physicalPreview.state)}
            onClick={togglePhysicalPreview}
          >
            {physicalPreview.active ? 'Stop preview' : physicalPreview.state === 'starting' ? 'Connecting…' : 'Preview on Lights'}
          </button>
          <span role="status" aria-live="polite">
            {physicalPreview.active
              ? 'Live · Stop restores the previous card look'
              : physicalPreview.state === 'restored'
                ? 'Previous card look restored'
                : physicalPreview.state === 'superseded'
                  ? 'Control moved to another Lightweaver screen'
                : physicalPreview.state === 'error'
                  ? physicalPreview.restored
                    ? 'Could not preview · previous card look restored'
                    : 'Could not restore the previous card look'
                  : 'Opt-in · your lights stay unchanged'}
          </span>
        </div>
      )}
    </div>
  );
}
