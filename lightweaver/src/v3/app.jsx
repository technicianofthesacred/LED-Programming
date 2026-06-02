/* Exact mockup shell (app.jsx), converted from global script to ES module.
   Only imports/exports changed; TopBar, Rail, StatusBar, Canvas, App body are
   byte-identical to the design source. Renders the exact converted screens. */
import React, { useState } from 'react';
import { PatternScreen } from './lw-pattern.jsx';
import { PlaylistScreen } from './lw-playlist.jsx';
import { LayoutScreen } from './lw-layout.jsx';
import { ShowScreen } from './lw-show.jsx';
import { FlashScreen } from './lw-flash.jsx';
import { SettingsScreen } from './lw-settings.jsx';
import { InstallerScreen } from './lw-installer.jsx';

/* ---------- tiny icon set (stroked, 1.6) ---------- */
const I = {
  layout: <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></svg>,
  pattern: <svg viewBox="0 0 24 24"><path d="M4 12c2-5 6-5 8 0s6 5 8 0"/><path d="M4 17c2-3 6-3 8 0s6 3 8 0"/></svg>,
  show: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M18.4 5.6l-2 2M7.6 16.4l-2 2"/></svg>,
  export: <svg viewBox="0 0 24 24"><path d="M12 16V4M8 8l4-4 4 4"/><path d="M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3"/></svg>,
  flash: <svg viewBox="0 0 24 24"><path d="M13 3 5 13h6l-1 8 8-10h-6z"/></svg>,
  devices: <svg viewBox="0 0 24 24"><rect x="3" y="5" width="13" height="11" rx="1.5"/><path d="M8 20h6M11 16v4"/><rect x="18" y="9" width="3" height="11" rx="1"/></svg>,
  settings: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>,
  playlist: <svg viewBox="0 0 24 24"><path d="M4 7h11M4 12h11M4 17h7"/><circle cx="18" cy="16" r="2.4"/><path d="M20.4 16V9l-3 1"/></svg>,
  installer: <svg viewBox="0 0 24 24"><path d="M3 13l2.5-7.5A1 1 0 0 1 6.5 5h11a1 1 0 0 1 1 .7L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1.5 2.2h5L16 13h5"/></svg>,
  import: <svg viewBox="0 0 24 24"><path d="M12 4v12M8 12l4 4 4-4"/><path d="M5 20h14"/></svg>,
  draw: <svg viewBox="0 0 24 24"><path d="m15 5 4 4L8 20l-5 1 1-5z"/><path d="M13 7l4 4"/></svg>,
  undo: <svg viewBox="0 0 24 24"><path d="M9 7 4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10"/></svg>,
  redo: <svg viewBox="0 0 24 24"><path d="m15 7 5 5-5 5"/><path d="M20 12H9a5 5 0 0 0 0 10"/></svg>,
  load: <svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>,
  bulb: <svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10c1 1 1.5 2 1.5 3h5c0-1 .5-2 1.5-3a6 6 0 0 0-4-10z"/></svg>,
  grid: <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  eye: <svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>,
  plus: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>,
  strip: <svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6" rx="2"/><path d="M7 9v6M11 9v6M15 9v6"/></svg>,
  share: <svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/></svg>,
};

/* ---------- layer model ---------- */
const LAYERS = [
  {
    id: "l1", name: "Layer 1", colorVar: "--layer-1", length: 551, density: 60, ledCount: 33, emit: "Directed", pitch: 16.7,
    // long sine strand
    d: "M70 432 C 230 300, 360 300, 480 380 C 590 452, 700 470, 800 452 C 870 440, 920 410, 952 388",
    bbox: [62, 292, 898, 196],
  },
  {
    id: "l2", name: "Layer 2", colorVar: "--layer-2", length: 503, density: 60, ledCount: 30, emit: "Directed", pitch: 16.8,
    // center ring
    ring: { cx: 480, cy: 358, r: 120 },
    bbox: [352, 230, 256, 256],
  },
  {
    id: "l3", name: "Layer 3", colorVar: "--layer-3", length: 960, density: 60, ledCount: 57, emit: "Omni", pitch: 16.8,
    // wide lower arc
    d: "M120 566 C 330 476, 650 476, 880 566",
    bbox: [110, 470, 780, 112],
  },
];

