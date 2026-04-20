import { useState, useRef } from 'react';

const Icon = {
  layout:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M9 21V9"/></svg>,
  pattern: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>,
  export:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/></svg>,
  flash:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>,
  timeline: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="8" height="4" rx="0.5"/><rect x="13" y="6" width="8" height="4" rx="0.5"/><rect x="3" y="14" width="12" height="4" rx="0.5"/><path d="M8 3v18" strokeDasharray="1 2"/></svg>,
  devices: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="14" height="10" rx="1"/><rect x="17" y="9" width="4" height="10" rx="0.5"/><path d="M7 19h6"/></svg>,
  cog:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>,
};

export function TopBar({ projectName = 'Willow Canopy v3' }) {
  return (
    <div className="lw-topbar">
      <div className="lw-brand">
        <span className="lw-brand-dot"/>
        <span>Light Weaver</span>
      </div>
      <div className="lw-projbreadcrumbs">
        <span>Projects</span><span className="sep">/</span>
        <strong>{projectName}</strong>
        <span className="status-chip"><span className="dot"/>saved · 2s</span>
        <span className="sep">·</span>
        <span>1,204 LEDs · 8 strips</span>
      </div>
      <div className="lw-topbar-actions">
        <a className="btn-ghost btn lw-version-link" href="http://localhost:9999" title="Switch to v1 — LED Art Mapper">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 6h8M6 2l4 4-4 4"/></svg>
          v1 Mapper
        </a>
        <button className="btn-ghost btn">Import SVG</button>
        <button className="btn-ghost btn">Save</button>
        <button className="btn">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="6" cy="6" r="2"/><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/></svg>
          Share
        </button>
      </div>
    </div>
  );
}

