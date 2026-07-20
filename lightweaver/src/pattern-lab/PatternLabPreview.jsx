import { resolvePatternLabMacros } from '../lib/patternLabMacros.js';
import { sampleEvolution } from '../lib/patternLabEvolution.js';
import { PatternPreview } from '../v3/PatternPreview.jsx';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mix(from, to, amount) {
  return from + (to - from) * amount;
}

export default function PatternLabPreview({ recipe, previewTime, playing = false, geometry, thumbnail = false }) {
  const patternId = recipe.base.patternId;
  const macros = resolvePatternLabMacros(recipe);
  const evolution = recipe.evolution.enabled ? sampleEvolution(recipe, previewTime) : null;
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

  return (
    <div
      className={`plab-mapped-preview${thumbnail ? ' plab-mapped-preview-thumbnail' : ''}`}
      data-testid={thumbnail ? 'pattern-lab-variation-preview' : 'pattern-lab-mapped-preview'}
      aria-hidden={thumbnail ? 'true' : undefined}
    >
      <PatternPreview
        patternId={patternId}
        playing={playing}
        controlledTime={previewTime}
        params={recipe.base.params}
        palette={recipe.palette}
        strips={geometry.strips}
        viewBox={geometry.viewBox}
        svgText={geometry.svgText}
        hidden={geometry.hidden}
        bpm={geometry.bpm}
        masterSpeed={speed}
        masterBrightness={brightness}
        masterSaturation={saturation}
        masterHueShift={hueShift}
        gammaEnabled={geometry.gammaEnabled}
        gammaValue={geometry.gammaValue}
        symSettings={geometry.symSettings}
        audioBands={geometry.audioBands}
        motionSmoothing={thumbnail ? 'off' : geometry.motionSmoothing}
        glow={clamp(1.4 - texture * 0.72, 0.5, 1.4)}
        dotSize={clamp(3.25 - shapeScale * 0.5 + texture * 0.18, 1.5, 3.3)}
        targetFps={thumbnail ? 8 : 30}
      />
    </div>
  );
}
