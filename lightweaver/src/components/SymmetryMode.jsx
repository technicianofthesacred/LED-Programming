import { useMemo } from 'react';
import { useProject } from '../state/ProjectContext.jsx';

const RING_FIXTURE = [
  { id: 'ring-inner', name: 'Inner Ring', leds: 64 },
  { id: 'ring-middle', name: 'Middle Ring', leds: 96 },
  { id: 'ring-outer', name: 'Outer Ring', leds: 128 },
];

const TRANSFORMS = [
  {
    id: 'none',
    label: 'Off',
    status: 'raw',
    summary: 'Use the layout coordinates exactly as drawn.',
    detail: 'Patterns read each LED position directly, with no symmetry remap.',
    bestFor: 'Checking the natural direction of a pattern.',
    settings: { enabled: false, type: 'none' },
  },
  {
    id: 'mirror-h',
    label: 'Mirror H',
    status: 'mirror',
    summary: 'Fold top and bottom into the same half.',
    detail: 'Only y changes. Pixels above and below center sample matching pattern positions.',
    bestFor: 'Making vertical motion reflect across the center line.',
    settings: { enabled: true, type: 'mirror-h' },
  },
  {
    id: 'mirror-v',
    label: 'Mirror V',
    status: 'mirror',
    summary: 'Fold left and right into the same half.',
    detail: 'Only x changes. Pixels left and right of center sample matching pattern positions.',
    bestFor: 'Making horizontal motion reflect across the center line.',
    settings: { enabled: true, type: 'mirror-v' },
  },
  {
    id: 'mirror-hv',
    label: 'Mirror H+V',
    status: 'mirror',
    summary: 'Fold all quadrants into one shared corner.',
    detail: 'Both x and y are mirrored, so all four quadrants share the same sampled pattern.',
    bestFor: 'Stable four-way symmetry on rings or rectangular layouts.',
    settings: { enabled: true, type: 'mirror-hv' },
  },
  {
    id: 'radial',
    label: 'Radial',
    status: 'radial',
    summary: 'Fold angle into repeated wedges.',
    detail: 'The pattern is sampled from one angular wedge, then repeated around the center.',
    bestFor: 'Spokes, mandalas, radar sweeps, and repeated comet trails.',
    settings: { enabled: true, type: 'radial', count: 8 },
  },
  {
    id: 'kaleido',
    label: 'Kaleidoscope',
    status: 'kaleido',
    summary: 'Mirror every other radial wedge.',
    detail: 'Like radial symmetry, but alternate slices flip direction for a glass-cut effect.',
    bestFor: 'Crystalline, stained-glass, and folded geometric looks.',
    settings: { enabled: true, type: 'kaleido', slices: 6 },
  },
];

const TRANSFORM_BY_ID = Object.fromEntries(TRANSFORMS.map(transform => [transform.id, transform]));

function getActiveTransform(settings) {
  if (!settings?.enabled || settings.type === 'none') return TRANSFORM_BY_ID.none;
  return TRANSFORM_BY_ID[settings.type] || TRANSFORM_BY_ID.none;
}

function formatPhase(value = 0) {
  return `${Math.round(value * 360)} deg`;
}

function MiniMap({ transform, settings }) {
  const type = transform.id;
  const radialCount = type === 'kaleido' ? (settings.slices || 6) : (settings.count || 8);
  const spokes = type === 'radial' || type === 'kaleido'
    ? Array.from({ length: Math.min(radialCount, 16) }, (_, index) => index)
    : [];

  return (
    <svg className="lw-sym-minimap" viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" r="45" className="ring outer"/>
      <circle cx="60" cy="60" r="29" className="ring middle"/>
      <circle cx="60" cy="60" r="13" className="ring inner"/>
      {(type === 'mirror-h' || type === 'mirror-hv') && <line x1="14" y1="60" x2="106" y2="60" className="axis active"/>}
      {(type === 'mirror-v' || type === 'mirror-hv') && <line x1="60" y1="14" x2="60" y2="106" className="axis active"/>}
      {spokes.map(index => {
        const angle = (-90 + (360 / spokes.length) * index) * Math.PI / 180;
        const x = 60 + Math.cos(angle) * 48;
        const y = 60 + Math.sin(angle) * 48;
        return <line key={index} x1="60" y1="60" x2={x} y2={y} className={type === 'kaleido' && index % 2 ? 'spoke alternate' : 'spoke'}/>;
      })}
      {type === 'none' && <path d="M 33 82 C 46 35, 77 92, 91 39" className="free-path"/>}
      <circle cx="60" cy="60" r="3" className="center"/>
    </svg>
  );
}