/* css var -> resolved color */
function cv(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

/* ---------- Canvas ---------- */
function Canvas({ selId, lit }) {
  const cssVar = (v) => `var(${v})`;
  const sel = LAYERS.find((l) => l.id === selId);

  function renderLayer(l) {
    const isSel = l.id === selId;
    const col = cssVar(l.colorVar);
    const dim = isSel ? 1 : 0.34;
    const filter = (lit && isSel) ? "url(#glow)" : "none";
    const common = { fill: "none", stroke: col, strokeLinecap: "round" };

    if (l.ring) {
      const { cx, cy, r } = l.ring;
      const circ = 2 * Math.PI * r;
      return (
        <g key={l.id} opacity={dim} filter={filter}>
          {/* substrate */}
          <circle cx={cx} cy={cy} r={r} {...common} strokeWidth={isSel ? 2 : 1.5} opacity={0.32} />
          {/* LED beads */}
          <circle cx={cx} cy={cy} r={r} {...common} strokeWidth={isSel ? 6 : 4.5}
            strokeDasharray={`0.1 ${circ / 30}`} />
          {lit && isSel && (
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="oklch(0.99 0.02 80)" strokeWidth={2.4} strokeLinecap="round"
              strokeDasharray={`0.1 ${circ / 30}`} />
          )}
        </g>
      );
    }
    return (
      <g key={l.id} opacity={dim} filter={filter}>
        <path d={l.d} {...common} strokeWidth={isSel ? 2 : 1.5} opacity={0.32} />
        <path d={l.d} {...common} strokeWidth={isSel ? 6 : 4.5} strokeDasharray="0.1 14.6" />
        {lit && isSel && (
          <path d={l.d} fill="none" stroke="oklch(0.99 0.02 80)" strokeWidth={2.4} strokeLinecap="round" strokeDasharray="0.1 14.6" />
        )}
      </g>
    );
  }

  return (
    <svg viewBox="0 0 1020 700" preserveAspectRatio="xMidYMid meet">
      <defs>
        <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* draw unselected first, selected last (on top) */}
      {LAYERS.filter((l) => l.id !== selId).map(renderLayer)}
      {sel && renderLayer(sel)}

      {/* refined amber selection frame (replaces the garish green boxes) */}
      {sel && (() => {
        const [x, y, w, h] = sel.bbox;
        const t = 13; // tick length
        const stroke = "var(--accent)";
        const corners = [
          [x, y, x + t, y, x, y + t],
          [x + w, y, x + w - t, y, x + w, y + t],
          [x, y + h, x + t, y + h, x, y + h - t],
          [x + w, y + h, x + w - t, y + h, x + w, y + h - t],
        ];
        return (
          <g>
            <rect x={x} y={y} width={w} height={h} rx="6" fill="none"
              stroke="var(--accent-line)" strokeWidth="1" strokeDasharray="2 5" />
            {corners.map((c, i) => (
              <path key={i} d={`M${c[2]} ${c[3]} L${c[0]} ${c[1]} L${c[4]} ${c[5]}`}
                fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
            ))}
          </g>
        );
      })()}
    </svg>
  );
}

/* ---------- Top bar ---------- */
function TopBar() {
  return (
    <header className="topbar">
      <div className="brand"><span className="glyph" /><span className="name">Light Weaver</span></div>
      <nav className="crumb">
        <span>Projects</span><span className="sep">/</span><span className="proj">Willow Canopy v3</span>
        <span className="savechip"><span className="dot" />saved<span className="t">2s ago</span></span>
      </nav>
      <div className="top-right">
        <button className="link-btn" title="Start a new empty project">New project</button>
        <button className="link-btn" title="Open a project file from your computer">Load project</button>
        <span className="top-div" />
        <button className="link-btn" title="Download a keepable project file to your computer (reload it anytime)">Download file</button>
        <button className="btn primary" title="Save the project in this browser">Save project</button>
      </div>
    </header>
  );
}

