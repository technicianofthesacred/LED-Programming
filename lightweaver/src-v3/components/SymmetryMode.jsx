import { useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';

const PRESETS = [
  {
    id: 'none',
    name: 'Original',
    desc: 'Use the pattern exactly as written.',
    patch: { enabled: false, type: 'none' },
  },
  {
    id: 'guide',
    name: 'Motion Guide',
    desc: 'Make effects flow from a line drawn on the artwork.',
    patch: { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 } } },
  },
  {
    id: 'mirror',
    name: 'Mirror',
    desc: 'Reflect the artwork across its center.',
    patch: { enabled: true, type: 'mirror-hv' },
  },
  {
    id: 'radial',
    name: 'Mandala',
    desc: 'Repeat one wedge around the center.',
    patch: { enabled: true, type: 'radial', count: 8, twist: 0 },
  },
  {
    id: 'spin',
    name: 'Spin',
    desc: 'Mandala symmetry with slow rotation.',
    patch: { enabled: true, type: 'radial', count: 8, twist: 0.035 },
  },
  {
    id: 'kaleido',
    name: 'Kaleidoscope',
    desc: 'Repeat and flip slices for sharper geometry.',
    patch: { enabled: true, type: 'kaleido', slices: 6 },
  },
];

const ADVANCED_PRESETS = [
  {
    id: 'dense-mandala',
    name: 'Dense Mandala',
    desc: 'More repeats for detailed artwork.',
    patch: { enabled: true, type: 'radial', count: 12, twist: 0 },
  },
  {
    id: 'reverse-spin',
    name: 'Reverse Spin',
    desc: 'Slow counter-rotation.',
    patch: { enabled: true, type: 'radial', count: 10, twist: -0.045 },
  },
  {
    id: 'fine-kaleido',
    name: 'Fine Kaleido',
    desc: 'More slices, sharper folds.',
    patch: { enabled: true, type: 'kaleido', slices: 12, phase: 0.04 },
  },
  {
    id: 'wide-kaleido',
    name: 'Wide Kaleido',
    desc: 'Fewer slices, larger mirrored fields.',
    patch: { enabled: true, type: 'kaleido', slices: 4, phase: 0 },
  },
];

function activePreset(settings) {
  if (!settings?.enabled || settings.type === 'none') return 'none';
  if (settings.type === 'guide-mirror') return 'guide';
  if (settings.type?.startsWith('mirror')) return 'mirror';
  if (settings.type === 'kaleido') return 'kaleido';
  if (settings.type === 'radial' && Math.abs(settings.twist || 0) > 0.001) return 'spin';
  if (settings.type === 'radial') return 'radial';
  return 'none';
}

function GeometryIcon({ type }) {
  if (type === 'mirror') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 4v24M4 16h24" />
        <circle cx="10" cy="10" r="2.4" />
        <circle cx="22" cy="10" r="2.4" />
        <circle cx="10" cy="22" r="2.4" />
        <circle cx="22" cy="22" r="2.4" />
      </svg>
    );
  }
  if (type === 'guide') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M8 25L24 7" />
        <path d="M9 12c4 3 8 3 14 0M8 20c5 3 9 3 15 0" />
        <path d="M19 7h5v5" />
        <circle cx="8" cy="25" r="2" />
        <circle cx="24" cy="7" r="2" />
      </svg>
    );
  }
  if (type === 'kaleido') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 16L16 3M16 16L27.3 9.5M16 16L27.3 22.5M16 16L16 29M16 16L4.7 22.5M16 16L4.7 9.5" />
        <path d="M16 5.5l7.9 4.6v9.2L16 23.9l-7.9-4.6v-9.2L16 5.5z" />
      </svg>
    );
  }
  if (type === 'spin') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 5a11 11 0 1 1-9.5 5.4" />
        <path d="M6 6v5h5" />
        <circle cx="16" cy="16" r="3" />
      </svg>
    );
  }
  if (type === 'radial') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="11" />
        <path d="M16 5v22M5 16h22M8.2 8.2l15.6 15.6M23.8 8.2L8.2 23.8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 16h18" />
      <circle cx="10" cy="16" r="2.5" />
      <circle cx="16" cy="16" r="2.5" />
      <circle cx="22" cy="16" r="2.5" />
    </svg>
  );
}

function RangeRow({ label, value, min, max, step, suffix = '', onChange }) {
  return (
    <label className="lw-geo-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} />
      <strong>{value}{suffix}</strong>
    </label>
  );
}

