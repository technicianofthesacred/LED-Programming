/* global React, window */
/* Light Weaver v3 — Layout screen (full SVG → strip workflow) */
(function () {
  const { useState } = React;
  const { I } = window.LW;

  const LAYERS = [
    { id: "l1", name: "Canopy spine", colorVar: "--layer-1", length: 551, density: 60, ledCount: 33, emit: "Directed", angle: -18, bright: 100, subPaths: 1,
      d: "M70 432 C 230 300, 360 300, 480 380 C 590 452, 700 470, 800 452 C 870 440, 920 410, 952 388", bbox: [62, 292, 898, 196] },
    { id: "l2", name: "Center ring", colorVar: "--layer-2", length: 503, density: 60, ledCount: 30, emit: "Directed", angle: 0, bright: 90, subPaths: 1,
      ring: { cx: 480, cy: 358, r: 120 }, bbox: [352, 230, 256, 256] },
    { id: "l3", name: "Lower arc", colorVar: "--layer-3", length: 960, density: 60, ledCount: 57, emit: "Omni", angle: 90, bright: 80, subPaths: 2,
      d: "M120 566 C 330 476, 650 476, 880 566", bbox: [110, 470, 780, 112] },
  ];
  const COLOR_TAGS = ["--layer-1", "--layer-2", "--layer-3", "oklch(0.70 0.09 210)", "oklch(0.66 0.12 320)"];

  function Canvas({ selId, lit, showLeds, zoom }) {
    const cssVar = (v) => `var(${v})`;
    const sel = LAYERS.find((l) => l.id === selId);
    const render = (l) => {
      const isSel = l.id === selId;
      const col = cssVar(l.colorVar);
      const dim = isSel ? 1 : 0.32;
      const filter = lit && isSel ? "url(#lglow)" : "none";
      const common = { fill: "none", stroke: col, strokeLinecap: "round" };
      if (l.ring) {
        const { cx, cy, r } = l.ring; const circ = 2 * Math.PI * r;
        return (
          <g key={l.id} opacity={dim} filter={filter}>
            <circle cx={cx} cy={cy} r={r} {...common} strokeWidth={isSel ? 2 : 1.5} opacity={0.32} />
            {showLeds && <circle cx={cx} cy={cy} r={r} {...common} strokeWidth={isSel ? 6 : 4.5} strokeDasharray={`0.1 ${circ / 30}`} />}
            {lit && isSel && showLeds && <circle cx={cx} cy={cy} r={r} fill="none" stroke="oklch(0.99 0.02 80)" strokeWidth={2.4} strokeLinecap="round" strokeDasharray={`0.1 ${circ / 30}`} />}
          </g>
        );
      }
      return (
        <g key={l.id} opacity={dim} filter={filter}>
          <path d={l.d} {...common} strokeWidth={isSel ? 2 : 1.5} opacity={0.32} />
          {showLeds && <path d={l.d} {...common} strokeWidth={isSel ? 6 : 4.5} strokeDasharray="0.1 14.6" />}
          {lit && isSel && showLeds && <path d={l.d} fill="none" stroke="oklch(0.99 0.02 80)" strokeWidth={2.4} strokeLinecap="round" strokeDasharray="0.1 14.6" />}
        </g>
      );
    };
    return (
      <svg viewBox="0 0 1020 700" preserveAspectRatio="xMidYMid meet">
        <defs><filter id="lglow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="5.5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
        <g transform={`translate(510 350) scale(${zoom}) translate(-510 -350)`}>
          {LAYERS.filter((l) => l.id !== selId).map(render)}
          {sel && render(sel)}
          {sel && (() => {
            const [x, y, w, h] = sel.bbox; const t = 13;
            const corners = [[x, y, x + t, y, x, y + t], [x + w, y, x + w - t, y, x + w, y + t], [x, y + h, x + t, y + h, x, y + h - t], [x + w, y + h, x + w - t, y + h, x + w, y + h - t]];
            return (<g><rect x={x} y={y} width={w} height={h} rx="6" fill="none" stroke="var(--accent-line)" strokeWidth="1" strokeDasharray="2 5" />{corners.map((c, i) => <path key={i} d={`M${c[2]} ${c[3]} L${c[0]} ${c[1]} L${c[4]} ${c[5]}`} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />)}</g>);
          })()}
        </g>
      </svg>
    );
  }

  function Compass({ angle, setAngle, emit }) {
    const cx = 34, cy = 34, r = 26;
    const a = (angle - 90) * Math.PI / 180;
    const nx = cx + Math.cos(a) * r, ny = cy + Math.sin(a) * r;
    const dim = emit === "Omni";
    return (
      <div className="la-compass-wrap">
        <svg className="la-compass" viewBox="0 0 68 68" style={{ opacity: dim ? 0.4 : 1 }}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth="1" />
          <circle cx={cx} cy={cy} r="2.5" fill="var(--accent)" />
          {[0, 90, 180, 270].map((d) => { const t = (d - 90) * Math.PI / 180; return <line key={d} x1={cx + Math.cos(t) * (r - 4)} y1={cy + Math.sin(t) * (r - 4)} x2={cx + Math.cos(t) * r} y2={cy + Math.sin(t) * r} stroke="var(--text-faint)" strokeWidth="1" />; })}
          {emit === "Omni"
            ? <circle cx={cx} cy={cy} r={r - 7} fill="var(--accent-soft)" stroke="var(--accent-line)" strokeDasharray="2 3" />
            : <><line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" /><circle cx={nx} cy={ny} r="3.5" fill="var(--accent)" /></>}
        </svg>
        <div className="la-compass-ctrl">
          <span className="la-offset-lab">Offset</span>
          <input className="lw" type="range" min="-180" max="180" step="1" value={angle} disabled={dim} onChange={(e) => setAngle(parseInt(e.target.value))} />
          <span className="la-offset-v">{angle}°</span>
        </div>
      </div>
    );
  }

  function LayoutScreen() {
    const [selId, setSelId] = useState("l1");
    const [density, setDensity] = useState(60);
    const [tool, setTool] = useState("select");
    const [zoom, setZoom] = useState(1);
    const [light, setLight] = useState(true);
    const [leds, setLeds] = useState(true);
    const [heat, setHeat] = useState(false);
    const [strips, setStrips] = useState(["l1", "l2"]); // layers promoted to strips
    const [emit, setEmit] = useState("Directed");
    const [angle, setAngle] = useState(-18);
    const [colorTag, setColorTag] = useState("--layer-1");
    const [bright, setBright] = useState(100);
    const [ledCount, setLedCount] = useState(33);

    const sel = LAYERS.find((l) => l.id === selId);
    const isStrip = strips.includes(selId);
    const totalLeds = LAYERS.filter((l) => strips.includes(l.id)).reduce((a, l) => a + l.ledCount, 0);
    React.useEffect(() => { if (sel) { setEmit(sel.emit); setAngle(sel.angle); setColorTag(sel.colorVar); setBright(sel.bright); setLedCount(sel.ledCount); } }, [selId]);

    const pitch = sel && ledCount > 1 ? (sel.length / ledCount).toFixed(1) : "—";
    const addStrip = () => setStrips((s) => s.includes(selId) ? s : [...s, selId]);
    const tbTool = (id, label, icon) => (
      <button className={"tb-btn" + (tool === id ? " active" : "")} onClick={() => setTool(tool === id ? "select" : id)}>{icon}{label}</button>
    );

    return (
      <div className="screen">
        <div className="la">
          {/* toolbar */}
          <div className="toolbar">
            <button className="tb-btn solid">{I.import}Import SVG</button>
            <button className="tb-btn">+ All ({LAYERS.length})</button>
            <div className="tb-div" />
            {tbTool("draw", "Draw", I.draw)}
            {tbTool("chop", "Chop", null)}
            {tbTool("link", "Link", null)}
            <button className="tb-btn icon" title="Undo">{I.undo}</button>
            <button className="tb-btn icon" title="Redo">{I.redo}</button>
            <div className="tb-div" />
            <div className="seg">
              <span className="seg-label">Density</span>
              {[30, 60, 96, 144].map((d) => <button key={d} className={density === d ? "on" : ""} onClick={() => setDensity(d)}>{d}</button>)}
            </div>
            <div className="tb-spring" />
            <div className="la-zoom">
              <button onClick={() => setZoom((z) => Math.max(0.4, +(z / 1.25).toFixed(2)))}>−</button>
              <button className="zv" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button onClick={() => setZoom((z) => Math.min(4, +(z * 1.25).toFixed(2)))}>+</button>
            </div>
            <div className="tb-div" />
            <button className="tb-btn">{I.load}Load</button>
            <div className="tb-div" />
            <button className={"tb-btn" + (light ? " active" : "")} onClick={() => setLight((v) => !v)}>{I.bulb}Light</button>
            <button className={"tb-btn" + (leds ? " active" : "")} onClick={() => setLeds((v) => !v)}>{I.grid}LEDs</button>
            <button className={"tb-btn" + (heat ? " active" : "")} onClick={() => setHeat((v) => !v)}>Heat</button>
          </div>

          {/* canvas */}
          <main className="body">
            <div className="dotgrid" />
            <div className="stage"><Canvas selId={selId} lit={light} showLeds={leds} zoom={zoom} /></div>
            <div className="la-overlay tl">
              <div><span className="k">artwork</span><span className="v">0 0 640 400</span></div>
              <div><span className="k">layers</span><span className="v">{LAYERS.length} · {strips.length} strips</span></div>
              <div><span className="k">leds</span><span className="v">{totalLeds.toLocaleString()}</span></div>
            </div>
            <div className="la-overlay br">
              <div><span className="k">emit</span><span className="v">{emit.toLowerCase()}{emit === "Directed" ? ` ${angle}°` : ""}</span></div>
              <div><span className="k">zoom</span><span className="v">{Math.round(zoom * 100)}%</span></div>
            </div>
          </main>

          {/* right panel */}
          <aside className="side">
            <div className="panel-head"><span className="ttl">Artwork layers</span><span className="meta">{LAYERS.length} · {totalLeds} LEDs</span></div>
            <div className="layers">
              {LAYERS.map((l) => (
                <div key={l.id} className={"layer-row" + (l.id === selId ? " sel" : "")} onClick={() => setSelId(l.id)}>
                  <span className="layer-swatch" style={{ background: `var(${l.colorVar})` }} />
                  <span className="layer-name">{l.name}</span>
                  {strips.includes(l.id) && <span className="la-stripdot" title="Has LED strip" />}
                  <span className="layer-len">{l.length} mm</span>
                </div>
              ))}
            </div>
            <div className="la-hint">Click rows to select · <strong>⇧/⌘ click</strong> adds · drag rows into groups</div>

            {/* path selection */}
            {sel && (
              <div className="la-pathsel">
                <div className="la-sub-h"><span>{sel.subPaths} path{sel.subPaths > 1 ? "s" : ""} selected</span><span className="meta">{sel.name}</span></div>
                <input className="pm-input" defaultValue={sel.name} placeholder="Name…" style={{ height: 30, marginBottom: 8 }} />
                <div className="la-merge">
                  <button className="btn primary" style={{ flex: 1 }}>Merge strip</button>
                  <button className="btn">Separate</button>
                  <button className="btn">Strip group</button>
                </div>
                <button className="btn ghost-sm" style={{ width: "100%", marginTop: 6, justifyContent: "center" }}>Layer group</button>
              </div>
            )}

            <div className="panel-divider" />

            {/* inspector */}
            {sel && (
              <div className="inspector">
                <div className="insp-head"><span className="sw" style={{ background: `var(${colorTag})` }} /><span className="nm">{sel.name}</span><span className="tag">Inspector</span></div>
                <div className="insp-body">
                  <div className="field"><span className="k">Length</span><span className="v"><span className="inspector-value">{sel.length}<span className="u">mm</span></span></span></div>
                  {sel.subPaths > 1 && <div className="field"><span className="k">Sub-paths</span><span className="v"><span className="inspector-value">{sel.subPaths}</span></span></div>}
                  <div className="field"><span className="k">Density</span><span className="v"><div className="mini-seg">{[30, 60, 96, 144].map((d) => <button key={d} className={density === d ? "on" : ""} onClick={() => setDensity(d)}>{d}</button>)}</div></span></div>
                  <div className="field-sep" />
                  <div className="la-ledrow">
                    <span className="k">LED count</span>
                    <div className="la-ledctrl">
                      <input className="lw" type="range" min="1" max="200" step="1" value={ledCount} onChange={(e) => setLedCount(parseInt(e.target.value))} />
                      <input className="num-input" type="number" value={ledCount} onChange={(e) => setLedCount(parseInt(e.target.value) || 1)} style={{ width: 64 }} />
                    </div>
                  </div>
                  <div className="field"><span className="k">Pitch</span><span className="v"><span className="inspector-value">{pitch}<span className="u">mm/LED</span></span></span></div>
                  <div className="field-sep" />
                  <div className="field"><span className="k">Emit</span><span className="v"><div className="mini-seg">{["Omni", "Directed"].map((m) => <button key={m} className={emit === m ? "on" : ""} onClick={() => setEmit(m)}>{m}</button>)}</div></span></div>
                  <Compass angle={angle} setAngle={setAngle} emit={emit} />
                  <div className="field-sep" />
                  <div className="field"><span className="k">Color tag</span><span className="v"><div className="la-tags">{COLOR_TAGS.map((c) => <button key={c} className={"la-tag" + (colorTag === c ? " on" : "")} style={{ background: c.startsWith("--") ? `var(${c})` : c }} onClick={() => setColorTag(c)} />)}</div></span></div>
                  <div className="slider-row" style={{ marginTop: 6 }}><div className="lab"><span className="k" style={{ color: "var(--text-mid)" }}>Brightness</span><span className="v" style={{ fontFamily: "var(--font-mono)", color: "var(--text-hi)" }}>{bright}%</span></div><input className="lw" type="range" min="0" max="100" value={bright} onChange={(e) => setBright(parseInt(e.target.value))} /></div>
                  {isStrip
                    ? <button className="insp-cta" style={{ color: "var(--ok)", borderColor: "color-mix(in oklch, var(--ok) 40%, var(--border))" }}>{I.check}Strip added · update</button>
                    : <button className="insp-cta" onClick={addStrip}>{I.strip}Add as strip</button>}
                </div>
              </div>
            )}

            <div className="panel-divider" />

            {/* LED strips */}
            <div className="panel-head"><span className="ttl">LED strips</span><span className="meta">{strips.length}</span></div>
            <div className="layers" style={{ paddingBottom: 4 }}>
              {strips.length === 0 && <div className="la-hint" style={{ padding: "4px 12px" }}>No strips yet. Select a layer and Add as strip.</div>}
              {LAYERS.filter((l) => strips.includes(l.id)).map((l, i) => (
                <div key={l.id} className="la-strip-row">
                  <span className="la-stripnum">{i + 1}</span>
                  <span className="layer-swatch" style={{ background: `var(${l.colorVar})` }} />
                  <span className="layer-name">{l.name}</span>
                  <span className="layer-len">{l.ledCount} px</span>
                  <button className="la-x" title="Remove strip" onClick={() => setStrips((s) => s.filter((x) => x !== l.id))}>{I.x}</button>
                </div>
              ))}
            </div>

            <div className="panel-divider" />

            {/* wire path */}
            <div className="panel-head"><span className="ttl">Wire path</span><span className="meta">physical order</span></div>
            <div className="la-wire">
              {LAYERS.filter((l) => strips.includes(l.id)).map((l, i, arr) => (
                <div key={l.id} className="la-wire-row">
                  <span className="la-wire-n">{String(i + 1).padStart(2, "0")}</span>
                  <span className="la-wire-dot" style={{ background: `var(${l.colorVar})` }} />
                  <span className="layer-name">{l.name}</span>
                  <span className="la-wire-len">{l.ledCount}px</span>
                  {i < arr.length - 1 && <span className="la-wire-link">↳</span>}
                </div>
              ))}
              {strips.length > 1 && <div className="la-wire-total">{totalLeds} LEDs · {strips.length} strips in series</div>}
            </div>
          </aside>
        </div>
      </div>
    );
  }

  window.LayoutScreen = LayoutScreen;
})();
