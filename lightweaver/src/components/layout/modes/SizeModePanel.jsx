import { useEffect, useRef, useState } from 'react';
import {
  DENSITY_OPTIONS,
  clampLedCount,
  parsedVb,
} from '../../../lib/layoutGeometry.js';
import { LED_COUNT_MAX } from '../../../lib/controlScale.js';
import { estimatePowerBudget } from '../../../lib/controllerProfiles.js';
import {
  readPowerSupplySettings,
  withPowerSupplySettings,
} from '../../../lib/powerSupplySettings.js';
import { useProject } from '../../../state/ProjectContext.jsx';
import { UiCard } from '../../ui/UiCard.jsx';
import { StatTile, StatTileRow } from '../../ui/StatTile.jsx';
import { MeterBar } from '../../ui/MeterBar.jsx';
import '../../../styles/lw-size.css';

function BufferedStripCountInput({ strip, overridden, setStripCount }) {
  const [draft, setDraft] = useState(String(strip.pixelCount));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(strip.pixelCount));
  }, [strip.pixelCount]);

  const commit = () => {
    const next = clampLedCount(draft);
    setDraft(String(next));
    if (next !== strip.pixelCount) setStripCount(strip.id, next);
  };

  return (
    <span className={`lws-px${overridden ? ' lws-px-overridden' : ''}`}>
      <input
        className="lws-px-input"
        type="number" min="1" max={LED_COUNT_MAX} step="1"
        value={draft}
        aria-label={`${strip.name} LED count`}
        inputMode="numeric"
        onFocus={event => {
          focusedRef.current = true;
          setDraft(String(strip.pixelCount));
          event.target.select();
        }}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          focusedRef.current = false;
          commit();
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(String(strip.pixelCount));
          }
        }}/>
      <span className="lws-px-unit" aria-hidden="true">px</span>
    </span>
  );
}

// Density preview geometry — denser options render more, tighter dots so
// spacing is seen rather than decoded (plan change 17). Keyed off the
// LEDs-per-metre value; unknown densities fall back to a derived spacing.
const DENSITY_PREVIEW = {
  30: { dots: 4, gap: 7 },
  60: { dots: 6, gap: 4 },
  96: { dots: 8, gap: 2.5 },
  144: { dots: 10, gap: 1.5 },
};
const DENSITY_CAPTIONS = { 30: 'airy', 60: 'standard', 96: 'fine', 144: 'dense' };

function densityPreview(d) {
  return DENSITY_PREVIEW[d] || {
    dots: Math.min(12, Math.max(4, Math.round(d / 14))),
    gap: Math.max(1.5, Math.min(8, 220 / d)),
  };
}

// One sentence computed from the power numbers (plan change 19). Calm and
// specific: reassurance when there is room, a concrete fix when there isn't.
function powerAdvice({ budget, psuAmps, totalMeters, totalPixels }) {
  if (totalPixels <= 0) return null;
  if (!(psuAmps > 0)) {
    return {
      tone: 'warn',
      text: 'Set the power supply size below to see how much headroom you have.',
    };
  }
  const { maxAmps, safeAmps, headroomAmps, status } = budget;
  if (status === 'over') {
    const capPct = maxAmps > 0 ? Math.floor((safeAmps / maxAmps) * 100) : 0;
    let text = `Lower the brightness cap to ${capPct}% to stay inside the safe limit.`;
    if (totalMeters > 5) {
      text += ' With over 5 m of strip, also feed power in again near the middle of the run.';
    }
    return { tone: 'over', text };
  }
  if (safeAmps > 0 && headroomAmps < safeAmps * 0.15) {
    return {
      tone: 'warn',
      text: 'Just inside the safe limit — everyday patterns are fine, but full white would run close to it.',
    };
  }
  return {
    tone: 'ok',
    text: 'Plenty of headroom — you could run everything at full white.',
  };
}

const parsePositive = (raw, fallback) => {
  const val = parseFloat(raw);
  return Number.isFinite(val) && val > 0 ? val : fallback;
};

