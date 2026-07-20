import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PATTERN_LAB_WORKER_BUDGETS,
  quantizePatternLabWorkerTime,
} from '../lib/patternLabWorkerProtocol.js';
import { resolvePatternLabMacros } from '../lib/patternLabMacros.js';
import { sampleEvolution } from '../lib/patternLabEvolution.js';
import { createPatternLabPreviewSession } from '../lib/patternLabPreviewSession.js';
import { PatternPreview } from '../v3/PatternPreview.jsx';
import usePatternLabWorker from './usePatternLabWorker.js';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mix(from, to, amount) {
  return from + (to - from) * amount;
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
  const macros = resolvePatternLabMacros(recipe);
  const evolutionRecipe = seedPreview && !recipe.evolution.enabled
    ? { ...recipe, evolution: { ...recipe.evolution, enabled: true } }
    : recipe;
  const renderTime = seedPreview
    ? evolutionRecipe.evolution.durationSeconds / 2
    : previewTime;
  const evolution = evolutionRecipe.evolution.enabled
    ? sampleEvolution(evolutionRecipe, renderTime)
    : null;
  const evolutionMix = evolution?.change ?? 0;
  const destinations = evolution?.destinations;

  const speed = clamp(mix(
    macros.movement.speedMultiplier,
    0.4 + (destinations?.movement ?? 0.5) * 2.1,
    evolutionMix,
  ), 0.1, 3);
  const brightness = clamp(mix(
    macros.energy.brightness,
    Math.min(macros.energy.brightness, destinations?.brightness ?? macros.energy.brightness),
    evolutionMix,
  ), 0.08, 1);
  const saturation = clamp(mix(
    macros.color.saturation,
    0.55 + (destinations?.color ?? 0.5) * 0.45,
    evolutionMix,
  ), 0.25, 1);
  const hueShift = macros.color.warmth * 18
    + ((destinations?.color ?? 0.5) - 0.5) * 72 * evolutionMix;
  const shapeScale = mix(
    macros.shape.spatialScale,
    0.5 + (destinations?.shape ?? 0.5) * 2,
    evolutionMix,
  );
  const texture = mix(
    macros.texture.crispness,
    destinations?.texture ?? macros.texture.crispness,
    evolutionMix,
  );
  const renderOptions = useMemo(() => ({
    masterSpeed: speed,
    masterBrightness: brightness,
    masterSaturation: saturation,
    masterHueShift: hueShift,
  }), [brightness, hueShift, saturation, speed]);
  const workerMode = useSettledWorkerMode({
    playing,
    recipe: evolutionRecipe,
    time: renderTime,
    renderOptions,
  });
  const workerTime = quantizePatternLabWorkerTime(renderTime, workerMode);
  const worker = usePatternLabWorker({
    recipe: evolutionRecipe,
    geometry,
    time: workerTime,
    mode: workerMode,
    renderOptions,
    enabled: !thumbnail,
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
      data-worker-available={thumbnail ? 'false' : String(worker.available)}
      data-worker-state={thumbnail ? 'static' : worker.status}
      data-worker-request-id={worker.requestId ?? undefined}
      data-worker-frame-id={worker.frameRequestId ?? undefined}
      data-worker-sample-limit={workerSampleLimit}
      data-worker-error={worker.error?.message ?? undefined}
    >
      <PatternPreview
        patternId={patternId}
        playing={playing}
        controlledTime={renderTime}
        compiledFn={workerFunction}
        params={recipe.base.params}
        palette={recipe.palette}
        strips={displayGeometry.strips}
        viewBox={displayGeometry.viewBox}
        svgText={displayGeometry.svgText}
        hidden={displayGeometry.hidden}
        bpm={displayGeometry.bpm}
        masterSpeed={workerFunction ? 1 : speed}
        masterBrightness={workerFunction ? 1 : brightness}
        masterSaturation={workerFunction ? 1 : saturation}
        masterHueShift={workerFunction ? 0 : hueShift}
        gammaEnabled={workerFunction ? false : displayGeometry.gammaEnabled}
        gammaValue={displayGeometry.gammaValue}
        symSettings={workerFunction ? null : displayGeometry.symSettings}
        audioBands={workerFunction ? null : displayGeometry.audioBands}
        motionSmoothing={thumbnail ? 'off' : geometry.motionSmoothing}
        glow={clamp(1.4 - texture * 0.72, 0.5, 1.4)}
        dotSize={clamp(3.25 - shapeScale * 0.5 + texture * 0.18, 1.5, 3.3)}
        targetFps={thumbnail ? 8 : PATTERN_LAB_WORKER_BUDGETS.previewFps}
      />
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
