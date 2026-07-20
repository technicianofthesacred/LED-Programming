import { PATTERN_LAB_BLEND_MODES } from '../lib/patternLabCompositor.js';
import { PATTERN_LAB_MAX_LAYERS } from '../lib/patternLabRecipe.js';

const BLEND_LABELS = {
  normal: 'Normal',
  add: 'Add',
  screen: 'Screen',
  multiply: 'Multiply',
  lighten: 'Lighten',
  mask: 'Mask',
};

function moveLayer(layers, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= layers.length) return layers;
  const next = [...layers];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export default function PatternLabLayers({
  layers = [],
  disabled = false,
  onAddLayer,
  onLayersChange,
}) {
  const safeLayers = Array.isArray(layers) ? layers : [];
  const canAdd = !disabled && safeLayers.length < PATTERN_LAB_MAX_LAYERS;

  function commit(nextLayers) {
    if (nextLayers.length > PATTERN_LAB_MAX_LAYERS) {
      throw new RangeError(`Pattern Lab supports at most ${PATTERN_LAB_MAX_LAYERS} layers`);
    }
    onLayersChange?.(nextLayers);
  }

  function updateLayer(index, changes) {
    commit(safeLayers.map((layer, layerIndex) => (
      layerIndex === index ? { ...layer, ...changes } : layer
    )));
  }

  return (
    <details className="plab-advanced plab-layers" data-testid="pattern-lab-layers">
      <summary>
        Layers
        <span aria-label="Layer count">{safeLayers.length}/{PATTERN_LAB_MAX_LAYERS}</span>
      </summary>

      <div className="plab-layer-stack">
        {safeLayers.length === 0 ? (
          <p>The base pattern is complete on its own. Add a layer only when the look needs it.</p>
        ) : safeLayers.map((layer, index) => (
          <fieldset className="plab-layer" key={layer.id || `layer-${index}`} disabled={disabled}>
            <legend>{layer.name || `Layer ${index + 1}`}</legend>
            <div className="plab-position-buttons" role="group" aria-label={`Reorder ${layer.name || `layer ${index + 1}`}`}>
              <button
                type="button"
                className="btn"
                disabled={index === 0}
                onClick={() => commit(moveLayer(safeLayers, index, -1))}
              >Up</button>
              <button
                type="button"
                className="btn"
                disabled={index === safeLayers.length - 1}
                onClick={() => commit(moveLayer(safeLayers, index, 1))}
              >Down</button>
              <button
                type="button"
                className="btn"
                onClick={() => commit(safeLayers.filter((_, layerIndex) => layerIndex !== index))}
              >Remove</button>
            </div>

            <label className="plab-field">
              <span>Blend mode</span>
              <select
                value={layer.blendMode || 'normal'}
                onChange={event => updateLayer(index, { blendMode: event.target.value })}
              >
                {PATTERN_LAB_BLEND_MODES.map(mode => (
                  <option key={mode} value={mode}>{BLEND_LABELS[mode]}</option>
                ))}
              </select>
            </label>

            <label className="plab-macro">
              <span className="plab-macro-label">
                <strong>Opacity</strong>
                <output>{Math.round((layer.opacity ?? 1) * 100)}%</output>
              </span>
              <input
                aria-label={`${layer.name || `Layer ${index + 1}`} opacity`}
                type="range"
                min="0"
                max="100"
                value={Math.round((layer.opacity ?? 1) * 100)}
                onChange={event => updateLayer(index, { opacity: Number(event.target.value) / 100 })}
              />
            </label>
          </fieldset>
        ))}

        <button type="button" className="btn" disabled={!canAdd} onClick={() => onAddLayer?.()}>
          {safeLayers.length >= PATTERN_LAB_MAX_LAYERS ? 'Three-layer limit reached' : 'Add layer'}
        </button>
      </div>
    </details>
  );
}