/* ---------- Left rail ---------- */
function Rail({ view, setView }) {
  const main = [["pattern", "Patterns"], ["playlist", "Playlist"], ["layout", "Layout"], ["show", "Show"], ["flash", "Flash"], ["installer", "Installer"]];
  const foot = [["settings", "Settings"]];
  const item = ([id, label]) => (
    <button key={id} className={"rail-item" + (view === id ? " active" : "")} onClick={() => setView(id)}>
      <span className="ico">{I[id]}</span><span className="lbl">{label}</span>
    </button>
  );
  return (
    <aside className="rail">
      {main.map(item)}
      <div className="spring" />
      {foot.map(item)}
    </aside>
  );
}

/* ---------- Toolbar ---------- */
function Toolbar({ density, setDensity, lit, setLit, tool, setTool }) {
  const densities = [30, 60, 96, 144];
  return (
    <div className="toolbar">
      <button className="tb-btn solid">{I.import}Import SVG</button>
      <div className="tb-div" />
      <button className={"tb-btn" + (tool === "draw" ? " active" : "")} onClick={() => setTool(tool === "draw" ? "select" : "draw")}>{I.draw}Draw</button>
      <button className="tb-btn icon" title="Undo">{I.undo}</button>
      <button className="tb-btn icon" title="Redo">{I.redo}</button>
      <div className="tb-div" />
      <div className="seg">
        <span className="seg-label" title="Project default LED density">Default</span>
        {densities.map((d) => (
          <button key={d} className={density === d ? "on" : ""} onClick={() => setDensity(d)}>{d}<span style={{ opacity: 0.6, fontSize: 10 }}>/m</span></button>
        ))}
      </div>
      <div className="tb-div" />
      <button className="tb-btn">{I.load}Load</button>

      <div className="tb-spring" />

      <div className="viewtoggle">
        <button className={!lit ? "on" : ""} onClick={() => setLit(false)}>{I.grid}Schematic</button>
        <button className={lit ? "on" : ""} onClick={() => setLit(true)}>{I.bulb}Lit</button>
      </div>
    </div>
  );
}

/* ---------- Right panel ---------- */
function SidePanel({ selId, setSelId, density, setDensity }) {
  const sel = LAYERS.find((l) => l.id === selId);
  const [emit, setEmit] = useState(sel ? sel.emit : "Directed");
  React.useEffect(() => { if (sel) setEmit(sel.emit); }, [selId]);

  return (
    <aside className="side">
      <div className="panel-head">
        <span className="ttl">Artwork Layers</span>
        <span className="meta">{LAYERS.length} layers</span>
      </div>

      <div className="layers">
        {LAYERS.map((l) => (
          <div key={l.id} className={"layer-row" + (l.id === selId ? " sel" : "")} onClick={() => setSelId(l.id)}>
            <span className="layer-swatch" style={{ background: `var(${l.colorVar})` }} />
            <span className="layer-name">{l.name}</span>
            <span className="layer-len">{l.length} mm</span>
            <button className="layer-vis" title="Toggle visibility" onClick={(e) => e.stopPropagation()}>{I.eye}</button>
          </div>
        ))}
      </div>
      <div className="layers-foot">
        <button className="add-layer">{I.plus}Add layer</button>
      </div>

      <div className="panel-divider" />

      {sel && (
        <div className="inspector">
          <div className="insp-head">
            <span className="sw" style={{ background: `var(${sel.colorVar})` }} />
            <span className="nm">{sel.name}</span>
            <span className="tag">Inspector</span>
          </div>
          <div className="insp-body">
            <div className="field">
              <span className="k">Length</span>
              <span className="v"><span className="inspector-value">{sel.length}<span className="u">mm</span></span></span>
            </div>
            <div className="field">
              <span className="k">Density</span>
              <span className="v">
                <div className="mini-seg">
                  {[30, 60, 96, 144].map((d) => (
                    <button key={d} className={density === d ? "on" : ""} onClick={() => setDensity(d)}>{d}</button>
                  ))}
                </div>
              </span>
            </div>
            <div className="field-sep" />
            <div className="field">
              <span className="k">LED count</span>
              <span className="v"><input className="num-input" defaultValue={sel.ledCount} /></span>
            </div>
            <div className="field">
              <span className="k">Emit</span>
              <span className="v">
                <div className="mini-seg">
                  {["Omni", "Directed"].map((m) => (
                    <button key={m} className={emit === m ? "on" : ""} onClick={() => setEmit(m)}>{m}</button>
                  ))}
                </div>
              </span>
            </div>
            <div className="field">
              <span className="k">Pitch</span>
              <span className="v"><span className="inspector-value">{sel.pitch}<span className="u">mm</span></span></span>
            </div>
            <button className="insp-cta">{I.strip}Add as strip</button>
          </div>
        </div>
      )}
    </aside>
  );
}

