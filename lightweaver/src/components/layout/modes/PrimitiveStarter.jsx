import { useState } from 'react';
import { STARTER_PRIMITIVES } from '../../../lib/layoutPrimitives.js';

function PrimitiveIcon({ type }) {
  if (type === 'circle') return <circle cx="24" cy="14" r="9"/>;
  if (type === 'square') return <rect x="15" y="5" width="18" height="18" rx="1"/>;
  if (type === 'free') return <path d="M7 20 C13 3 20 25 28 9 S39 8 42 18"/>;
  return <path d="M7 20 L41 8"/>;
}

export function PrimitiveStarter({ currentPixelCount, onCreate, onFreeDraw, onImport }) {
  const [selected, setSelected] = useState('line');
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
      <div className="la-primitive-action">
        <span>{freeDraw ? 'Place points directly on the canvas.' : `${currentPixelCount} LEDs to start · adjust next in Size.`}</span>
        <button
          type="button"
          className="btn primary"
          aria-label={freeDraw ? 'Start drawing' : `Create ${selected}`}
          onClick={() => freeDraw ? onFreeDraw() : onCreate(selected)}>
          {freeDraw ? 'Start drawing' : `Create ${selected}`}
        </button>
      </div>
    </section>
  );
}
