import { useState } from 'react';

const SYM_NODES = [
  { id: 's1', kind: 'source',   title: 'Source',       x: 4,   y: 20,
    rows: [['active', 'aurora'], ['leds', '1 master']] },
  { id: 'g1', kind: 'group',    title: 'Inner petals', x: 4,   y: 130,
    rows: [['strips', 'L2, L3'], ['leds', '192']] },
  { id: 'g2', kind: 'group',    title: 'Outer ring',   x: 4,   y: 240,
    rows: [['strips', 'L1'], ['leds', '120']] },
  { id: 'g3', kind: 'group',    title: 'Base + dia.',  x: 4,   y: 350,
    rows: [['strips', 'L4, L5'], ['leds', '208']] },
  { id: 'm1', kind: 'mirror',   title: 'Mirror ×4',    x: 142, y: 60,
    rows: [['axes', 'H+V+D'], ['phase', '0°']] },
  { id: 'r1', kind: 'radial',   title: 'Radial 8',     x: 142, y: 170,
    rows: [['count', '8'], ['twist', '+0.1']] },
  { id: 'k1', kind: 'kaleido',  title: 'Kaleido 6',    x: 142, y: 280,
    rows: [['slices', '6'], ['flip', 'alt']] },
  { id: 'f1', kind: 'fractal',  title: 'Fractal',      x: 142, y: 390,
    rows: [['depth', '3'], ['scale', '0.5×']] },
  { id: 'o1', kind: 'output',   title: 'Out',          x: 280, y: 225,
    rows: [['leds', '520'], ['sync', 'locked']] },
];

const SYM_EDGES = [
  ['s1', 'm1'], ['g1', 'm1'], ['g2', 'r1'], ['s1', 'r1'],
  ['g3', 'k1'], ['s1', 'k1'], ['m1', 'o1'], ['r1', 'o1'], ['k1', 'o1'],
];

const KIND_META = {
  source:  { label: 'SOURCE',   color: 'var(--accent)',             dot: 'var(--accent)' },
  group:   { label: 'GROUP',    color: 'oklch(72% 0.08 220)',       dot: 'oklch(72% 0.08 220)' },
  mirror:  { label: 'MIRROR',   color: 'oklch(78% 0.13 340)',       dot: 'oklch(78% 0.13 340)' },
  radial:  { label: 'RADIAL',   color: 'oklch(80% 0.15 70)',        dot: 'oklch(80% 0.15 70)' },
  kaleido: { label: 'KALEIDO',  color: 'oklch(80% 0.14 155)',       dot: 'oklch(80% 0.14 155)' },
  fractal: { label: 'FRACTAL',  color: 'oklch(75% 0.13 290)',       dot: 'oklch(75% 0.13 290)' },
  output:  { label: 'OUTPUT',   color: 'var(--text-2)',             dot: 'var(--text-3)' },
};

function OpPreview({ kind }) {
  const c = 'var(--accent)';
  if (kind === 'mirror') {
    return (
      <svg viewBox="0 0 40 40" width="40" height="40">
        <line x1="20" y1="2" x2="20" y2="38" stroke="var(--border-2)" strokeDasharray="1.5 2"/>
        <line x1="2" y1="20" x2="38" y2="20" stroke="var(--border-2)" strokeDasharray="1.5 2"/>
        {[[12,12],[28,12],[12,28],[28,28]].map(([x,y],i) =>
          <circle key={i} cx={x} cy={y} r="2.5" fill={c} opacity={i===0?1:0.55}/>)}
      </svg>
    );
  }
  if (kind === 'radial') {
    return (
      <svg viewBox="0 0 40 40" width="40" height="40">
        <circle cx="20" cy="20" r="14" fill="none" stroke="var(--border-2)" strokeDasharray="1.5 2"/>
        {Array.from({ length: 8 }, (_, i) => {
          const a = (i * 360 / 8 - 90) * Math.PI / 180;
          return <circle key={i} cx={20 + Math.cos(a) * 12} cy={20 + Math.sin(a) * 12}
                         r={i === 0 ? 2.5 : 1.8} fill={c} opacity={i === 0 ? 1 : 0.55}/>;
        })}
      </svg>
    );
  }
  if (kind === 'kaleido') {
    return (
      <svg viewBox="0 0 40 40" width="40" height="40">
        {Array.from({ length: 6 }, (_, i) => {
          const a1 = (i * 60 - 90) * Math.PI / 180;
          const a2 = ((i + 1) * 60 - 90) * Math.PI / 180;
          return (
            <path key={i}
                  d={`M 20 20 L ${20 + Math.cos(a1) * 16} ${20 + Math.sin(a1) * 16} A 16 16 0 0 1 ${20 + Math.cos(a2) * 16} ${20 + Math.sin(a2) * 16} Z`}
                  fill={c} opacity={i % 2 === 0 ? 0.35 : 0.18} stroke="var(--border-2)" strokeWidth="0.5"/>
          );
        })}
      </svg>
    );
  }
  if (kind === 'fractal') {
    return (
      <svg viewBox="0 0 40 40" width="40" height="40">
        {[16, 10, 6, 3.5].map((r, i) =>
          <circle key={i} cx="20" cy="20" r={r} fill="none" stroke={c} opacity={0.85 - i * 0.15}/>)}
        <circle cx="20" cy="20" r="1.5" fill={c}/>
      </svg>
    );
  }
  return null;
}