/* ---------- Status / Card bar ---------- */
function StatusBar({ density, connected, setConnected }) {
  return (
    <footer className="status-bar">
      <div className="sb-card">
        <span className={"sb-dot " + (connected ? "on" : "off")} />
        <span className="sb-label">Card</span>
        <input className="sb-host" defaultValue="lightweaver.local" disabled={connected} aria-label="Card hostname or IP" />
        <button className={"sb-connect" + (connected ? " is-on" : "")} onClick={() => setConnected((c) => !c)}>
          {connected ? "Disconnect" : "Connect"}
        </button>
        {connected && <span className="sb-stream"><span className="pulse" />Art-Net live</span>}
      </div>

      <div className="sb-div" />

      <div className="sb-facts">
        <span className="sb-fact"><span>pattern</span><span className="fv">Aurora</span></span>
        <span className="sb-fact"><span>strip</span><span className="fv">WS2812B · {density}/m</span></span>
        <span className="sb-fact"><span>total</span><span className="fv">1,204 LEDs · 8 strips</span></span>
        <span className="sb-fact"><span>push</span><span className="fv">{connected ? "25 fps" : "—"}</span></span>
      </div>

      <div className="sb-spring" />

      <div className="sb-right">
        <span className="sb-fact"><span>Tool</span><span className="fv">Select</span></span>
        <span className="sb-fact"><span>Zoom</span><span className="fv">100%</span></span>
        <span className="sb-fact"><span className="kbd">⌘Z</span><span className="kbd" style={{ marginLeft: 8 }}>Space drag</span></span>
      </div>
    </footer>
  );
}

/* ---------- placeholder views ---------- */
function Placeholder({ view }) {
  const copy = {
    pattern: ["Pattern", "Author per-pixel looks and palettes. Lives on the same warm-neutral system — amber for the active pattern, dense parameter rows."],
    show: ["Show", "Sequence patterns into a timeline and cue the installation live."],
    export: ["Export", "Card preset bundles and interchange formats (WLED, FastLED, CSV)."],
    flash: ["Flash", "Card ships pre-flashed with Lightweaver firmware. Advanced WLED flashing lives here, tucked away."],
    devices: ["Devices", "Card connection, zones, and the deep-dive status the bottom bar summarizes."],
    settings: ["Settings", "Theme (dark / light), card push fps, and project defaults."],
  };
  const [title, body] = copy[view] || ["—", ""];
  return (
    <div className="view-placeholder">
      <span className="ph-ico">{I[view]}</span>
      <h2>{title}</h2>
      <p>{body}</p>
      <span className="tag">v3 system — built next</span>
    </div>
  );
}

/* ---------- App ---------- */
function App() {
  const [view, setView] = useState("layout");
  const [selId, setSelId] = useState("l1");
  const [density, setDensity] = useState(60);
  const [lit, setLit] = useState(true);
  const [tool, setTool] = useState("select");
  const [connected, setConnected] = useState(true);

  const Screen = { pattern: PatternScreen, playlist: PlaylistScreen, layout: LayoutScreen, show: ShowScreen, flash: FlashScreen, settings: SettingsScreen, installer: InstallerScreen }[view];

  return (
    <div className="app">
      <TopBar />
      <Rail view={view} setView={setView} />

      {Screen ? (
        <Screen connected={connected} go={setView} />
      ) : (
        <Placeholder view={view} />
      )}

      <StatusBar density={density} connected={connected} setConnected={setConnected} />
    </div>
  );
}

export default App;