export function LeftRail({ screen, onScreen }) {
  const items = [
    { id: 'layout',   label: 'Layout',   icon: Icon.layout },
    { id: 'pattern',  label: 'Pattern',  icon: Icon.pattern },
    { id: 'timeline', label: 'Show',     icon: Icon.timeline },
    { id: 'export',   label: 'Export',   icon: Icon.export },
    { id: 'flash',    label: 'Flash',    icon: Icon.flash },
  ];
  return (
    <div className="lw-rail">
      {items.map(it => (
        <button key={it.id}
                className={`lw-rail-btn ${screen === it.id ? 'active' : ''}`}
                onClick={() => onScreen(it.id)}>
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
      <div className="lw-rail-spacer"/>
      <button className="lw-rail-btn">{Icon.devices}<span>Devices</span></button>
      <button className="lw-rail-btn">{Icon.cog}<span>Settings</span></button>
    </div>
  );
}

export function CanvasToolbar({ glow, setGlow, dot, setDot, heat, setHeat }) {
  return (
    <div className="lw-canvas-toolbar">
      <div className="tbar-group">
        <button className="btn btn-ghost" title="Select (S)">
          <svg viewBox="0 0 12 12" fill="currentColor"><path d="M2 1l8 4-3.5 1-1 3.5z"/></svg>
        </button>
        <button className="btn btn-ghost" title="Pan (space)">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M6 1v6M3 4l3-3 3 3M1 6h6M4 9l-3-3 3-3M6 11V5M3 8l3 3 3-3M11 6H5M8 3l3 3-3 3"/></svg>
        </button>
        <button className="btn btn-ghost" title="Delete (X)">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M3 3l6 6M9 3l-6 6"/></svg>
        </button>
      </div>
      <span className="tbar-divider"/>
      <div className="tbar-group">
        <button className="btn btn-ghost">Undo</button>
        <button className="btn btn-ghost">Redo</button>
      </div>
      <span className="tbar-divider"/>
      <span className="tbar-label">LEDs</span>
      <div className="tbar-slider">
        <span>Glow</span>
        <input type="range" min="0" max="3" step="0.1" value={glow} onChange={e => setGlow(+e.target.value)}/>
        <span className="v">{glow.toFixed(1)}×</span>
      </div>
      <div className="tbar-slider">
        <span>Dot</span>
        <input type="range" min="1" max="6" step="0.5" value={dot} onChange={e => setDot(+e.target.value)}/>
        <span className="v">{dot.toFixed(1)}</span>
      </div>
      <button className={`btn ${heat ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setHeat(!heat)}>
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M6 1c-2 2-3 3-3 5a3 3 0 006 0c0-2-1-3-3-5z"/></svg>
        Coverage
      </button>
      <div style={{ flex: 1 }}/>
      <span style={{ fontFamily: 'var(--mono-font)', textTransform: 'none', letterSpacing: 0, color: 'var(--text-4)', fontSize: 10 }}>
        640 × 400 mm · 2.8346 px/mm
      </span>
    </div>
  );
}

export function Transport({ playing, onPlay, bpm, setBpm, time }) {
  const beats = 16;
  const beatNow = Math.floor((time * bpm / 60) % beats);
  const tapsRef = useRef([]);
  const handleTap = () => {
    const now = Date.now();
    const taps = tapsRef.current;
    if (taps.length > 0 && now - taps[taps.length - 1] > 2500) {
      tapsRef.current = [];
    }
    tapsRef.current = [...tapsRef.current.slice(-7), now];
    if (tapsRef.current.length >= 2) {
      const intervals = [];
      for (let i = 1; i < tapsRef.current.length; i++) {
        intervals.push(tapsRef.current[i] - tapsRef.current[i - 1]);
      }
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const newBpm = Math.round(60000 / avg);
      setBpm(Math.max(20, Math.min(600, newBpm)));
    }
  };
  return (
    <div className="lw-transport">
      <button className={`lw-play-btn ${playing ? 'stop' : ''}`} onClick={onPlay}>
        {playing ? (
          <><svg width="9" height="9" viewBox="0 0 9 9"><rect width="3" height="9" fill="currentColor"/><rect x="6" width="3" height="9" fill="currentColor"/></svg>Stop</>
        ) : (
          <><svg width="9" height="9" viewBox="0 0 9 9"><path d="M1 0 L8 4.5 L1 9 Z" fill="currentColor"/></svg>Play</>
        )}
        <span className="kbd" style={{ marginLeft: 4 }}>P</span>
      </button>

      <div className="lw-transport-meta">
        <span><span style={{color:'var(--text-4)'}}>BPM</span>&nbsp;&nbsp;<strong>{bpm}</strong></span>
        <button
          onClick={handleTap}
          style={{ fontSize: 10, padding: '2px 8px', fontFamily: 'var(--mono-font)',
                   background: 'var(--surface-2)', border: '1px solid var(--border)',
                   borderRadius: 3, color: 'var(--text-2)', cursor: 'pointer', lineHeight: 1.4 }}
          title="Tap to set BPM">
          TAP
        </button>
        <span><span style={{color:'var(--text-4)'}}>FPS</span>&nbsp;&nbsp;<strong>{playing ? 60 : '—'}</strong></span>
        <span><span style={{color:'var(--text-4)'}}>BEAT</span>&nbsp;&nbsp;<strong>{String(beatNow + 1).padStart(2, '0')}/{beats}</strong></span>
      </div>

      <div className="lw-timeline">
        <div className="lw-timeline-waveform"/>
        <div className="lw-timeline-beats">
          {Array.from({ length: beats }).map((_, i) => (
            <div key={i} className={`lw-timeline-beat ${i === beatNow ? 'active' : ''}`}/>
          ))}
        </div>
        <div className="lw-timeline-playhead" style={{ left: `${((time * bpm / 60) % beats) / beats * 100}%` }}/>
      </div>

      <div className="lw-transport-meta">
        <span><span style={{color:'var(--text-4)'}}>MIDI</span>&nbsp;&nbsp;<strong style={{color:'var(--mint)'}}>Launchkey</strong></span>
      </div>
    </div>
  );
}

export function StatusBar() {
  return (
    <div className="lw-statusbar">
      <span><span className="k">WLED</span>&nbsp;<span className="ok">● connected</span>&nbsp;<span className="v">192.168.1.42</span></span>
      <span className="sep">·</span>
      <span><span className="k">push</span>&nbsp;<span className="v">25 fps</span></span>
      <span className="sep">·</span>
      <span><span className="k">strip</span>&nbsp;<span className="v">WS2812B · 60/m</span></span>
      <span className="sep">·</span>
      <span><span className="k">total</span>&nbsp;<span className="v">1,204 LEDs</span></span>
      <div style={{ flex: 1 }}/>
      <span className="v">Tool: Select</span>
      <span className="sep">·</span>
      <span>Zoom 100%</span>
      <span className="sep">·</span>
      <span>⌘ Z · Space · P</span>
    </div>
  );
}
