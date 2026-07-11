import {
  DENSITY_OPTIONS,
  clampLedCount,
  parsedVb,
} from '../../../lib/layoutGeometry.js';
import { LED_COUNT_MAX } from '../../../lib/controlScale.js';

// ── Size-mode side panel ─────────────────────────────────────────────────────
// The top-to-bottom derivation chain (docs/layout-redesign-plan.md, Phase 2
// Size mode + step 8): artwork size → density → per-strip LED counts. Density
// lives ONLY here now. Per-strip counts carry an override badge + reset when a
// count has been set by hand (density/scale/calibrate then leave that strip
// alone); "Calibrate from this strip" back-solves the whole piece's scale from
// one strip's counted LEDs. Receives the full useLayoutState() bundle as one
// `state` prop, mirroring DrawModePanel.
export function SizeModePanel({ state }) {
  const {
    viewBox, pxPerMm, density,
    scaleUnit, setScaleUnit, handleScaleChange, handleDensityChange,
    orderedStrips, stripCountOverrides,
    setStripCount, resetStripCount, calibrateScaleFromStrip,
    usbLedConnected, usbLedMaxPixels,
  } = state;

  const vb = parsedVb(viewBox);
  const per = scaleUnit === 'in' ? 25.4 : 10;      // mm per display unit
  const wDisp = (vb.w / pxPerMm) / per;
  const hDisp = (vb.h / pxPerMm) / per;
  const applyWidth = (raw) => {
    const val = parseFloat(raw);
    if (!(val > 0)) return;
    handleScaleChange(vb.w / (val * per));          // pxPerMm = svgWidth / targetWidthMm
  };

  const usbOver = usbLedConnected && orderedStrips.some(s => s.pixelCount > usbLedMaxPixels);

  return (
    <div className="la-size-chain" data-testid="layout-size-panel">

      {/* 1 · Artwork size ─────────────────────────────────────────────── */}
      <div className="la-size-step">
        <div className="la-size-step-h">
          <span className="ttl">Artwork size</span>
          <span className="meta">real-world width</span>
        </div>
        <div className="la-size-scale">
          <input
            className="num-input"
            type="number" min="0.1" step="0.1" inputMode="decimal"
            key={`sz-${scaleUnit}-${wDisp.toFixed(2)}`}
            defaultValue={wDisp.toFixed(1)}
            aria-label={`Artwork width in ${scaleUnit}`}
            onFocus={e => e.target.select()}
            onBlur={e => applyWidth(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { applyWidth(e.target.value); e.target.blur(); } }}/>
          <button className="la-size-unit" title="Toggle centimetres / inches"
                  onClick={() => setScaleUnit(u => (u === 'cm' ? 'in' : 'cm'))}>{scaleUnit}</button>
          <span className="la-size-dims">
            {wDisp.toFixed(1)} × {hDisp.toFixed(1)} {scaleUnit}
          </span>
        </div>
      </div>

      {/* 2 · Density ──────────────────────────────────────────────────── */}
      <div className="la-size-step">
        <div className="la-size-step-h">
          <span className="ttl">Density</span>
          <span className="meta">LEDs / metre</span>
        </div>
        <div className="seg la-size-density" data-testid="layout-size-density">
          {DENSITY_OPTIONS.map(d => (
            <button key={d} className={density === d ? 'on' : ''}
                    onClick={() => handleDensityChange(d)}>{d}</button>
          ))}
        </div>
      </div>

      {/* 3 · Per-strip counts ─────────────────────────────────────────── */}
      <div className="la-size-step">
        <div className="la-size-step-h">
          <span className="ttl">LED counts</span>
          <span className="meta">{orderedStrips.length} strip{orderedStrips.length !== 1 ? 's' : ''} · wiring order</span>
        </div>

        {orderedStrips.length === 0 ? (
          <div className="la-size-empty">
            Add strips in Draw mode, then set exact LED counts here.
          </div>
        ) : (
          <div className="la-size-strips">
            {orderedStrips.map((s, i) => {
              const overridden = !!stripCountOverrides[s.id];
              const pitch = (s.svgLength > 0 && s.pixelCount > 1)
                ? ((s.svgLength / pxPerMm) / s.pixelCount).toFixed(1) : '—';
              return (
                <div key={s.id} className={`la-size-strip-row${overridden ? ' overridden' : ''}`}
                     data-testid="layout-size-strip-row">
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="layer-swatch" style={{ background: s.color, borderRadius: '50%' }}/>
                  <span className="nm" title={s.name}>{s.name}</span>
                  <input
                    className="num-input la-size-count"
                    type="number" min="1" max={LED_COUNT_MAX} step="1"
                    value={s.pixelCount}
                    aria-label={`${s.name} LED count`}
                    inputMode="numeric"
                    onFocus={e => e.target.select()}
                    onChange={e => setStripCount(s.id, clampLedCount(e.target.value))}
                    style={{ borderColor: overridden ? 'var(--accent)' : undefined }}/>
                  <span className="la-size-pitch">{pitch}<span className="u">mm/LED</span></span>
                  {overridden && (
                    <span className="la-size-override" data-testid="layout-size-count-override-badge"
                          title="Manual count — density, scale and calibrate leave this strip untouched.">
                      manual
                      <button className="la-size-reset" title="Reset to the computed count"
                              onClick={() => resetStripCount(s.id)}>↺</button>
                    </span>
                  )}
                  <button className="la-size-calib"
                          title="Uses this strip's count as ground truth and rescales the whole piece"
                          onClick={() => calibrateScaleFromStrip(s.id, s.pixelCount)}>
                    Calibrate from this strip
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {usbLedConnected && orderedStrips.length > 0 && (
          <div className="la-size-usbcap" style={{ color: usbOver ? 'var(--accent)' : 'var(--text-faint)' }}>
            USB direct cap {usbLedMaxPixels} LEDs.
          </div>
        )}
      </div>
    </div>
  );
}
