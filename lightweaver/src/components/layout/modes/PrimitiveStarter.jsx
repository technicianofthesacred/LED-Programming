import { useState } from 'react';
import { STARTER_PRIMITIVES } from '../../../lib/layoutPrimitives.js';
import { DENSITY_OPTIONS, clampLedCount } from '../../../lib/layoutGeometry.js';

function PrimitiveIcon({ type }) {
  if (type === 'circle') return <circle cx="24" cy="14" r="9"/>;
  if (type === 'square') return <rect x="15" y="5" width="18" height="18" rx="1"/>;
  if (type === 'free') return <path d="M7 20 C13 3 20 25 28 9 S39 8 42 18"/>;
  return <path d="M7 20 L41 8"/>;
}

export function PrimitiveStarter({ currentPixelCount, defaultDensity, onCreate, onFreeDraw, onImport }) {
  const [selected, setSelected] = useState('line');
  const [ledCount, setLedCount] = useState(currentPixelCount);
  const [density, setDensity] = useState(defaultDensity);
  const freeDraw = selected === 'free';

  return (
    <section className="la-primitive-starter" data-testid="layout-primitive-picker" aria-label="Start a layout">
      <div className="la-primitive-heading">
        <div>
          <strong>Start with a shape</strong>
          <span>Choose the closest structure, then refine it in Size.</span>
        </div>
        <button type="button" className="la-primitive-import" onClick={onImport}>Import SVG</button>
      </div>
      <div className="la-primitive-grid" role="group" aria-label="Layout shape">
        {STARTER_PRIMITIVES.map(primitive => (
          <button
            type="button"
            key={primitive.key}
            className={selected === primitive.key ? 'is-selected' : ''}
            aria-pressed={selected === primitive.key}
            onClick={() => setSelected(primitive.key)}>
            <svg viewBox="0 0 48 28" aria-hidden="true">
              <PrimitiveIcon type={primitive.key}/>
            </svg>
            <span>{primitive.label}</span>
          </button>
        ))}
      </div>
      <div className="la-primitive-physical">
        <label>
          <span>LEDs</span>
          <input type="number" min="1" step="1"
                 value={ledCount}
                 aria-label="Starting strip LEDs"
                 inputMode="numeric"
                 onFocus={e => e.target.select()}
                 onChange={e => setLedCount(clampLedCount(e.target.value))}/>
        </label>
        <div className="la-primitive-density" data-testid="primitive-density-control"
             role="group" aria-label="Starting strip density">
          {DENSITY_OPTIONS.map(option => (
            <button key={option} type="button"
                    className={density === option ? 'is-selected' : ''}
                    aria-label={`${option} LEDs/m`}
                    aria-pressed={density === option}
                    onClick={() => setDensity(option)}>{option}/m</button>
          ))}
        </div>
      </div>
      <div className="la-primitive-action">
        <span>{freeDraw ? 'Place points directly on the canvas.' : `≈ ${(clampLedCount(ledCount) / density).toFixed(2)} m at ${density} LEDs/m`}</span>
        <button
          type="button"
          className="btn primary"
          aria-label={freeDraw ? 'Start drawing' : `Create ${selected}`}
          onClick={() => freeDraw ? onFreeDraw() : onCreate(selected, clampLedCount(ledCount), density)}>
          {freeDraw ? 'Start drawing' : `Create ${selected}`}
        </button>
      </div>
    </section>
  );
}
