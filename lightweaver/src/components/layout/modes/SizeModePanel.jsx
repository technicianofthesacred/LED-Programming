import { useEffect, useRef, useState } from 'react';
import {
  DENSITY_OPTIONS,
  clampLedCount,
  parsedVb,
  svgPathLength,
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

// Compact "1.5" style metres formatting (no trailing zeros, 2 dp max).
const fmtMeters = m => String(Number((Math.round(m * 100) / 100).toFixed(2)));

// Buffered strip-length input (metres). Commits on blur/Enter; Escape restores.
function BufferedStripLengthInput({ strip, lengthM, onCommit }) {
  const [draft, setDraft] = useState(fmtMeters(lengthM));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(fmtMeters(lengthM));
  }, [lengthM]);

  const commit = () => {
    const val = parseFloat(draft);
    if (Number.isFinite(val) && val > 0 && Math.abs(val - lengthM) > 0.0005) {
      onCommit(val);
    } else {
      setDraft(fmtMeters(lengthM));
    }
  };

  return (
    <input
      className="lws-num lws-len-input"
      type="number" min="0.1" step="0.1" inputMode="decimal"
      value={draft}
      aria-label={`${strip.name} length in metres`}
      onFocus={event => {
        focusedRef.current = true;
        setDraft(fmtMeters(lengthM));
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
          setDraft(fmtMeters(lengthM));
        }
      }}/>
  );
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
// The physical strips are the ground truth (wiring/sizing redesign): each row
// declares what was bought — the strip's real length in metres and the LED
// density printed on its reel. The LED count derives from those and the drawn
// geometry rescales to match (setStripPhysical in useLayoutSize). The count
// stepper nudges ±1 for cut strips / miscounts via the stripCountOverrides
// path. The global density picker is only the default for strips that haven't
// declared a reel; the old artwork-width input lives on inside the collapsed
// "Drawing scale" card along with per-strip calibrate.
//
// The power budget (estimatePowerBudget) renders below — LED counts drive
// draw/supply/headroom tiles, a safe-limit meter, and a computed advice
// sentence. Supply size and per-LED draw persist on standaloneController.led
// (via powerSupplySettings.js) so a custom PSU survives mode switches and
// project reloads.
export function SizeModePanel({ state }) {
  const {
    viewBox, pxPerMm, density,
    scaleUnit, setScaleUnit, handleScaleChange, handleDensityChange,
    orderedStrips, stripCountOverrides, stripDensity, setStripPhysical,
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

  // Physical facts per strip, derived once per render for row + power use.
  const rows = orderedStrips.map(s => {
    const effDensity = stripDensity(s.id);
    const svgLen = (Number.isFinite(s.svgLength) && s.svgLength > 0)
      ? s.svgLength : svgPathLength(s.pathData);
    const lengthM = pxPerMm > 0 ? (svgLen / pxPerMm) / 1000 : 0;
    const derivedCount = Math.max(1, Math.round(lengthM * effDensity));
    return { strip: s, effDensity, lengthM, derivedCount };
  });

  const usbOver = usbLedConnected && orderedStrips.some(s => s.pixelCount > usbLedMaxPixels);

  // ── Power budget: persisted supply settings, live estimate ──
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
  const totalMeters = rows.reduce((sum, r) => sum + (r.effDensity > 0 ? (r.strip.pixelCount || 0) / r.effDensity : 0), 0);
  const budget = estimatePowerBudget({
    led: { length: totalPixels, maxBrightness: 255 },   // full white = worst case
    power: { psuAmps, milliampsPerPixel },
  });
  const advice = powerAdvice({ budget, psuAmps, totalMeters, totalPixels });

  return (
    <div className="lws-panel" data-testid="layout-size-panel">

      <header>
        <p className="lws-eyebrow">Size &amp; Power</p>
        <h3 className="lws-title">Your strips set the size</h3>
        <p className="lws-sub">Enter what you bought — the drawing and the power budget follow.</p>
      </header>

      {/* 1 · The physical strips — ground truth ───────────────────────── */}
      <UiCard
        title="Your LED strips"
        description={orderedStrips.length > 0
          ? 'Length and density are facts of the strip you bought — the density is printed on the reel. The drawing rescales to match.'
          : undefined}>
        {orderedStrips.length === 0 ? (
          <div className="lws-empty">
            Add strips in Draw mode, then enter their real lengths here.
          </div>
        ) : (
          <div className="lws-strips">
            {rows.map(({ strip: s, effDensity, lengthM, derivedCount }, i) => {
              const overridden = !!stripCountOverrides[s.id];
              const nudged = overridden && s.pixelCount !== derivedCount;
              const lengthFt = lengthM * 3.28084;
              const densityChoices = DENSITY_OPTIONS.includes(effDensity)
                ? DENSITY_OPTIONS
                : [...DENSITY_OPTIONS, effDensity].sort((a, b) => a - b);
              return (
                <div key={s.id} className="lws-strip-row" data-testid="layout-size-strip-row">
                  <span className="lws-strip-idx">{String(i + 1).padStart(2, '0')}</span>
                  <span className="lws-strip-swatch" style={{ background: s.color }} aria-hidden="true"/>
                  <span className="lws-strip-name" title={s.name}>{s.name}</span>
                  <span className="lws-count">
                    <button className="lws-nudge" type="button"
                            aria-label={`Remove one LED from ${s.name}`}
                            title="Fine-tune down — for a strip cut one LED short"
                            disabled={s.pixelCount <= 1}
                            onClick={() => setStripCount(s.id, clampLedCount(s.pixelCount - 1))}>−</button>
                    <span className="lws-count-value" data-testid="layout-size-strip-leds">{s.pixelCount} LEDs</span>
                    <button className="lws-nudge" type="button"
                            aria-label={`Add one LED to ${s.name}`}
                            title="Fine-tune up — for a strip cut one LED long"
                            disabled={s.pixelCount >= LED_COUNT_MAX}
                            onClick={() => setStripCount(s.id, clampLedCount(s.pixelCount + 1))}>+</button>
                  </span>
                  <div className="lws-strip-facts">
                    <label className="lws-fact">
                      <span className="lws-fact-name">How long is this strip?</span>
                      <span className="lws-fact-ctl">
                        <BufferedStripLengthInput strip={s} lengthM={lengthM}
                          onCommit={val => setStripPhysical(s.id, { lengthM: val })}/>
                        <span className="lws-fact-unit" aria-hidden="true">m</span>
                        <span className="lws-ft">≈ {lengthFt.toFixed(1)} ft</span>
                      </span>
                    </label>
                    <label className="lws-fact">
                      <span className="lws-fact-name">On the reel</span>
                      <select className="lws-reel"
                              value={effDensity}
                              aria-label={`${s.name} reel density`}
                              title="The LEDs-per-metre printed on the reel this strip was cut from"
                              onChange={e => setStripPhysical(s.id, { ledsPerM: Number(e.target.value) })}>
                        {densityChoices.map(d => (
                          <option key={d} value={d}>{d} LEDs / m</option>
                        ))}
                      </select>
                    </label>
                    {nudged && (
                      <span className="lws-override" data-testid="layout-size-count-override-badge"
                            title="Hand-tuned count — length and density changes leave it alone.">
                        tuned
                        <button className="lws-reset" title="Back to the computed count"
                                aria-label={`Reset ${s.name} to the computed count`}
                                onClick={() => resetStripCount(s.id)}>↺</button>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </UiCard>

      {/* 2 · Default density — only for undeclared strips ─────────────── */}
      <div className="lws-density-block">
        <p className="lws-eyebrow">Default density</p>
        <div className="lws-density" data-testid="layout-size-density">
          {DENSITY_OPTIONS.map(d => (
            <button key={d} type="button"
                    className={`lws-dopt${density === d ? ' lws-dopt-sel' : ''}`}
                    aria-pressed={density === d}
                    onClick={() => handleDensityChange(d)}>
              {d} / m
            </button>
          ))}
        </div>
        <p className="lws-hint">
          Only for strips that haven&apos;t set a reel above — a strip&apos;s own density is fixed by what you bought.
        </p>
      </div>

      {/* 3 · Drawing scale — demoted fine-tune card ───────────────────── */}
      <details className="lws-fold" data-testid="layout-size-drawing-scale">
        <summary>Drawing scale</summary>
        <p className="lws-hint">
          Fine-tune the drawing scale — how wide is the real artwork?
        </p>
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
        {orderedStrips.length > 0 && (
          <div className="lws-cal-list">
            <p className="lws-hint">
              Or count the LEDs on one strip and calibrate the whole drawing from it.
            </p>
            {orderedStrips.map(s => (
              <div key={s.id} className="lws-cal-row" data-testid="layout-size-calibrate-row">
                <span className="lws-strip-name" title={s.name}>{s.name}</span>
                <span className="lws-cal-count">{s.pixelCount} LEDs</span>
                <button className="lws-calibrate"
                        title="Uses this strip's count as ground truth and rescales the whole piece"
                        onClick={() => calibrateScaleFromStrip(s.id, s.pixelCount)}>
                  Calibrate from this strip
                </button>
              </div>
            ))}
          </div>
        )}
        {usbLedConnected && orderedStrips.length > 0 && (
          <div className={`lws-usbcap${usbOver ? ' lws-usbcap-over' : ''}`}>
            {usbOver
              ? `USB power caps each strip at ${usbLedMaxPixels} LEDs — one of your strips is over that.`
              : `USB power caps each strip at ${usbLedMaxPixels} LEDs.`}
          </div>
        )}
      </details>

      {/* 4 · Power ────────────────────────────────────────────────────── */}
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