export function SymmetryMode() {
  const [sel, setSel] = useState('m1');
  const byId = Object.fromEntries(SYM_NODES.map(n => [n.id, n]));
  const nodeW = 130, nodeH = 72;
  const portOut = n => ({ x: n.x + nodeW, y: n.y + nodeH / 2 });
  const portIn  = n => ({ x: n.x,         y: n.y + nodeH / 2 });
  const selNode = byId[sel];
  const selMeta = selNode && KIND_META[selNode.kind];

  return (
    <div>
      <div className="lw-sec-header">
        <span>Symmetry patch</span>
        <span className="meta">source → groups → operators → out</span>
      </div>

      <div className="lw-sym-canvas">
        <div className="lw-sym-rail" style={{ left: 2 }}><span>SOURCE · GROUPS</span></div>
        <div className="lw-sym-rail" style={{ left: 140 }}><span>OPERATORS</span></div>
        <div className="lw-sym-rail" style={{ left: 278 }}><span>OUT</span></div>

        <svg className="lw-sym-svg">
          <defs>
            <marker id="sym-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0 0 L5 3 L0 6 Z" fill="var(--border-2)"/>
            </marker>
          </defs>
          {SYM_EDGES.map(([a, b], i) => {
            const na = byId[a], nb = byId[b];
            if (!na || !nb) return null;
            const s = portOut(na), e = portIn(nb);
            const mx = (s.x + e.x) / 2;
            const d = `M ${s.x} ${s.y} C ${mx} ${s.y}, ${mx} ${e.y}, ${e.x} ${e.y}`;
            const isSel = a === sel || b === sel;
            return (
              <path key={i} d={d}
                    stroke={isSel ? KIND_META[byId[a].kind].color : 'var(--border-2)'}
                    strokeWidth={isSel ? 1.5 : 1} fill="none"
                    opacity={isSel ? 0.9 : 0.55}
                    markerEnd="url(#sym-arrow)"/>
            );
          })}
          {SYM_EDGES.filter(([a, b]) => a === sel || b === sel).map(([a, b], i) => {
            const na = byId[a], nb = byId[b];
            const s = portOut(na), e = portIn(nb);
            const mx = (s.x + e.x) / 2;
            return (
              <circle key={'f'+i} r="2.2" fill={KIND_META[na.kind].color}>
                <animateMotion dur="1.8s" repeatCount="indefinite"
                  path={`M ${s.x} ${s.y} C ${mx} ${s.y}, ${mx} ${e.y}, ${e.x} ${e.y}`}/>
              </circle>
            );
          })}
        </svg>

        {SYM_NODES.map(n => {
          const meta = KIND_META[n.kind];
          const isSel = n.id === sel;
          return (
            <div key={n.id}
                 className={`lw-sym-node ${isSel ? 'selected' : ''}`}
                 style={{
                   left: n.x, top: n.y, width: nodeW,
                   borderColor: isSel ? meta.color : 'var(--border)',
                   boxShadow: isSel ? `0 0 0 1px ${meta.color}, 0 6px 20px -8px ${meta.color}` : 'none',
                 }}
                 onClick={() => setSel(n.id)}>
              <div className="lw-sym-node-header">
                <span className="kind-dot" style={{ background: meta.dot }}/>
                <span className="label" style={{ color: meta.color }}>{meta.label}</span>
                <span className="title">{n.title}</span>
              </div>
              <div className="lw-sym-node-body">
                {['mirror','radial','kaleido','fractal'].includes(n.kind) && (
                  <div className="preview"><OpPreview kind={n.kind}/></div>
                )}
                <div className="rows">
                  {n.rows.map((r, i) => (
                    <div className="row" key={i}>
                      <span className="k">{r[0]}</span>
                      <span className="v">{r[1]}</span>
                    </div>
                  ))}
                </div>
              </div>
              {n.kind !== 'source' && n.kind !== 'group' && (
                <div className="lw-sym-port left" style={{ background: meta.color }}/>
              )}
              {n.kind !== 'output' && (
                <div className="lw-sym-port right" style={{ background: meta.color }}/>
              )}
            </div>
          );
        })}
      </div>

      <div className="lw-sec-header" style={{ marginTop: 20 }}>
        <span>Add operator</span>
        <span className="meta">drag into patch</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
        {[
          ['mirror',  'Mirror',       'H / V / ×4 / ×8'],
          ['radial',  'Radial',       'N-fold rotation'],
          ['kaleido', 'Kaleidoscope', 'wedge tile'],
          ['fractal', 'Fractal',      'self-repeat'],
        ].map(([k, name, desc]) => (
          <div key={k} style={{
            padding: '10px 10px 8px', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', background: 'var(--surface)',
            display: 'flex', flexDirection: 'column', gap: 6, cursor: 'grab',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <OpPreview kind={k}/>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600 }}>{name}</div>
                <div style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--mono-font)' }}>{desc}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {selNode && (
        <>
          <div className="lw-sec-header" style={{ marginTop: 20 }}>
            <span>Inspector · {selNode.title}</span>
            <span className="meta" style={{ color: selMeta.color }}>{selMeta.label}</span>
          </div>
          {selNode.kind === 'mirror' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {['H', 'V', 'Diag/', 'Diag\\'].map((ax) => (
                  <button key={ax} className="btn btn-primary" style={{ flex: 1, fontSize: 10 }}>{ax}</button>
                ))}
              </div>
              <div className="lw-tweaks-seg" style={{ width: '100%' }}>
                <button className="active">Reflect</button>
                <button>Rotate</button>
                <button>Invert</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
                <span style={{ width: 60, color: 'var(--text-3)' }}>Phase</span>
                <input type="range" min="0" max="360" defaultValue="0" style={{ flex: 1 }}/>
                <span style={{ fontFamily: 'var(--mono-font)', width: 34, textAlign: 'right' }}>0°</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
                <span style={{ width: 60, color: 'var(--text-3)' }}>Seam</span>
                <input type="range" min="0" max="100" defaultValue="20" style={{ flex: 1 }}/>
                <span style={{ fontFamily: 'var(--mono-font)', width: 34, textAlign: 'right' }}>0.20</span>
              </div>
            </div>
          )}
          {selNode.kind === 'radial' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                {[3,4,5,6,8,12].map(n => (
                  <button key={n} className={`btn ${n === 8 ? 'btn-primary' : ''}`}
                          style={{ flex: 1, fontSize: 11, fontFamily: 'var(--mono-font)' }}>{n}</button>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
                <span style={{ width: 60, color: 'var(--text-3)' }}>Twist</span>
                <input type="range" min="-100" max="100" defaultValue="10" style={{ flex: 1 }}/>
                <span style={{ fontFamily: 'var(--mono-font)', width: 44, textAlign: 'right' }}>+0.10 Hz</span>
              </div>
              <label style={{ fontSize: 10, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" defaultChecked/> Alternate mirror each slice
              </label>
            </div>
          )}
          {selNode.kind === 'kaleido' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
                <span style={{ width: 60, color: 'var(--text-3)' }}>Slices</span>
                <input type="range" min="2" max="16" defaultValue="6" style={{ flex: 1 }}/>
                <span style={{ fontFamily: 'var(--mono-font)', width: 34, textAlign: 'right' }}>6</span>
              </div>
              <div className="lw-tweaks-seg" style={{ width: '100%' }}>
                <button>None</button>
                <button className="active">Alt</button>
                <button>All</button>
              </div>
            </div>
          )}
          {selNode.kind === 'fractal' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
                <span style={{ width: 60, color: 'var(--text-3)' }}>Depth</span>
                <input type="range" min="1" max="6" defaultValue="3" style={{ flex: 1 }}/>
                <span style={{ fontFamily: 'var(--mono-font)', width: 34, textAlign: 'right' }}>3</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
                <span style={{ width: 60, color: 'var(--text-3)' }}>Scale</span>
                <input type="range" min="10" max="90" defaultValue="50" style={{ flex: 1 }}/>
                <span style={{ fontFamily: 'var(--mono-font)', width: 34, textAlign: 'right' }}>0.50×</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
                <span style={{ width: 60, color: 'var(--text-3)' }}>Rotate</span>
                <input type="range" min="0" max="180" defaultValue="22" style={{ flex: 1 }}/>
                <span style={{ fontFamily: 'var(--mono-font)', width: 44, textAlign: 'right' }}>22°/step</span>
              </div>
            </div>
          )}
          {selNode.kind === 'group' && (
            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.55 }}>
              Physical strips bundled from Layout. Edit membership on the Layout screen.
              <div style={{ marginTop: 8, fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-3)' }}>
                → feeds into {SYM_EDGES.filter(([a]) => a === sel).map(([,b]) => byId[b]?.title).join(', ') || '—'}
              </div>
            </div>
          )}
          {selNode.kind === 'source' && (
            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.55 }}>
              Uses the pattern authored in <strong>Cards</strong> / <strong>Code</strong>. Fan-out sends it to every operator.
            </div>
          )}
          {selNode.kind === 'output' && (
            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.55 }}>
              Combines all branches into the final per-LED buffer pushed to the device.
            </div>
          )}
        </>
      )}
    </div>
  );
}
