import { useState } from 'react';
import { STARTER_PRIMITIVES } from '../../../lib/layoutPrimitives.js';
import { DENSITY_OPTIONS, clampLedCount } from '../../../lib/layoutGeometry.js';

function PrimitiveIcon({ type }) {
  if (type === 'circle') return <circle cx="24" cy="14" r="9"/>;
  if (type === 'square') return <rect x="15" y="5" width="18" height="18" rx="1"/>;
  if (type === 'free') return <path d="M7 20 C13 3 20 25 28 9 S39 8 42 18"/>;
  return <path d="M7 20 L41 8"/>;
}

const formatMetres = value => (Number(value) >= 10 ? Number(value).toFixed(1) : Number(value).toFixed(2));

export function PrimitiveStarter({ currentPixelCount, defaultDensity, onCreate, onFreeDraw, onImport }) {
  const [selected, setSelected] = useState('line');
  const [ledCount, setLedCount] = useState(currentPixelCount);
  const [density, setDensity] = useState(defaultDensity);
  const [lengthM, setLengthM] = useState(currentPixelCount / defaultDensity);
  const [lengthDraft, setLengthDraft] = useState(() => formatMetres(currentPixelCount / defaultDensity));
  const freeDraw = selected === 'free';

  const setLinkedCount = rawValue => {
    const count = clampLedCount(rawValue);
    const nextLength = count / density;
    setLedCount(count);
    setLengthM(nextLength);
    setLengthDraft(formatMetres(nextLength));
  };
  const setLinkedDensity = nextDensity => {
    const nextLength = clampLedCount(ledCount) / nextDensity;
    setDensity(nextDensity);
    setLengthM(nextLength);
    setLengthDraft(formatMetres(nextLength));
  };
  const commitLength = () => {
    const nextLength = Number(lengthDraft);
    if (!Number.isFinite(nextLength) || nextLength <= 0) {
      setLengthDraft(formatMetres(lengthM));
      return;
    }
    setLengthM(nextLength);
    setLedCount(clampLedCount(Math.round(nextLength * density)));
    setLengthDraft(formatMetres(nextLength));
  };

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
        <div className="la-primitive-dimensions">
          <label>
            <span>LEDs</span>
            <input type="number" min="1" step="1"
                   value={ledCount}
                   aria-label="Starting strip LEDs"
                   inputMode="numeric"
                   onFocus={e => e.target.select()}
                   onChange={e => setLinkedCount(e.target.value)}/>
          </label>
          <label>
            <span>Size</span>
            <input type="number" min="0.001" step="0.001"
                   value={lengthDraft}
                   aria-label="Starting strip size in metres"
                   inputMode="decimal"
                   onFocus={e => e.target.select()}
                   onChange={e => setLengthDraft(e.target.value)}
                   onBlur={commitLength}
                   onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
            <em>m</em>
          </label>
        </div>
        <div className="la-primitive-density" data-testid="primitive-density-control"
             role="group" aria-label="Starting strip density">
          {DENSITY_OPTIONS.map(option => (
            <button key={option} type="button"
                    className={density === option ? 'is-selected' : ''}
                    aria-label={`${option} LEDs/m`}
                    aria-pressed={density === option}
                    onClick={() => setLinkedDensity(option)}>{option}/m</button>
          ))}
        </div>
      </div>
      <div className="la-primitive-action">
        <span>{freeDraw ? 'Place points directly on the canvas.' : `${density} LEDs/m`}</span>
        <button
          type="button"
          className="btn primary"
          aria-label={freeDraw ? 'Start drawing' : `Create ${selected}`}
          onClick={() => freeDraw ? onFreeDraw() : onCreate(selected, clampLedCount(ledCount), density, lengthM)}>
          {freeDraw ? 'Start drawing' : `Create ${selected}`}
        </button>
      </div>
    </section>
  );
}