function ValueRow({ label, value }) {
  return (
    <div className="lw-sym-value-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SliderRow({ label, value, min = 0, max = 100, onChange, readout }) {
  return (
    <label className="lw-sym-slider-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step="1"
        value={value}
        onChange={event => onChange(Number(event.target.value))}
      />
      <strong>{readout}</strong>
    </label>
  );
}

export function SymmetryMode() {
  const { symSettings, setSymSettings } = useProject();
  const active = getActiveTransform(symSettings);
  const ringLedTotal = useMemo(() => RING_FIXTURE.reduce((sum, ring) => sum + ring.leds, 0), []);

  const update = (patch) => setSymSettings(prev => ({ ...prev, ...patch }));
  const activate = (transform) => {
    const next = { ...transform.settings };
    if (transform.id === 'radial') {
      next.count = symSettings.count || transform.settings.count;
      next.phase = symSettings.phase || 0;
      next.twist = symSettings.twist || 0;
    }
    if (transform.id === 'kaleido') {
      next.slices = symSettings.slices || transform.settings.slices;
      next.phase = symSettings.phase || 0;
    }
    setSymSettings(prev => ({ ...prev, ...next }));
  };

  return (
    <div className="lw-sym-workspace">
      <div className="lw-sec-header">
        <span>Symmetry transform</span>
        <span className="meta">coordinate remap</span>
      </div>

      <div className="lw-sym-status">
        <label>
          <input
            type="checkbox"
            checked={!!symSettings.enabled && symSettings.type !== 'none'}
            onChange={event => update({ enabled: event.target.checked, type: event.target.checked ? active.id === 'none' ? 'mirror-hv' : active.id : 'none' })}
          />
          <span>Use symmetry</span>
        </label>
        <strong>{active.label}</strong>
      </div>

      <div className="lw-sec-header">
        <span>Coordinate flow</span>
        <span className="meta">One active transform</span>
      </div>
      <div className="lw-sym-flow">
        <div>
          <span>1</span>
          <strong>LED x/y</strong>
          <small>layout or ring fixture</small>
        </div>
        <div className="active">
          <span>2</span>
          <strong>{active.label}</strong>
          <small>{active.status}</small>
        </div>
        <div>
          <span>3</span>
          <strong>Pattern sample</strong>
          <small>color per LED</small>
        </div>
      </div>

      <div className="lw-sec-header">
        <span>Transform library</span>
        <span className="meta">click to activate</span>
      </div>
      <div className="lw-sym-transform-grid">
        {TRANSFORMS.map(transform => (
          <button
            key={transform.id}
            type="button"
            aria-label={transform.label}
            className={`lw-sym-transform ${active.id === transform.id ? 'active' : ''}`}
            onClick={() => activate(transform)}
          >
            <span className={`lw-sym-transform-icon ${transform.status}`}/>
            <span>
              <strong>{transform.label}</strong>
              <small>{transform.summary}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="lw-sec-header">
        <span>Inspector</span>
        <span className="meta">{active.status}</span>
      </div>
      <div className="lw-sym-inspector">
        <div className="lw-sym-inspector-head">
          <MiniMap transform={active} settings={symSettings}/>
          <div>
            <h3>{active.label}</h3>
            <p>{active.detail}</p>
            <small>{active.bestFor}</small>
          </div>
        </div>

        {active.status === 'mirror' && (
          <div className="lw-sym-control-block">
            <div className="lw-sym-segmented" aria-label="Mirror axis">
              {[
                ['mirror-h', 'H'],
                ['mirror-v', 'V'],
                ['mirror-hv', 'H+V'],
              ].map(([type, label]) => (
                <button
                  key={type}
                  type="button"
                  className={symSettings.type === type ? 'active' : ''}
                  onClick={() => update({ enabled: true, type })}
                >
                  {label}
                </button>
              ))}
            </div>
            <ValueRow label="Affects" value={symSettings.type === 'mirror-h' ? 'y only' : symSettings.type === 'mirror-v' ? 'x only' : 'x and y'}/>
          </div>
        )}

        {active.id === 'radial' && (
          <div className="lw-sym-control-block">
            <div className="lw-sym-count-grid">
              {[3, 4, 5, 6, 8, 12].map(count => (
                <button
                  key={count}
                  type="button"
                  className={(symSettings.count || 8) === count ? 'active' : ''}
                  onClick={() => update({ enabled: true, type: 'radial', count })}
                >
                  {count}
                </button>
              ))}
            </div>
            <ValueRow label="Wedges" value={symSettings.count || 8}/>
            <SliderRow
              label="Phase"
              value={Math.round((symSettings.phase || 0) * 100)}
              onChange={value => update({ enabled: true, type: 'radial', phase: value / 100 })}
              readout={formatPhase(symSettings.phase || 0)}
            />
            <SliderRow
              label="Twist"
              min={-100}
              max={100}
              value={Math.round((symSettings.twist || 0) * 1000)}
              onChange={value => update({ enabled: true, type: 'radial', twist: value / 1000 })}
              readout={`${(symSettings.twist || 0).toFixed(3)} Hz`}
            />
          </div>
        )}

        {active.id === 'kaleido' && (
          <div className="lw-sym-control-block">
            <SliderRow
              label="Slices"
              min={2}
              max={16}
              value={symSettings.slices || 6}
              onChange={value => update({ enabled: true, type: 'kaleido', slices: value })}
              readout={symSettings.slices || 6}
            />
            <SliderRow
              label="Phase"
              value={Math.round((symSettings.phase || 0) * 100)}
              onChange={value => update({ enabled: true, type: 'kaleido', phase: value / 100 })}
              readout={formatPhase(symSettings.phase || 0)}
            />
          </div>
        )}

        {active.id === 'none' && (
          <div className="lw-sym-control-block">
            <ValueRow label="Transform" value="disabled"/>
            <ValueRow label="Coordinates" value="raw x/y"/>
          </div>
        )}
      </div>

      <div className="lw-sec-header">
        <span>Current fixture</span>
        <span className="meta">{ringLedTotal} LEDs</span>
      </div>
      <div className="lw-sym-ring-list">
        {RING_FIXTURE.map(ring => (
          <div key={ring.id}>
            <span>{ring.name}</span>
            <strong>{ring.leds}</strong>
          </div>
        ))}
      </div>

      <div className="lw-sym-note">
        Ring routing is shared for now. The active transform applies to every visible LED before pattern code runs.
      </div>
    </div>
  );
}
