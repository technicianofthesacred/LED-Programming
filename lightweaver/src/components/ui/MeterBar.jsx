import '../../styles/lw-ui.css';

/**
 * MeterBar — slim horizontal meter. Accent fill proportional to value/max,
 * a red tick at safeLimit/max, and the fill turns --danger once value
 * exceeds safeLimit. Mono tabular captions render under the bar.
 */
export function MeterBar({ value = 0, max = 1, safeLimit, leftCaption, rightCaption }) {
  const span = max > 0 ? max : 1;
  const clampPct = (n) => Math.max(0, Math.min(100, (n / span) * 100));
  const fillPct = clampPct(value);
  const limitPct = safeLimit != null ? clampPct(safeLimit) : null;
  const over = safeLimit != null && value > safeLimit;

  return (
    <div className="lwui-meter-wrap">
      <div
        className="lwui-meter"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={span}
        aria-label={leftCaption || 'usage'}
      >
        <div
          className={`lwui-meter-fill${over ? ' lwui-meter-over' : ''}`}
          style={{ width: `${fillPct}%` }}
        />
        {limitPct != null && (
          <div
            className="lwui-meter-limit"
            style={{ left: `${limitPct}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      {(leftCaption || rightCaption) && (
        <div className="lwui-meter-caps">
          <span>{leftCaption}</span>
          <span>{rightCaption}</span>
        </div>
      )}
    </div>
  );
}

export default MeterBar;
