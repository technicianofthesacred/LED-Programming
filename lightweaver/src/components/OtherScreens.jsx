import { useState, useMemo, useRef } from 'react';
import { samplePath as libSamplePath, assignIndices, getAllPixels } from '../lib/mapper.js';
import { toWLEDLedmap, toFastLED, toCSV, download } from '../lib/export.js';
import { connectESP, disconnectESP, flashFirmware, fetchLatestWLEDRelease } from '../lib/flash.js';
import { DEMO_STRIPS } from '../data.js';
import { useProject } from '../state/ProjectContext.jsx';

// ── Layout screen ─────────────────────────────────────────────────────
const LAYERS = [
  { id: 'L1', name: 'ceiling-loop',   leds: 120, len: 2.00, brightness: 1.0,
    path: 'M 100 80 Q 200 40 320 80 T 540 80',
    emit: 'dir', angle: 0,   color: 'oklch(72% 0.15 210)' },
  { id: 'L2', name: 'left-spiral',    leds: 96,  len: 1.60, brightness: 0.9,
    path: 'M 90 180 C 90 260 180 260 180 180 C 180 140 140 140 140 180 Q 140 220 160 220',
    emit: 'dir', angle: 0,   color: 'oklch(78% 0.14 300)' },
  { id: 'L3', name: 'right-spiral',   leds: 96,  len: 1.60, brightness: 0.9,
    path: 'M 460 180 C 460 260 550 260 550 180 C 550 140 510 140 510 180 Q 510 220 530 220',
    emit: 'dir', angle: 180, color: 'oklch(78% 0.14 60)' },
  { id: 'L4', name: 'base-bar',       leds: 144, len: 2.40, brightness: 1.2,
    path: 'M 100 320 L 540 320',
    emit: 'dir', angle: 180, color: 'oklch(80% 0.15 155)' },
  { id: 'L5', name: 'diamond-top',    leds: 64,  len: 1.07, brightness: 1.4,
    path: 'M 320 120 L 360 160 L 320 200 L 280 160 Z',
    emit: 'omni', angle: 0, color: 'oklch(78% 0.17 30)' },
];

function samplePath(d, count) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  const len = p.getTotalLength ? p.getTotalLength() : 100;
  const out = [];
  const n = Math.min(count, 40);
  for (let i = 0; i < n; i++) {
    const pt = p.getPointAtLength((i / Math.max(n - 1, 1)) * len);
    const pt2 = p.getPointAtLength(Math.min(len, (i / Math.max(n - 1, 1)) * len + 1));
    out.push({ x: pt.x, y: pt.y, tx: pt2.x - pt.x, ty: pt2.y - pt.y });
  }
  return out;
}

let _gradSeq = 0;
function LightCone({ cx, cy, angle, color, intensity = 1, reach = 100 }) {
  const a = (angle - 90) * Math.PI / 180;
  const px = cx + Math.cos(a - Math.PI / 2) * reach;
  const py = cy + Math.sin(a - Math.PI / 2) * reach;
  const qx = cx + Math.cos(a + Math.PI / 2) * reach;
  const qy = cy + Math.sin(a + Math.PI / 2) * reach;
  const d = `M ${px} ${py} A ${reach} ${reach} 0 0 1 ${qx} ${qy} Z`;
  const gid = 'lcg-' + (_gradSeq++);
  return (
    <>
      <defs>
        <radialGradient id={gid} cx={cx} cy={cy} r={reach} gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor={color} stopOpacity={0.85 * intensity}/>
          <stop offset="30%"  stopColor={color} stopOpacity={0.3 * intensity}/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </radialGradient>
      </defs>
      <path d={d} fill={`url(#${gid})`} style={{ mixBlendMode: 'screen' }}/>
    </>
  );
}

function OmniHalo({ cx, cy, color, reach = 90, intensity = 1 }) {
  const gid = 'ohg-' + (_gradSeq++);
  return (
    <>
      <defs>
        <radialGradient id={gid} cx={cx} cy={cy} r={reach} gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor={color} stopOpacity={0.85 * intensity}/>
          <stop offset="30%"  stopColor={color} stopOpacity={0.3 * intensity}/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={reach} fill={`url(#${gid})`} style={{ mixBlendMode: 'screen' }}/>
    </>
  );
}

