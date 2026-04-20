import { useState, useEffect, useRef, useMemo } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { PATTERNS, DEFAULT_PARAMS, PATTERN_CODE, GRAPH_NODES, GRAPH_EDGES } from '../data.js';
import { compile } from '../lib/patterns.js';

// ── CARDS mode ────────────────────────────────────────────────────────
export function CardsMode({ patternId, onSelectPattern, params, onParamChange, palette }) {
  const cur = PATTERNS.find(p => p.id === patternId);
  const knobs = DEFAULT_PARAMS[patternId] || [];

  return (
    <div>
      <div className="lw-sec-header">
        <span>Library</span>
        <span className="meta">{PATTERNS.length} effects · built-in</span>
      </div>
      <div className="lw-pattern-grid">
        {PATTERNS.map(p => (
          <div key={p.id}
               className={`lw-pattern-card ${p.id === patternId ? 'selected' : ''}`}
               onClick={() => onSelectPattern(p.id)}>
            <div className="bg" style={{ background: p.preview }} />
            <div className="scrim" />
            <div className="label">
              <span>{p.name}</span>
              <span className="play-hint">
                <svg width="7" height="7" viewBox="0 0 7 7"><path d="M1 1 L6 3.5 L1 6 Z" fill="white"/></svg>
              </span>
            </div>
          </div>
        ))}
      </div>

      {knobs.length > 0 && (
        <>
          <div className="lw-sec-header">
            <span>{cur?.name} · parameters</span>
            <span className="meta">@param</span>
          </div>
          <div className="lw-knobs">
            {knobs.map((k) => (
              <div className="lw-knob" key={k.name}>
                <div className="lw-knob-name">{k.name}</div>
                <input type="range"
                       min={k.min} max={k.max} step={k.step}
                       value={params[k.name] ?? k.value}
                       onChange={e => onParamChange(k.name, +e.target.value)} />
                <div className="lw-knob-val">{(params[k.name] ?? k.value).toFixed(k.step < 0.05 ? 3 : 2)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="lw-sec-header">
        <span>Palette</span>
        <span className="meta">6 colors · shared</span>
      </div>
      <div className="lw-palette">
        {palette.map((c, i) => (
          <div key={i} className="lw-palette-swatch" style={{ background: c }} title={c} />
        ))}
      </div>
    </div>
  );
}

// ── CODE mode ─────────────────────────────────────────────────────────
export function CodeMode({ patternId, onCodeChange }) {
  const editorRef = useRef(null);
  const viewRef = useRef(null);
  const [status, setStatus] = useState({ ok: true, error: null, lines: 0, bytes: 0 });
  const tryCompileRef = useRef(null);

  const initialCode = PATTERN_CODE[patternId] || '// Select a pattern\nreturn hsv(x, 1, 1);';

  // Try to compile and report status
  const tryCompile = (code) => {
    const { fn, error } = compile(code);
    const lines = code.split('\n').length;
    const bytes = new TextEncoder().encode(code).length;
    setStatus({ ok: !error, error, lines, bytes });
    if (onCodeChange) onCodeChange({ code, fn, error });
    return { fn, error };
  };

  // Keep ref always pointing at latest tryCompile (avoids stale closure in effects)
  tryCompileRef.current = tryCompile;

  // Mount CodeMirror
  useEffect(() => {
    if (!editorRef.current) return;

    const updateListener = EditorView.updateListener.of(update => {
      if (update.docChanged) {
        const code = update.state.doc.toString();
        tryCompileRef.current?.(code);
      }
    });

    const view = new EditorView({
      doc: initialCode,
      extensions: [
        basicSetup,
        javascript(),
        oneDark,
        updateListener,
        EditorView.theme({
          '&': { fontSize: '11px', height: '100%' },
          '.cm-scroller': { fontFamily: 'var(--mono-font)', lineHeight: '1.6' },
          '.cm-content': { padding: '6px 0' },
        }),
      ],
      parent: editorRef.current,
    });

    viewRef.current = view;
    tryCompileRef.current?.(initialCode);

    return () => view.destroy();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap code when patternId changes and retrigger compile so parent gets the new fn
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const newCode = PATTERN_CODE[patternId] || '// Select a pattern\nreturn hsv(x, 1, 1);';
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newCode },
    });
    tryCompileRef.current?.(newCode);
  }, [patternId]);

  return (
    <div>
      <div className="lw-sec-header">
        <span>Code editor</span>
        <span className="meta">JS · CodeMirror</span>
      </div>
      <div className="lw-code-wrap">
        <div className="lw-code-tabs">
          <div className="lw-code-tab active">pattern.js</div>
          <div className="lw-code-tab">api.md</div>
        </div>
        <div ref={editorRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }} />
        <div className="lw-code-footer">
          <span>
            <span className="dot" style={{ background: status.ok ? 'var(--mint)' : 'var(--accent-2)' }}/>
            {status.ok ? 'compiled · 0 errors' : status.error}
          </span>
          <span>{status.lines} lines · {status.bytes} bytes</span>
        </div>
      </div>

      <div className="lw-sec-header"><span>Quick reference</span></div>
      <div style={{ fontFamily: 'var(--mono-font)', fontSize: '10.5px', color: 'var(--text-3)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
        <div><span style={{color:'var(--text-2)'}}>index, x, y, t, time</span> — per-pixel inputs</div>
        <div><span style={{color:'var(--text-2)'}}>hsv(h,s,v)</span> — color, all 0–1 → return&#123;r,g,b&#125;</div>
        <div><span style={{color:'var(--text-2)'}}>noise(x,y), fbm(x,y,oct)</span> — organic noise</div>
        <div><span style={{color:'var(--text-2)'}}>polar(x,y)</span> — &#123;r, a&#125; from center</div>
        <div><span style={{color:'var(--text-2)'}}>beat, beatSin</span> — BPM sync 0–1</div>
        <div><span style={{color:'var(--text-2)'}}>params.*</span> — @param knob values</div>
      </div>
    </div>
  );
}

// ── GRAPH mode ────────────────────────────────────────────────────────
export function GraphMode() {
  const [sel, setSel] = useState('n6');
  const nodes = GRAPH_NODES;
  const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
  const portOut = n => ({ x: n.x + 140, y: n.y + 18 });
  const portIn  = n => ({ x: n.x,       y: n.y + 18 });

  return (
    <div>
      <div className="lw-sec-header">
        <span>Node graph</span>
        <span className="meta">experimental · patch editor</span>
      </div>
      <div className="lw-graph-wrap">
        <div className="lw-graph-toolbar">
          <button><svg viewBox="0 0 12 12" fill="none" stroke="currentColor"><path d="M6 2v8M2 6h8" strokeWidth="1.5"/></svg>Add</button>
          <button><svg viewBox="0 0 12 12" fill="none" stroke="currentColor"><path d="M3 3l6 6M9 3l-6 6" strokeWidth="1.5"/></svg>Unlink</button>
          <button>Fit</button>
        </div>

        <svg className="lw-graph-svg">
          {GRAPH_EDGES.map(([a, b], i) => {
            const na = nodeById[a], nb = nodeById[b];
            if (!na || !nb) return null;
            const s = portOut(na), e = portIn(nb);
            const cx = (s.x + e.x) / 2;
            const d = `M ${s.x} ${s.y} C ${cx} ${s.y}, ${cx} ${e.y}, ${e.x} ${e.y}`;
            return <path key={i} d={d} stroke="oklch(46% 0.02 260)" strokeWidth="1.5" fill="none" />;
          })}
          {GRAPH_EDGES.filter(([a,b]) => b === sel || a === sel).map(([a, b], i) => {
            const na = nodeById[a], nb = nodeById[b];
            const s = portOut(na), e = portIn(nb);
            const cx = (s.x + e.x) / 2;
            const d = `M ${s.x} ${s.y} C ${cx} ${s.y}, ${cx} ${e.y}, ${e.x} ${e.y}`;
            return <path key={i} d={d} stroke="var(--accent)" strokeWidth="1.5" fill="none" strokeDasharray="4 4">
              <animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.8s" repeatCount="indefinite"/>
            </path>;
          })}
        </svg>

        {nodes.map(n => (
          <div key={n.id}
               className={`lw-graph-node kind-${n.kind} ${n.id === sel ? 'selected' : ''}`}
               style={{ left: n.x, top: n.y }}
               onClick={() => setSel(n.id)}>
            <div className="lw-graph-node-header">
              <span className="kind-dot"/>
              <span>{n.title}</span>
            </div>
            <div className="lw-graph-node-body">
              {n.rows.map((r, i) => (
                <div className="row" key={i}><span className="k">{r[0]}</span><span>{r[1]}</span></div>
              ))}
            </div>
            {n.kind !== 'source' && <div className="lw-graph-port left" />}
            {n.kind !== 'output' && <div className={`lw-graph-port right ${n.id === sel ? 'active' : ''}`} />}
          </div>
        ))}

        <div className="lw-graph-legend">
          <span className="item"><span className="d" style={{background:'var(--accent)'}}/>Source</span>
          <span className="item"><span className="d" style={{background:'oklch(76% 0.14 340)'}}/>Modifier</span>
          <span className="item"><span className="d" style={{background:'var(--accent-2)'}}/>Color</span>
          <span className="item"><span className="d" style={{background:'var(--mint)'}}/>Output</span>
        </div>
      </div>

      <div className="lw-sec-header">
        <span>{nodeById[sel]?.title} · inspector</span>
        <span className="meta">{nodeById[sel]?.kind}</span>
      </div>
      <div className="lw-knobs">
        {(nodeById[sel]?.rows || []).map((r, i) => (
          <div className="lw-knob" key={i}>
            <div className="lw-knob-name">{r[0]}</div>
            <input type="range" min="0" max="1" step="0.01" defaultValue={0.5} />
            <div className="lw-knob-val">{r[1]}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