// ── Size & Power side panel ──────────────────────────────────────────────────
// The top-to-bottom derivation chain (docs/layout-redesign-plan.md, Phase 2
// Size mode + step 8): artwork size → density → per-strip LED counts. Density
// lives ONLY here now. Per-strip counts carry an override badge + reset when a
// count has been set by hand (density/scale/calibrate then leave that strip
// alone); "Calibrate from this strip" back-solves the whole piece's scale from
// one strip's counted LEDs. Receives the full useLayoutState() bundle as one
// `state` prop, mirroring DrawModePanel.
//
// Redesign (docs/wiring-sizing-ui-redesign.md changes 15–19): the power budget
// (estimatePowerBudget) now renders here — pixel counts drive draw/supply/
// headroom tiles, a safe-limit meter, and a computed advice sentence. Supply
// size and per-LED draw persist on standaloneController.led (via
// powerSupplySettings.js) so a custom PSU survives mode switches and project
// reloads instead of silently resetting to the defaults.
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

  // ── Power budget (change 15/16): persisted supply settings, live estimate ──
  const { standaloneController, setStandaloneController } = useProject();
  const storedPower = readPowerSupplySettings(standaloneController);
  const [psuAmpsDraft, setPsuAmpsDraft] = useState(String(storedPower.psuAmps));
  const [maPerLedDraft, setMaPerLedDraft] = useState(String(storedPower.milliampsPerPixel));
  const psuAmps = parsePositive(psuAmpsDraft, storedPower.psuAmps);
  const milliampsPerPixel = parsePositive(maPerLedDraft, storedPower.milliampsPerPixel);
  const persistPowerSettings = next => {
    setStandaloneController(previous => withPowerSupplySettings(previous, {
      psuAmps,
      milliampsPerPixel,
      ...next,
    }));
  };

  const totalPixels = orderedStrips.reduce((sum, s) => sum + (s.pixelCount || 0), 0);
  const totalMeters = density > 0 ? totalPixels / density : 0;
  const budget = estimatePowerBudget({
    led: { length: totalPixels, maxBrightness: 255 },   // full white = worst case
    power: { psuAmps, milliampsPerPixel },
  });
  const advice = powerAdvice({ budget, psuAmps, totalMeters, totalPixels });

  return (
    <div className="lws-panel" data-testid="layout-size-panel">

      <header>
        <p className="lws-eyebrow">Size &amp; Power</p>
        <h3 className="lws-title">Fit the strips, mind the amps</h3>
        <p className="lws-sub">Pixel counts drive the power budget live.</p>
      </header>

      {/* 1 · Artwork size ─────────────────────────────────────────────── */}
      <UiCard
        title="How wide is the real artwork?"
        description="Everything else — strip lengths, LED counts — scales from this one number.">
        <div className="lws-scale">
          <input
            className="lws-num"
            type="number" min="0.1" step="0.1" inputMode="decimal"
            key={`sz-${scaleUnit}-${wDisp.toFixed(2)}`}
            defaultValue={wDisp.toFixed(1)}
            aria-label={`Artwork width in ${scaleUnit}`}
            onFocus={e => e.target.select()}
            onBlur={e => applyWidth(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { applyWidth(e.target.value); e.target.blur(); } }}/>
          <button className="lws-unit-toggle" title="Toggle centimetres / inches"
                  onClick={() => setScaleUnit(u => (u === 'cm' ? 'in' : 'cm'))}>{scaleUnit}</button>
          <span className="lws-dims">
            {wDisp.toFixed(1)} × {hDisp.toFixed(1)} {scaleUnit}
          </span>
        </div>
      </UiCard>

      {/* 2 · Density (change 17: previews you can see) ────────────────── */}
      <div className="lws-density-block">
        <p className="lws-eyebrow">Density</p>
        <div className="lws-density" data-testid="layout-size-density">
          {DENSITY_OPTIONS.map(d => {
            const { dots, gap } = densityPreview(d);
            return (
              <button key={d} type="button"
                      className={`lws-dopt${density === d ? ' lws-dopt-sel' : ''}`}
                      aria-pressed={density === d}
                      onClick={() => handleDensityChange(d)}>
                <span className="lws-dopt-dots" style={{ gap: `${gap}px` }} aria-hidden="true">
                  {Array.from({ length: dots }, (_, k) => <i key={k}/>)}
                </span>
                <span className="lws-dopt-name">{d} / m</span>
                <span className="lws-dopt-cap">{DENSITY_CAPTIONS[d] || `${d} LEDs per metre`}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3 · Strips (change 18, display half: length in cm and inches) ── */}
      <UiCard
        title="Strips"
        description={orderedStrips.length > 0
          ? `${orderedStrips.length} strip${orderedStrips.length !== 1 ? 's' : ''} in wiring order. Adjust a count by hand if the physical strip differs.`
          : undefined}>
        {orderedStrips.length === 0 ? (
          <div className="lws-empty">
            Add strips in Draw mode, then set exact LED counts here.
          </div>
        ) : (
          <div className="lws-strips">
            {orderedStrips.map((s, i) => {
              const overridden = !!stripCountOverrides[s.id];
              const lenCm = density > 0 ? (s.pixelCount / density) * 100 : 0;
              const lenIn = lenCm / 2.54;
              return (
                <div key={s.id} className="lws-strip-row" data-testid="layout-size-strip-row">
                  <span className="lws-strip-idx">{String(i + 1).padStart(2, '0')}</span>
                  <span className="lws-strip-swatch" style={{ background: s.color }} aria-hidden="true"/>
                  <span className="lws-strip-name" title={s.name}>{s.name}</span>
                  <span className="lws-strip-len">
                    {lenCm.toFixed(lenCm >= 10 ? 0 : 1)} cm · {lenIn.toFixed(1)} in
                  </span>
                  <BufferedStripCountInput strip={s} overridden={overridden} setStripCount={setStripCount}/>
                  <span className="lws-strip-meta">
                    {overridden && (
                      <span className="lws-override" data-testid="layout-size-count-override-badge"
                            title="Manual count — density, scale and calibrate leave this strip untouched.">
                        manual
                        <button className="lws-reset" title="Reset to the computed count"
                                aria-label={`Reset ${s.name} to the computed count`}
                                onClick={() => resetStripCount(s.id)}>↺</button>
                      </span>
                    )}
                    <button className="lws-calibrate"
                            title="Uses this strip's count as ground truth and rescales the whole piece"
                            onClick={() => calibrateScaleFromStrip(s.id, s.pixelCount)}>
                      Calibrate from this strip
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {usbLedConnected && orderedStrips.length > 0 && (
          <div className={`lws-usbcap${usbOver ? ' lws-usbcap-over' : ''}`}>
            {usbOver
              ? `USB power caps each strip at ${usbLedMaxPixels} LEDs — one of your strips is over that.`
              : `USB power caps each strip at ${usbLedMaxPixels} LEDs.`}
          </div>
        )}
      </UiCard>

      {/* 4 · Power (changes 15/16/19) ─────────────────────────────────── */}
      <div className="lws-power" data-testid="size-power-section">
        <p className="lws-eyebrow">Power</p>
        <StatTileRow columns={3}>
          <StatTile label="Max draw" value={budget.maxAmps.toFixed(1)} unit="A"
                    tone={budget.status === 'over' ? 'danger' : undefined}/>
          <StatTile label="Supply" value={psuAmps.toFixed(1)} unit="A"/>
          <StatTile label="Headroom" value={budget.headroomAmps.toFixed(1)} unit="A"
                    tone={budget.status === 'over' ? 'danger' : 'ok'}/>
        </StatTileRow>
        <UiCard>
          <MeterBar
            value={budget.maxAmps}
            max={psuAmps}
            safeLimit={budget.safeAmps}
            leftCaption={`${budget.maxAmps.toFixed(1)} A at full brightness`}
            rightCaption={`safe limit ${budget.safeAmps.toFixed(1)} A`}/>
          {advice && (
            <p className={`lws-advice lws-advice-${advice.tone}`} data-testid="size-power-advice">
              {advice.text}
            </p>
          )}
          <details className="lws-psu">
            <summary>Power supply</summary>
            <p className="lws-psu-hint">
              Defaults match the standard Lightweaver supply. Change these if this piece ships with a different one.
            </p>
            <div className="lws-psu-fields">
              <label className="lws-psu-field">
                Supply size (amps)
                <input className="lws-num" type="number" min="0.5" step="0.5" inputMode="decimal"
                       value={psuAmpsDraft}
                       aria-label="Power supply amps"
                       onFocus={e => e.target.select()}
                       onChange={e => {
                         setPsuAmpsDraft(e.target.value);
                         const val = parseFloat(e.target.value);
                         if (Number.isFinite(val) && val > 0) persistPowerSettings({ psuAmps: val });
                       }}
                       onBlur={() => setPsuAmpsDraft(String(psuAmps))}/>
              </label>
              <label className="lws-psu-field">
                Draw per LED (mA)
                <input className="lws-num" type="number" min="1" step="1" inputMode="numeric"
                       value={maPerLedDraft}
                       aria-label="Milliamps per LED"
                       onFocus={e => e.target.select()}
                       onChange={e => {
                         setMaPerLedDraft(e.target.value);
                         const val = parseFloat(e.target.value);
                         if (Number.isFinite(val) && val > 0) persistPowerSettings({ milliampsPerPixel: val });
                       }}
                       onBlur={() => setMaPerLedDraft(String(milliampsPerPixel))}/>
              </label>
            </div>
          </details>
        </UiCard>
      </div>
    </div>
  );
}