function DirectionCompass({ angle, emit, onAngle, onEmit }) {
  const size = 120;
  const cx = size / 2, cy = size / 2;
  const r = 44;

  const handleDrag = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const move = (ev) => {
      const dx = ev.clientX - (rect.left + cx);
      const dy = ev.clientY - (rect.top + cy);
      const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
      onAngle(Math.round(deg));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    move(e);
  };

  const a = (angle - 90) * Math.PI / 180;
  const ex = cx + Math.cos(a) * r, ey = cy + Math.sin(a) * r;

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <svg width={size} height={size} onMouseDown={emit === 'dir' ? handleDrag : undefined}
           style={{ cursor: emit === 'dir' ? 'crosshair' : 'default', flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={r + 6} fill="var(--bg)" stroke="var(--border)"/>
        <line x1={cx - r - 2} y1={cy} x2={cx + r - 4} y2={cy} stroke="var(--text-4)" strokeWidth="1" strokeDasharray="3 2"/>
        <polygon points={`${cx + r + 2},${cy} ${cx + r - 4},${cy - 3} ${cx + r - 4},${cy + 3}`} fill="var(--text-4)"/>
        <text x={cx} y={cy - r - 4} fontSize="8" fill="var(--text-4)" textAnchor="middle" fontFamily="var(--mono-font)">LEFT</text>
        <text x={cx} y={cy + r + 11} fontSize="8" fill="var(--text-4)" textAnchor="middle" fontFamily="var(--mono-font)">RIGHT</text>
        {emit === 'dir' && (() => {
          const px = cx + Math.cos(a - Math.PI / 2) * r;
          const py = cy + Math.sin(a - Math.PI / 2) * r;
          const qx = cx + Math.cos(a + Math.PI / 2) * r;
          const qy = cy + Math.sin(a + Math.PI / 2) * r;
          return <path d={`M ${px} ${py} A ${r} ${r} 0 0 1 ${qx} ${qy} Z`}
                       fill="var(--accent)" fillOpacity="0.22" stroke="var(--accent)" strokeWidth="1"/>;
        })()}
        {emit === 'omni' && (
          <circle cx={cx} cy={cy} r={r} fill="var(--accent)" opacity="0.15" stroke="var(--accent)" strokeDasharray="3 2"/>
        )}
        <circle cx={cx} cy={cy} r="2.5" fill="var(--accent)"/>
        {emit === 'dir' && (
          <>
            <line x1={cx} y1={cy} x2={ex} y2={ey} stroke="var(--accent-2)" strokeWidth="1.5"/>
            <circle cx={ex} cy={ey} r="2.5" fill="var(--accent-2)"/>
          </>
        )}
      </svg>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="lw-tweaks-seg" style={{ width: '100%' }}>
          <button className={emit === 'omni' ? 'active' : ''} onClick={() => onEmit('omni')}>Omni</button>
          <button className={emit === 'dir'  ? 'active' : ''} onClick={() => onEmit('dir')}>Directed</button>
        </div>
        {emit === 'dir' && (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 10 }}>
              <span style={{ width: 48, color: 'var(--text-3)' }}>Offset</span>
              <input type="range" min="0" max="359" value={angle} onChange={e => onAngle(+e.target.value)} style={{ flex: 1 }}/>
              <span style={{ fontFamily: 'var(--mono-font)', width: 34, textAlign: 'right' }}>{angle}°</span>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="btn" style={{ flex: 1, padding: '2px 4px', fontSize: 9 }} onClick={() => onAngle(0)}>↑ Left</button>
              <button className="btn" style={{ flex: 1, padding: '2px 4px', fontSize: 9 }} onClick={() => onAngle(180)}>↓ Right</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function LayoutScreen() {
  const [layers, setLayers] = useState(LAYERS);
  const [selId, setSelId]   = useState('L1');
  const [hidden, setHidden] = useState({});
  const [showLight, setShowLight] = useState(true);
  const [showLeds, setShowLeds]   = useState(true);

  const sel = layers.find(l => l.id === selId);
  const visibleLayers = layers.filter(l => !hidden[l.id]);
  const totalLeds = layers.reduce((a, l) => a + l.leds, 0);

  const updateSel = (patch) => {
    setLayers(layers.map(l => l.id === selId ? { ...l, ...patch } : l));
  };

  const sampled = useMemo(() =>
    Object.fromEntries(visibleLayers.map(l => [l.id, samplePath(l.path, l.leds)])),
    [visibleLayers.map(l => l.id + l.leds).join(',')]
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="lw-canvas-toolbar">
          <button className="btn btn-primary">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M6 1v8M3 5l3-4 3 4M1 10h10"/></svg>
            Import SVG
          </button>
          <span className="tbar-divider"/>
          <div className="tbar-group">
            <button className="btn">Select</button>
            <button className="btn btn-ghost">Pan</button>
          </div>
          <span className="tbar-divider"/>
          <span className="tbar-label">DENSITY</span>
          <select className="btn" style={{ padding: '4px 8px' }} defaultValue="60">
            <option value="30">30 /m</option><option value="60">60 /m</option>
            <option value="96">96 /m</option><option value="144">144 /m</option>
          </select>
          <span className="tbar-label" style={{ marginLeft: 12 }}>PITCH</span>
          <span style={{ fontFamily: 'var(--mono-font)', color: 'var(--text-2)', fontSize: 11 }}>16.6 mm</span>
          <div style={{ flex: 1 }}/>
          <button className={`btn ${showLight ? 'btn-primary' : ''}`} onClick={() => setShowLight(!showLight)}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="6" cy="6" r="2"/><path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11M2.5 2.5l1 1M8.5 8.5l1 1M2.5 9.5l1-1M8.5 3.5l1-1"/></svg>
            Show light
          </button>
          <button className={`btn ${showLeds ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setShowLeds(!showLeds)}>
            LEDs
          </button>
        </div>

        <div className="lw-viewport" style={{ display: 'grid', placeItems: 'center' }}>
          <svg viewBox="0 0 640 400" style={{ width: '92%', height: '92%' }}>
            <defs>
              <filter id="led-bloom" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2.5"/>
              </filter>
            </defs>

            {showLight && (
              <g>
                {visibleLayers.map(l => (
                  <g key={l.id} opacity={l.id === selId ? 1 : 0.6}>
                    {sampled[l.id]?.map((pt, i) => {
                      const b = l.brightness ?? 1;
                      if (l.emit === 'omni') {
                        return <OmniHalo key={i} cx={pt.x} cy={pt.y} color={l.color} reach={50 * b} intensity={0.5}/>;
                      }
                      const baseDeg = Math.atan2(pt.tx, -pt.ty) * 180 / Math.PI + 90;
                      const ledAngle = baseDeg + l.angle;
                      return <LightCone key={i} cx={pt.x} cy={pt.y} angle={ledAngle} color={l.color} reach={90 * b} intensity={0.5}/>;
                    })}
                  </g>
                ))}
              </g>
            )}

            {visibleLayers.map(l => (
              <path key={l.id + '-p'} d={l.path}
                    stroke={l.id === selId ? 'var(--text)' : 'oklch(58% 0.02 260)'}
                    strokeWidth={l.id === selId ? 1.5 : 1}
                    fill="none" strokeDasharray="2 3" opacity="0.8"/>
            ))}

            {sel && !hidden[sel.id] && sel.emit === 'dir' && sampled[sel.id]?.filter((_, i) => i % 4 === 0).map((pt, i) => {
              const baseDeg = Math.atan2(pt.tx, -pt.ty) * 180 / Math.PI + 90;
              const a = ((baseDeg + sel.angle) - 90) * Math.PI / 180;
              const ex = pt.x + Math.cos(a) * 18, ey = pt.y + Math.sin(a) * 18;
              return (
                <g key={'arr' + i} opacity="0.8">
                  <line x1={pt.x} y1={pt.y} x2={ex} y2={ey} stroke="var(--accent-2)" strokeWidth="1"/>
                  <circle cx={ex} cy={ey} r="1.5" fill="var(--accent-2)"/>
                </g>
              );
            })}

            {showLeds && (
              <>
                <g filter="url(#led-bloom)" opacity="0.7">
                  {visibleLayers.map(l =>
                    sampled[l.id]?.map((pt, i) =>
                      <circle key={l.id + i} cx={pt.x} cy={pt.y} r={3} fill={l.color}/>
                    )
                  )}
                </g>
                <g>
                  {visibleLayers.map(l =>
                    sampled[l.id]?.map((pt, i) =>
                      <circle key={l.id + i} cx={pt.x} cy={pt.y} r={1.3}
                              fill={l.id === selId ? 'white' : l.color}/>
                    )
                  )}
                </g>
              </>
            )}
          </svg>

          <div className="lw-viewport-overlay tl">
            <div><span className="k">imported</span> <span className="v">willow-canopy.svg</span></div>
            <div><span className="k">layers</span> <span className="v">{layers.length} · {totalLeds} LEDs</span></div>
          </div>
          <div className="lw-viewport-overlay br">
            <div><span className="k">{sel?.name}</span></div>
            <div><span className="k">emit</span> <span className="v">
              {sel?.emit === 'omni' ? 'omnidirectional' : `follows path · ${sel?.angle >= 0 ? '+' : ''}${sel?.angle}° offset`}
            </span></div>
          </div>

          <div className="lw-zoom-controls">
            <button>+</button>
            <div className="lw-zoom-level">100%</div>
            <button>−</button>
            <button style={{ fontSize: 9 }}>1:1</button>
          </div>
        </div>
      </div>

      <div className="lw-panel" style={{ borderLeft: '1px solid var(--border)' }}>
        <div className="lw-panel-body">
          <div className="lw-sec-header">
            <span>Illustrator Layers</span>
            <span className="meta">{layers.length} · {totalLeds} LED</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {layers.map(l => {
              const isSel = l.id === selId;
              const isHidden = !!hidden[l.id];
              return (
                <div key={l.id}
                     onClick={() => setSelId(l.id)}
                     style={{
                       display:'flex', alignItems:'center', gap: 8,
                       padding: '7px 10px',
                       background: isSel ? 'var(--surface-2)' : 'transparent',
                       border: '1px solid ' + (isSel ? 'var(--accent)' : 'var(--border)'),
                       borderRadius: 'var(--r-sm)',
                       cursor: 'pointer',
                       opacity: isHidden ? 0.45 : 1,
                     }}>
                  <button onClick={(e) => { e.stopPropagation(); setHidden({ ...hidden, [l.id]: !isHidden }); }}
                          style={{ color: 'var(--text-3)', width: 14, height: 14, display: 'grid', placeItems: 'center' }}>
                    {isHidden
                      ? <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1"><path d="M1 1l10 10M2 6s1.5-3 4-3 4 3 4 3"/></svg>
                      : <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1"><path d="M1 6s2-3 5-3 5 3 5 3-2 3-5 3-5-3-5-3z"/><circle cx="6" cy="6" r="1.5"/></svg>}
                  </button>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: l.color, boxShadow: '0 0 6px ' + l.color, flexShrink: 0 }}/>
                  <span style={{ fontSize: 12, flex: 1, fontFamily: 'var(--mono-font)', color: isSel ? 'var(--text)' : 'var(--text-2)' }}>{l.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono-font)' }}>
                    {l.emit === 'omni' ? '◉' : `↗${l.angle}°`}
                  </span>
                  <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-3)', minWidth: 32, textAlign: 'right' }}>{l.leds}</span>
                </div>
              );
            })}
          </div>

          {sel && (
            <>
              <div className="lw-sec-header" style={{ marginTop: 20 }}>
                <span>Inspector · {sel.name}</span>
                <span className="meta">{sel.emit}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '8px 12px', fontSize: 11, marginBottom: 14 }}>
                <span style={{ color: 'var(--text-3)' }}>Length</span>
                <span style={{ fontFamily: 'var(--mono-font)' }}>{sel.len.toFixed(2)} m</span>
                <span style={{ color: 'var(--text-3)' }}>LEDs</span>
                <input type="number" value={sel.leds} min="1" max="512"
                       onChange={e => updateSel({ leds: +e.target.value })}
                       style={{ fontFamily: 'var(--mono-font)', fontSize: 11, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 6px', width: 70 }}/>
                <span style={{ color: 'var(--text-3)' }}>Color tag</span>
                <div style={{ width: 20, height: 16, borderRadius: 3, background: sel.color, border: '1px solid var(--border-2)' }}/>
                <span style={{ color: 'var(--text-3)' }}>Brightness</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="range" min="0" max="2" step="0.05" value={sel.brightness ?? 1}
                         onChange={e => updateSel({ brightness: +e.target.value })}
                         style={{ flex: 1 }}/>
                  <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, width: 34, textAlign: 'right', color: 'var(--text-2)' }}>
                    {Math.round((sel.brightness ?? 1) * 100)}%
                  </span>
                </div>
              </div>

              <div className="lw-sec-header">
                <span>Emit direction</span>
                <span className="meta">where the light shines</span>
              </div>
              <DirectionCompass
                angle={sel.angle} emit={sel.emit}
                onAngle={a => updateSel({ angle: a })}
                onEmit={e => updateSel({ emit: e })}
              />

              <div style={{ marginTop: 12, fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-4)', lineHeight: 1.5, padding: 10, background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 'var(--r-sm)' }}>
                Affects the preview's directed glow — not the pattern math. Drag the compass or use sliders.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Export screen ─────────────────────────────────────────────────────
export function ExportScreen() {
  const { strips: projectStrips, viewBox } = useProject();

  const [normalize, setNormalize] = useState(true);
  const [scaleX, setScaleX]       = useState(1.0);
  const [scaleY, setScaleY]       = useState(1.0);
  const [offsetX, setOffsetX]     = useState(0);
  const [offsetY, setOffsetY]     = useState(0);

  const sourceStrips = (projectStrips && projectStrips.length > 0) ? projectStrips : DEMO_STRIPS;
  const usingDemo = !(projectStrips && projectStrips.length > 0);

  const pixels = useMemo(() => {
    const withPixels = sourceStrips.map(s => {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', s.path);
      const px = libSamplePath(pathEl, s.leds);
      return { ...s, pixels: px };
    });
    assignIndices(withPixels);
    return getAllPixels(withPixels);
  }, [sourceStrips]);

  const exportOpts = { normalize, scaleX, scaleY, offsetX, offsetY };

  const ledmapJson = useMemo(() => toWLEDLedmap(pixels, exportOpts), [pixels, normalize, scaleX, scaleY, offsetX, offsetY]);
  const previewJson = ledmapJson.slice(0, 400) + '\n  …';

  const totalLeds = sourceStrips.reduce((a, s) => a + (s.leds || 0), 0);

  const artifacts = [
    {
      file: 'ledmap.json', desc: 'WLED 2D layout',
      size: `${(ledmapJson.length / 1024).toFixed(1)} KB`,
      action: () => download(ledmapJson, 'ledmap.json', 'application/json'),
    },
    {
      file: 'ledmap.h', desc: 'FastLED C++ header',
      size: `${(toFastLED(pixels, exportOpts).length / 1024).toFixed(1)} KB`,
      action: () => download(toFastLED(pixels, exportOpts), 'ledmap.h', 'text/plain'),
    },
    {
      file: 'positions.csv', desc: 'normalized 0–1',
      size: `${(toCSV(pixels).length / 1024).toFixed(1)} KB`,
      action: () => download(toCSV(pixels), 'positions.csv', 'text/csv'),
    },
  ];

  const numInput = (val, setter, step = 0.01) => (
    <input
      type="number" value={val} step={step}
      onChange={e => setter(parseFloat(e.target.value) || 0)}
      style={{ fontFamily: 'var(--mono-font)', fontSize: 11, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 6px', width: 72 }}
    />
  );

  return (
    <div style={{ padding: 40, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, overflow: 'auto', height: '100%' }}>
      <div>
        {usingDemo && (
          <div style={{ padding: '10px 14px', marginBottom: 20, background: 'var(--surface)', border: '1px dashed var(--border-2)', borderRadius: 'var(--r-sm)', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono-font)' }}>
            No strips in project — showing demo data. Draw strips on the Layout screen to export your real layout.
          </div>
        )}

        <div className="lw-sec-header"><span>Layout summary</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '6px 12px', fontSize: 11, marginBottom: 20, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
          <span style={{ color: 'var(--text-3)' }}>Total LEDs</span>
          <span style={{ fontFamily: 'var(--mono-font)', fontWeight: 600 }}>{totalLeds.toLocaleString()}</span>
          <span style={{ color: 'var(--text-3)' }}>Strips</span>
          <span style={{ fontFamily: 'var(--mono-font)' }}>{sourceStrips.length}</span>
          <span style={{ color: 'var(--text-3)' }}>View box</span>
          <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-3)' }}>{viewBox || '0 0 640 400'}</span>
        </div>

        <div className="lw-sec-header" style={{ marginTop: 4 }}>
          <span>Coordinate options</span>
          <span className="meta">WLED + FastLED exports</span>
        </div>
        <div style={{ padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, marginBottom: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={normalize} onChange={e => setNormalize(e.target.checked)}/>
            <span style={{ color: 'var(--text-2)' }}>Normalize coordinates</span>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 64px 1fr', gap: '8px 12px', alignItems: 'center', fontSize: 11 }}>
            <span style={{ color: 'var(--text-3)' }}>Scale X</span>
            {numInput(scaleX, setScaleX, 0.01)}
            <span style={{ color: 'var(--text-3)' }}>Scale Y</span>
            {numInput(scaleY, setScaleY, 0.01)}
            <span style={{ color: 'var(--text-3)' }}>Offset X</span>
            {numInput(offsetX, setOffsetX, 1)}
            <span style={{ color: 'var(--text-3)' }}>Offset Y</span>
            {numInput(offsetY, setOffsetY, 1)}
          </div>
        </div>

        <div className="lw-sec-header" style={{ marginTop: 4 }}>
          <span>Strips</span>
          <span className="meta">{sourceStrips.length} · {totalLeds} LED</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 20 }}>
          {sourceStrips.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', fontSize: 11 }}>
              {s.color && (
                <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, boxShadow: `0 0 5px ${s.color}`, flexShrink: 0 }}/>
              )}
              <span style={{ flex: 1, fontFamily: 'var(--mono-font)', color: 'var(--text-2)' }}>{s.name}</span>
              <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-3)', minWidth: 28, textAlign: 'right' }}>{s.leds}</span>
            </div>
          ))}
        </div>

        <div className="lw-sec-header" style={{ marginTop: 8 }}>
          <span>Artifacts</span>
          <span className="meta">{pixels.length} LEDs · {sourceStrips.length} strips</span>
        </div>
        {artifacts.map(({ file, desc, size, action }) => (
          <div key={file} style={{ display:'flex', alignItems:'center', gap: 12, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 6 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth="1.3"><path d="M3 2h7l3 3v9H3z"/><path d="M10 2v3h3"/></svg>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--mono-font)', fontSize: 12 }}>{file}</div>
              <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{desc} · {size}</div>
            </div>
            <button className="btn" onClick={action}>Download</button>
          </div>
        ))}
      </div>

      <div>
        <div className="lw-sec-header"><span>ledmap.json preview</span><span className="meta">live</span></div>
        <pre style={{ fontFamily: 'var(--mono-font)', fontSize: 11, color: 'var(--text-2)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 14, lineHeight: 1.5, overflow: 'auto', maxHeight: 400 }}>
          {previewJson}
        </pre>
      </div>
    </div>
  );
}

// ── Flash screen ──────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function FlashScreen() {
  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator;

  const [connected, setConnected]     = useState(false);
  const [connecting, setConnecting]   = useState(false);
  const [flashing, setFlashing]       = useState(false);
  const [progress, setProgress]       = useState(0);
  const [status, setStatus]           = useState('');
  const [statusKind, setStatusKind]   = useState('');
  const [log, setLog]                 = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [address, setAddress]         = useState('0x0');
  const [eraseAll, setEraseAll]       = useState(false);
  const [release, setRelease]         = useState(null);
  const [fetchingRelease, setFetchingRelease] = useState(false);

  const loaderRef    = useRef(null);
  const transportRef = useRef(null);
  const fileInputRef = useRef(null);
  const logRef       = useRef(null);

  const appendLog = (line) => {
    setLog(prev => prev + line + '\n');
    setTimeout(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, 0);
  };

  const setStatusMsg = (msg, kind = '') => {
    setStatus(msg);
    setStatusKind(kind);
  };

  const handleConnect = async () => {
    if (connected) {
      setConnecting(true);
      await disconnectESP(loaderRef.current, transportRef.current);
      loaderRef.current = null;
      transportRef.current = null;
      setConnected(false);
      setConnecting(false);
      setStatusMsg('Disconnected');
      return;
    }
    setConnecting(true);
    setStatusMsg('Select serial port…');
    try {
      const { loader, transport, chip } = await connectESP();
      loaderRef.current    = loader;
      transportRef.current = transport;
      setConnected(true);
      setStatusMsg(`● ${chip}`, 'connected');
      appendLog(`Connected: ${chip}`);
    } catch (err) {
      const msg = err.message ?? String(err);
      setStatusMsg(`✕ ${msg}`, 'error');
      appendLog(`Connection failed: ${msg}`);
      if (msg.includes('Failed to connect') || msg.includes('sync')) {
        appendLog('→ Hold BOOT → press+release RESET → release BOOT → then Connect');
      }
      loaderRef.current = null;
      transportRef.current = null;
    } finally {
      setConnecting(false);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setRelease(null);
  };

  const handleFetchRelease = async () => {
    setFetchingRelease(true);
    setStatusMsg('Checking GitHub…');
    try {
      const info = await fetchLatestWLEDRelease();
      setRelease(info);
      setStatusMsg(`Found ${info.tagName}`);
    } catch (err) {
      setStatusMsg(`✕ ${err.message}`, 'error');
      appendLog(`GitHub fetch failed: ${err.message}`);
    } finally {
      setFetchingRelease(false);
    }
  };

  const handleOpenDownload = () => {
    if (!release) return;
    window.open(release.asset.downloadUrl, '_blank');
    appendLog(`Opening download for ${release.asset.name} — save the file, then use Browse to select it.`);
    setStatusMsg('Save the downloaded file, then use Browse ↑');
  };

  const handleFlash = async () => {
    if (!selectedFile || !loaderRef.current) return;
    const addr = parseInt(address, 16);
    if (isNaN(addr)) { setStatusMsg('Invalid flash address', 'error'); return; }

    setFlashing(true);
    setProgress(0);
    setStatusMsg(eraseAll ? 'Erasing flash…' : 'Flashing…');
    appendLog(`Flashing ${fmtSize(selectedFile.size)} @ 0x${addr.toString(16).toUpperCase()}${eraseAll ? '  [erase all]' : ''}…`);
    if (eraseAll) appendLog('Erasing flash — this takes ~15 s…');

    try {
      await flashFirmware(loaderRef.current, selectedFile, addr, eraseAll, (pct) => {
        setProgress(pct);
        setStatusMsg(`Flashing… ${Math.round(pct * 100)}%`);
      });
      setProgress(1);
      setStatusMsg('● Flash complete — WLED is booting', 'connected');
      appendLog('Flash complete. WLED should start in a few seconds.');
    } catch (err) {
      setStatusMsg(`✕ Flash failed: ${err.message ?? err}`, 'error');
      appendLog(`Error: ${err.message ?? err}`);
    } finally {
      setFlashing(false);
    }
  };

  const statusColor = statusKind === 'connected'
    ? 'oklch(72% 0.18 155)'
    : statusKind === 'error'
      ? 'oklch(72% 0.15 30)'
      : 'var(--text-3)';

  const canConnect = hasWebSerial && !connecting && !flashing;
  const canFlash   = connected && !!selectedFile && !flashing;

  return (
    <div style={{ padding: 40, maxWidth: 680, margin: '0 auto', height: '100%', overflow: 'auto' }}>

      {!hasWebSerial && (
        <div style={{ padding: '10px 14px', marginBottom: 20, background: 'oklch(28% 0.04 30)', border: '1px solid oklch(45% 0.12 30)', borderRadius: 'var(--r-sm)', fontSize: 11, color: 'oklch(72% 0.15 30)' }}>
          Web Serial requires Chrome or Edge. In-browser flashing is not available in your current browser.
        </div>
      )}

      <div className="lw-sec-header"><span>Bootloader mode</span><span className="meta">do this before connecting</span></div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
        {[
          { step: 1, label: 'Hold BOOT',    sub: 'GPIO0 pin' },
          { step: 2, label: 'Press RESET',  sub: 'EN pin — then release' },
          { step: 3, label: 'Release BOOT', sub: 'then click Connect' },
        ].map(({ step, label, sub }) => (
          <div key={step} style={{ flex: 1, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
            <div style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-4)' }}>STEP {step}</div>
            <div style={{ fontSize: 13, marginTop: 4, fontWeight: 500 }}>{label}</div>
            <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 3 }}>{sub}</div>
          </div>
        ))}
      </div>

      <div className="lw-sec-header"><span>Firmware</span></div>
      <div style={{ padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <button className="btn" onClick={handleFetchRelease} disabled={fetchingRelease}>
            {fetchingRelease ? 'Checking…' : 'Fetch latest WLED'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-4)' }}>or</span>
          <button className="btn" onClick={() => fileInputRef.current?.click()}>Browse…</button>
          <input ref={fileInputRef} type="file" accept=".bin" style={{ display: 'none' }} onChange={handleFileChange}/>
        </div>

        {release && (
          <div style={{ padding: '10px 12px', marginBottom: 12, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', fontSize: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: '4px 10px', alignItems: 'baseline' }}>
                <span style={{ color: 'var(--text-4)' }}>Version</span>
                <span style={{ fontFamily: 'var(--mono-font)', fontWeight: 600 }}>{release.tagName}</span>
                <span style={{ color: 'var(--text-4)' }}>Date</span>
                <span style={{ fontFamily: 'var(--mono-font)' }}>{release.date}</span>
                <span style={{ color: 'var(--text-4)' }}>File</span>
                <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, wordBreak: 'break-all' }}>{release.asset.name}</span>
                <span style={{ color: 'var(--text-4)' }}>Size</span>
                <span style={{ fontFamily: 'var(--mono-font)' }}>{fmtSize(release.asset.size)}</span>
              </div>
              <button className="btn btn-primary" onClick={handleOpenDownload} style={{ flexShrink: 0 }}>
                Open download
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono-font)' }}>
              Save the file, then use Browse above to select it.
            </div>
          </div>
        )}

        {selectedFile && (
          <div style={{ fontSize: 11, fontFamily: 'var(--mono-font)', color: 'var(--text-2)', padding: '6px 0' }}>
            {selectedFile.name} ({fmtSize(selectedFile.size)})
          </div>
        )}
      </div>

      <div className="lw-sec-header"><span>Flash options</span></div>
      <div style={{ padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '8px 12px', alignItems: 'center', fontSize: 11 }}>
          <span style={{ color: 'var(--text-3)' }}>Address</span>
          <input
            type="text" value={address}
            onChange={e => setAddress(e.target.value)}
            style={{ fontFamily: 'var(--mono-font)', fontSize: 11, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 8px', width: 90 }}
          />
          <span style={{ color: 'var(--text-3)' }}>Erase all</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={eraseAll} onChange={e => setEraseAll(e.target.checked)}/>
            <span style={{ color: 'var(--text-4)', fontSize: 10 }}>takes ~15 s</span>
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button
          className={`btn ${connected ? '' : 'btn-primary'}`}
          onClick={handleConnect}
          disabled={!canConnect}
        >
          {connecting ? (connected ? 'Disconnecting…' : 'Connecting…') : connected ? 'Disconnect' : 'Connect'}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleFlash}
          disabled={!canFlash}
          title={!connected ? 'Connect device first' : !selectedFile ? 'Select firmware first' : 'Flash firmware'}
        >
          Flash firmware
        </button>
        {status && (
          <span style={{ fontSize: 11, fontFamily: 'var(--mono-font)', color: statusColor, flex: 1 }}>
            {status}
          </span>
        )}
      </div>

      <div style={{ marginBottom: 16, height: 6, background: 'var(--surface)', borderRadius: 99, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <div style={{ height: '100%', width: `${Math.round(progress * 100)}%`, background: 'var(--accent)', borderRadius: 99, transition: 'width 0.15s' }}/>
      </div>

      <div className="lw-sec-header"><span>Log</span><span className="meta">{Math.round(progress * 100)}%</span></div>
      <textarea
        ref={logRef}
        readOnly
        value={log}
        style={{
          width: '100%', height: 180, resize: 'vertical', boxSizing: 'border-box',
          fontFamily: 'var(--mono-font)', fontSize: 10, lineHeight: 1.6,
          background: 'var(--bg)', color: 'var(--text-2)',
          border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px',
        }}
      />
    </div>
  );
}
