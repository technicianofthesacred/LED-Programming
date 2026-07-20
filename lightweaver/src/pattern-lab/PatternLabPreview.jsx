import { useMemo } from 'react';
import { compilePattern } from '../lib/frameEngine.js';
import { resolvePatternLabMacros } from '../lib/patternLabMacros.js';
import { sampleEvolution } from '../lib/patternLabEvolution.js';
import { PatternPreview } from '../v3/PatternPreview.jsx';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export default function PatternLabPreview({ recipe, previewTime, playing, geometry }) {
  const patternId = recipe.base.patternId;
  const baseFunction = useMemo(() => compilePattern(patternId), [patternId]);
  const previewFunction = useMemo(() => {
    if (!baseFunction) return null;
    return (...args) => {
      const shifted = [...args];
      shifted[3] = (Number(shifted[3]) || 0) + previewTime;
      shifted[4] = ((Number(shifted[4]) || 0) + previewTime / 65.536) % 1;
      return baseFunction(...shifted);
    };
  }, [baseFunction, previewTime]);

  const macros = resolvePatternLabMacros(recipe);
  const evolution = recipe.evolution.enabled ? sampleEvolution(recipe, previewTime) : null;
  const evolutionMix = evolution?.change ?? 0;
  const speed = clamp(
    macros.movement.speedMultiplier * (1 - evolutionMix + (evolution?.destinations.movement ?? 1) * evolutionMix),
    0.1,
    3,
  );
  const brightness = clamp(
    macros.energy.brightness * (evolution?.destinations.brightness ?? 1),
    0.08,
    1,
  );

  return (
    <div className="plab-mapped-preview" data-testid="pattern-lab-mapped-preview">
      <PatternPreview
        patternId={patternId}
        playing={playing}
        compiledFn={previewFunction}
        params={recipe.base.params}
        palette={recipe.palette}
        strips={geometry.strips}
        viewBox={geometry.viewBox}
        svgText={geometry.svgText}
        hidden={geometry.hidden}
        bpm={geometry.bpm}
        masterSpeed={speed}
        masterBrightness={brightness}
        masterSaturation={clamp(macros.color.saturation, 0, 1)}
        masterHueShift={macros.color.warmth * 18}
        gammaEnabled={geometry.gammaEnabled}
        gammaValue={geometry.gammaValue}
        symSettings={geometry.symSettings}
        audioBands={geometry.audioBands}
        motionSmoothing={geometry.motionSmoothing}
        glow={clamp(1.4 - macros.texture.crispness * 0.65, 0.55, 1.4)}
        dotSize={clamp(3.1 - macros.shape.spatialScale * 0.45, 1.7, 3.2)}
        targetFps={30}
      />
    </div>
  );
}