export function SymmetryMode() {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { symSettings, setSymSettings } = useProject();
  const selected = activePreset(symSettings);
  const update = patch => setSymSettings(prev => ({ ...prev, ...patch }));
  const selectPreset = preset => setSymSettings(prev => ({ ...prev, ...preset.patch }));
  const isMirror = symSettings.type?.startsWith('mirror');
  const isGuide = symSettings.type === 'guide-mirror';
  const isRadial = symSettings.type === 'radial';
  const isKaleido = symSettings.type === 'kaleido';

  return (
    <div className="lw-geo-panel">
      <div className="lw-sec-header">
        <span>Geometry</span>
        <span className="meta">{symSettings.enabled ? symSettings.type : 'off'}</span>
      </div>

      <div className="lw-geo-presets">
        {PRESETS.map(preset => (
          <button
            key={preset.id}
            className={`lw-geo-preset ${selected === preset.id ? 'active' : ''}`}
            onClick={() => selectPreset(preset)}
            title={preset.desc}
          >
            <GeometryIcon type={preset.id} />
            <span>
              <strong>{preset.name}</strong>
              <small>{preset.desc}</small>
            </span>
          </button>
        ))}
      </div>

      <div className="lw-geo-advanced">
        <button className="lw-geo-advanced-toggle" onClick={() => setShowAdvanced(v => !v)}>
          <span>Advanced effects</span>
          <strong>{showAdvanced ? 'Hide' : 'Show'}</strong>
        </button>
        {showAdvanced && (
          <div className="lw-geo-advanced-grid">
            {ADVANCED_PRESETS.map(preset => (
              <button key={preset.id} className="lw-geo-advanced-btn" onClick={() => selectPreset(preset)} title={preset.desc}>
                <span>{preset.name}</span>
                <small>{preset.desc}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      {symSettings.enabled && (
        <>
          <div className="lw-sec-header">
            <span>Tune</span>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 7px' }}
                    onClick={() => update({ enabled: false, type: 'none' })}>
              Turn off
            </button>
          </div>

          {isMirror && (
            <div className="lw-tweaks-seg" style={{ width: '100%' }}>
              {[['mirror-h', 'Top/bottom'], ['mirror-v', 'Left/right'], ['mirror-hv', 'Both']].map(([type, label]) => (
                <button key={type} className={symSettings.type === type ? 'active' : ''} onClick={() => update({ type, enabled: true })}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {isGuide && (
            <div className="lw-geo-controls">
              <div className="lw-geo-help">
                The guide becomes the pattern's motion source: distance from the line drives chases and ripples, and arrows show travel direction.
              </div>
              <div className="lw-geo-guide-map">
                <div><span className="dot line" /> Line</div>
                <div><span className="dot distance" /> Distance</div>
                <div><span className="dot arrows" /> Direction</div>
              </div>
              <div className="lw-geo-choice-row">
                <span>Mode</span>
                {[
                  ['fold', 'Flow out'],
                  ['reflect', 'One side'],
                  ['split', 'Split color'],
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    className={`btn ${symSettings.guide?.mode === mode ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => update({ enabled: true, type: 'guide-mirror', guide: { ...(symSettings.guide || {}), mode } })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="lw-geo-choice-row">
                <span>Snap</span>
                {[
                  ['vertical', 'Vertical', { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 }],
                  ['horizontal', 'Horizontal', { x1: 0.08, y1: 0.5, x2: 0.92, y2: 0.5 }],
                  ['diagonal', 'Diagonal', { x1: 0.18, y1: 0.12, x2: 0.82, y2: 0.88 }],
                ].map(([id, label, axis]) => (
                  <button
                    key={id}
                    className="btn btn-ghost"
                    onClick={() => update({ enabled: true, type: 'guide-mirror', guide: { ...(symSettings.guide || {}), axis } })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isRadial && (
            <div className="lw-geo-controls">
              <div className="lw-geo-choice-row">
                <span>Repeats</span>
                {[3, 4, 5, 6, 8, 12].map(count => (
                  <button
                    key={count}
                    className={`btn ${symSettings.count === count ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => update({ count, enabled: true, type: 'radial' })}
                  >
                    {count}
                  </button>
                ))}
              </div>
              <RangeRow
                label="Spin"
                min={-100}
                max={100}
                step={1}
                value={Math.round((symSettings.twist || 0) * 1000)}
                suffix=""
                onChange={value => update({ twist: value / 1000 })}
              />
              <RangeRow
                label="Angle"
                min={0}
                max={100}
                step={1}
                value={Math.round((symSettings.phase || 0) * 100)}
                suffix="%"
                onChange={value => update({ phase: value / 100 })}
              />
            </div>
          )}

          {isKaleido && (
            <div className="lw-geo-controls">
              <RangeRow
                label="Slices"
                min={2}
                max={16}
                step={1}
                value={symSettings.slices || 6}
                onChange={value => update({ slices: value, enabled: true, type: 'kaleido' })}
              />
              <RangeRow
                label="Angle"
                min={0}
                max={100}
                step={1}
                value={Math.round((symSettings.phase || 0) * 100)}
                suffix="%"
                onChange={value => update({ phase: value / 100 })}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
