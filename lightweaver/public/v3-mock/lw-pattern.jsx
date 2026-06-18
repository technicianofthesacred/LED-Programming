/* global React, window */
/* Light Weaver v3 — Patterns & Mixes (faithful to v3, cleaned + recolored) */
(function () {
  const { useState } = React;
  const { I, PATTERNS, MIXES, PATTERN_CATS, STRIP_TESTS, SWATCHES, GEOMETRY } = window.LW;
  const ALL = [...MIXES, ...PATTERNS];
  const ORDERS = ["GRB", "RGB", "BRG", "RBG", "GBR", "BGR"];

  function Slider({ k, v, value, min, max, step, onChange }) {
    return (
      <div className="slider-row">
        <div className="lab"><span className="k">{k}</span><span className="v">{v}</span></div>
        <input className="lw" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      </div>);

  }

  // small glowing sine strand for the Color & motion preview
  function Strand({ tint }) {
    return (
      <svg viewBox="0 0 320 96" preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%" }}>
        <defs>
          <filter id="pm-glow" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="3.4" /></filter>
        </defs>
        <path d="M14 58 C 70 22, 110 22, 160 50 C 210 78, 250 78, 306 42" fill="none" stroke={tint} strokeWidth="6"
        strokeLinecap="round" strokeDasharray="0.1 9.2" opacity="0.9" filter="url(#pm-glow)" />
        <path d="M14 58 C 70 22, 110 22, 160 50 C 210 78, 250 78, 306 42" fill="none" stroke="oklch(0.99 0.02 90)" strokeWidth="2"
        strokeLinecap="round" strokeDasharray="0.1 9.2" />
      </svg>);

  }

  // colors interpolated across a palette → glowing LED beads
  function ledColors(pal, n) {
    const rgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = (i / (n - 1)) * (pal.length - 1), s = Math.floor(p), t = p - s;
      const a = rgb(pal[s]), b = rgb(pal[Math.min(s + 1, pal.length - 1)]);
      const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
      out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
    return out;
  }
  function LedRow({ pal, n = 9, big = false, wave = false }) {
    return (
      <div className={"ledrow" + (big ? " big" : "")}>
        {ledColors(pal, n).map((c, i) =>
          <span key={i} className={"led" + (wave ? " wave" : "")} style={{ background: c, boxShadow: `0 0 ${big ? 9 : 5}px ${c}, 0 0 ${big ? 20 : 11}px ${c}`, animationDelay: wave ? `${i * 0.11}s` : undefined }} />
        )}
      </div>);
  }
  function LedStage({ pal }) {
    return (
      <div className="pm-led-stage">
        <LedRow pal={pal} n={22} big wave />
        <span className="sheen" />
      </div>);
  }

  function PatternScreen({ connected }) {
    const [q, setQ] = useState("");
    const [cat, setCat] = useState("all");
    const [selId, setSelId] = useState("lava");
    const [playlist, setPlaylist] = useState(() => new Set(ALL.map((p) => p.id).filter((id) => id !== "ocean")));
    const [localCard, setLocalCard] = useState(true);
    const [livePreview, setLivePreview] = useState(true);
    const [stripTest, setStripTest] = useState(null);
    const [orderIdx, setOrderIdx] = useState(0);
    const [mixName, setMixName] = useState("");
    const [hue, setHue] = useState(28);
    const [sat, setSat] = useState(78);
    const [bri, setBri] = useState(90);
    const [spd, setSpd] = useState(1.0);
    const [angle, setAngle] = useState(45);
    const [geo, setGeo] = useState("none");
    const [menuOpen, setMenuOpen] = useState(false);

    const filtered = ALL.filter((p) => {
      if (cat === "mix") {if (!p.mix) return false;} else if (cat !== "all" && p.cat !== cat) return false;
      if (q && !p.label.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    const sel = ALL.find((p) => p.id === selId) || ALL[0];
    const tint = sel.pal[2] || sel.pal[sel.pal.length - 1];
    const mixLabel = mixName.trim() || `Strip 1 ${sel.label}`;

    const togglePl = (id, e) => {e.stopPropagation();setPlaylist((s) => {const n = new Set(s);n.has(id) ? n.delete(id) : n.add(id);return n;});};

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="pm">
            {/* hero */}
            <header className="pm-hero">
              <div className="pm-title">
                <h1>Patterns &amp; Mixes</h1>
                <p>Choose chip-ready patterns, tune the colors, then save section blends as layer mixes for the card.</p>
              </div>
              <div className="pm-actions">
                <button className="btn primary" disabled={!connected} title={connected ? "Save the current look to the card" : "Connect the card first"}>{I.bolt}Save to card</button>
                <div className="ag-conn">
                  <button className={"btn" + (localCard ? " toggled" : "")} aria-pressed={localCard} onClick={() => setLocalCard((v) => !v)}>{localCard ? "Using local card" : "Use local card"}</button>
                  <button className="btn">{I.open}Open card page</button>
                </div>
                <div className="pm-menu">
                  <button className="btn" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>{I.dots}Card tools{I.chevronD}</button>
                  {menuOpen &&
                  <>
                      <div className="pm-menu-backdrop" onClick={() => setMenuOpen(false)} />
                      <div className="pm-menu-pop">
                        <button className="pm-menu-item" onClick={() => setMenuOpen(false)}>{I.wrench}Repair LED</button>
                        <button className="pm-menu-item" onClick={() => setMenuOpen(false)}>{I.target}Send split preview</button>
                        <div className="pm-menu-sep" />
                        <button className="pm-menu-item" onClick={() => setMenuOpen(false)}>{I.copy}Copy setup</button>
                        <button className="pm-menu-item" onClick={() => setMenuOpen(false)}>{I.download}Download setup</button>
                      </div>
                    </>
                  }
                </div>
              </div>
            </header>

            <div className="pm-grid">
              {/* MAIN */}
              <section className="pm-main">
                <div className="sec-h"><span className="t">Tap a pattern to preview</span><span className="m">{filtered.length} shown of {PATTERNS.length} chip-ready + {MIXES.length} mixes / {playlist.size} in playlist</span><span className="line" /></div>

                <div className="pm-livebar">
                  <label className="pm-check" onClick={() => setLivePreview((v) => !v)}>
                    <span className={"pm-box" + (livePreview ? " on" : "")}>{livePreview && I.check}</span>
                    Preview taps on the LED card
                  </label>
                  <span className="pm-saved">All sections saved</span>
                </div>

                <div className="pm-stripfinder">
                  <span className="sf-l">Strip finder</span>
                  <div className="sf-btns">
                    {STRIP_TESTS.map((t) =>
                    <button key={t.id} className={"sf-btn" + (stripTest === t.id ? " on" : "")} title={`Test ${t.label}`} onClick={() => setStripTest(stripTest === t.id ? null : t.id)} style={stripTest === t.id ? { "--sf": t.col } : null}>{t.short}</button>
                    )}
                  </div>
                  <span className="sf-order">Order <b>{ORDERS[orderIdx]}</b></span>
                  <button className="btn ghost-sm" onClick={() => setOrderIdx((i) => (i + 1) % ORDERS.length)}>{I.refresh}Try next order</button>
                </div>

                {/* design target */}
                <div className="pm-target">
                  <div className="sec-h"><span className="t">Design target</span><span className="m">1 section · card limit 10</span><span className="line" /></div>
                  <div className="pm-mixbar">
                    <div className="pm-mixlabel"><span>Layer mix</span><strong>{mixLabel}</strong></div>
                    <input className="pm-input" value={mixName} onChange={(e) => setMixName(e.target.value)} placeholder="Name this mix (optional)" />
                    <button className="btn primary">Save mix</button>
                  </div>
                  <div className="pm-targetcard">
                    <div className="tc-head">
                      <button className="tc-all on">ALL</button>
                      <div className="tc-name"><span className="lab">Target</span><strong>All sections</strong></div>
                      <div className="tc-total"><span className="lab">Total</span><strong>4</strong></div>
                      <div className="tc-pat"><span className="lab">Pattern</span><span className="tc-patval"><span className="sw" style={{ background: tint, boxShadow: `0 0 6px ${tint}` }} />{sel.label}</span></div>
                    </div>
                    <div className="tc-layer">
                      <span className="tc-num">1</span>
                      <div className="tc-name"><span className="lab">Layer</span><strong>Strip 1</strong></div>
                      <div className="tc-total"><span className="lab">LEDs</span><strong>4</strong></div>
                      <div className="tc-pat"><span className="lab">Pattern</span><span className="tc-patval"><span className="sw" style={{ background: tint, boxShadow: `0 0 6px ${tint}` }} />{sel.label}</span></div>
                    </div>
                  </div>
                </div>

                {/* browse */}
                <div className="pm-browse" style={{ margin: "5px 0px 0px" }}>
                  <div className="search" style={{ maxWidth: "none", marginBottom: 10 }}>{I.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chip patterns" /></div>
                  <div className="pt-tools" style={{ padding: "0px", margin: "0px 0px 10px" }}>
                    <div className="chips">
                      {PATTERN_CATS.map((c) => <button key={c.id} className={"chip" + (cat === c.id ? " on" : "")} onClick={() => setCat(c.id)}>{c.label}</button>)}
                    </div>
                    <span className="pt-count">{filtered.length} of {PATTERNS.length} shown</span>
                  </div>
                  <div className="pm-cards">
                    {filtered.map((p) =>
                    <div key={p.id} className={"pmcard" + (p.id === selId ? " on" : "")} onClick={() => setSelId(p.id)}>
                        <div className="pmcard-led"><LedRow pal={p.pal} n={9} /></div>
                        <div className="pmcard-row">
                          <span className="pmcard-nm">{p.label}</span>
                          {p.mix && <span className="mixtag">mix</span>}
                          <span className="pmcard-sp">{p.sp}</span>
                        </div>
                        <button className={"pmcard-pl" + (playlist.has(p.id) ? " on" : "")} onClick={(e) => togglePl(p.id, e)}>
                          <svg viewBox="0 0 24 24" className="plstar"><path d="M12 3l2.6 5.6 6 .7-4.4 4.1 1.2 6L12 16.8 6.6 19.4l1.2-6L3.4 9.3l6-.7z" /></svg>
                          {playlist.has(p.id) ? "In playlist" : "Add to playlist"}
                        </button>
                      </div>
                    )}
                    {!filtered.length && <p style={{ color: "var(--text-faint)", fontSize: 13, gridColumn: "1 / -1", padding: 20 }}>No chip patterns match this search.</p>}
                  </div>
                </div>
              </section>

              {/* ASIDE */}
              <aside className="pm-aside">
                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Preview</span><span className="m">All sections · {sel.label}</span></div>
                  <LedStage pal={sel.pal} />
                  <p className="pt-desc">{sel.desc}</p>
                </div>

                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Color &amp; motion</span><span className="m">All sections</span></div>
                  <div className="pm-motion"><Strand tint={tint} /></div>
                  <div className="pm-palette">
                    <span className="pm-palrow">{sel.pal.map((c, i) => <span key={i} style={{ background: c }} />)}</span>
                    <div className="pm-palmeta"><strong>{sel.label}</strong><span>{sel.sp} · {sel.cat.toUpperCase()}</span></div>
                  </div>

                  <div className="pm-hue">
                    <div className="pm-hue-lab"><span>Hue</span><span className="hv">{hue}°</span></div>
                    <input className="lw pm-huerange" type="range" min="0" max="360" step="1" value={hue} onChange={(e) => setHue(parseInt(e.target.value))} />
                  </div>
                  <Slider k="Saturation" v={`${sat}%`} value={sat} min={0} max={100} step={1} onChange={setSat} />
                  <Slider k="Brightness" v={`${bri}%`} value={bri} min={5} max={100} step={1} onChange={setBri} />
                  <Slider k="Speed" v={`${spd.toFixed(2)}×`} value={spd} min={0.05} max={3} step={0.01} onChange={setSpd} />
                </div>

                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Geometry</span><span className="m">{GEOMETRY.find((g) => g.id === geo).label}</span></div>
                  <div className="geo-seg">
                    {GEOMETRY.map((g) => <button key={g.id} className={geo === g.id ? "on" : ""} onClick={() => setGeo(g.id)}>{g.id === "mirror" && I.mirror}{g.label}</button>)}
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>);

  }

  window.PatternScreen = PatternScreen;
})();