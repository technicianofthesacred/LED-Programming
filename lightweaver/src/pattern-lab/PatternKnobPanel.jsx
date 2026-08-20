import { useState } from 'react';
import { parseParamsFromCode } from '../lib/patternParams.js';
import { HIDDEN_PARAM_NAMES, resolveParamLabel } from '../lib/patternParamLabels.js';

// Progressive-disclosure budget for per-pattern knobs (plan §5: "a calm
// first screen"). Verified against every pattern in the library
// (extract_params.mjs, run during this pass): after HIDDEN_PARAM_NAMES is
// applied, 108 of 110 knob-bearing patterns declare 3 or fewer knobs and
// need no "more" affordance at all; only two (snow-globe, lissajous-v2)
// declare 4. A budget of 3 therefore shows everything for the overwhelming
// majority and hides exactly one extra knob on the two outliers — enough to
// keep the panel calm without hiding anything that matters on the common
// case.
const VISIBLE_KNOB_BUDGET = 3;

function formatKnobValue(value, min, max) {
  const range = max - min;
  const decimals = range <= 1 ? 3 : range <= 10 ? 2 : 0;
  return Number(value).toFixed(decimals);
}

/**
 * Renders the selected pattern's own `@param`-declared knobs, below the
 * universal controls. These are the "honest depth" controls from
 * todo/plans/patternlab-rebuild.md §5 — real per-pattern parameters the
 * render engine (frameEngine.js `resolvePatternParams`) already reads from
 * `recipe.base.params`, wired end-to-end for the first time here.
 *
 * Renders nothing when the pattern declares no visible knobs (either it has
 * no `@param` lines, or its only one is the hidden universal-duplicate
 * `speed` — see patternParamLabels.js for why that's hidden) — an empty
 * section is exactly the failure the "don't overwhelm" budget exists to
 * prevent.
 */
export default function PatternKnobPanel({ patternId, code, params, onParamChange }) {
  const [expanded, setExpanded] = useState(false);

  const declared = parseParamsFromCode(code).filter(param => !HIDDEN_PARAM_NAMES.has(param.name));
  if (!declared.length) return null;

  const visible = expanded ? declared : declared.slice(0, VISIBLE_KNOB_BUDGET);
  const hiddenCount = declared.length - visible.length;

  return (
    <div className="plab-generator-controls" data-testid="pattern-knob-panel">
      <p className="plab-generator-controls-heading">This pattern's own controls</p>
      {visible.map(knob => {
        const meta = resolveParamLabel(patternId, knob.name);
        const current = Number.isFinite(params?.[knob.name]) ? params[knob.name] : knob.value;
        const isDefault = current === knob.value;
        return (
          <label className="plab-macro" key={knob.name}>
            <span className="plab-macro-label">
              <strong>{meta.label}</strong>
              <output aria-label={`${meta.label} value`}>{formatKnobValue(current, knob.min, knob.max)}</output>
            </span>
            <input
              aria-label={meta.label}
              type="range"
              min={knob.min}
              max={knob.max}
              step={knob.step}
              value={current}
              onChange={event => onParamChange?.(knob.name, Number(event.target.value))}
            />
            {meta.hint && <small>{meta.hint}</small>}
            {!isDefault && (
              <button
                type="button"
                className="plab-knob-reset"
                onClick={() => onParamChange?.(knob.name, knob.value)}
              >Reset to default</button>
            )}
          </label>
        );
      })}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="plab-knob-more"
          onClick={() => setExpanded(true)}
        >{`+${hiddenCount} more control${hiddenCount === 1 ? '' : 's'}`}</button>
      )}
    </div>
  );
}
