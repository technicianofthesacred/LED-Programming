import { useState, useRef, useCallback, useEffect } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { makeBlackoutFrame } from '../lib/deviceController.js';

const Icon = {
  layout:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M9 21V9"/></svg>,
  pattern: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>,
  live:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.5"/><circle cx="12" cy="12" r="7"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/></svg>,
  export:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M3 15v4a2 2 0 002 2h14a2 2 0 002-2v-4"/></svg>,
  flash:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>,
  timeline: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="8" height="4" rx="0.5"/><rect x="13" y="6" width="8" height="4" rx="0.5"/><rect x="3" y="14" width="12" height="4" rx="0.5"/><path d="M8 3v18" strokeDasharray="1 2"/></svg>,
  devices: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="14" height="10" rx="1"/><rect x="17" y="9" width="4" height="10" rx="0.5"/><path d="M7 19h6"/></svg>,
  cog:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>,
  kbd:     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>,
};

function BlackoutButton() {
  const { setActivePatternId, wledPush, strips } = useProject();
  const [active, setActive] = useState(false);
  return (
    <button
      className={`btn ${active ? '' : 'btn-ghost'}`}
      style={{ fontSize: 'var(--fs-xs)', letterSpacing: '0.08em',
               ...(active ? { background: 'oklch(25% 0.01 0)', borderColor: 'var(--danger)', color: 'var(--danger)' } : {}) }}
      title="Blackout — cut all output to black (B key in Live screen)"
      onClick={() => {
        setActive(a => !a);
        setActivePatternId(null);
        if (wledPush) {
          const total = strips.reduce((n, s) => n + (s.pixels?.length || s.pixelCount || 0), 0);
          wledPush(makeBlackoutFrame(total));
        }
      }}>
      BLKOUT
    </button>
  );
}

export function TopBar({ projectName: _pn, onSave, onOpen, onKbdHelp, audio, midi }) {
  const { projectName, setProjectName, liveRecording, serializeProject, loadProject, newProject } = useProject();
  const fileInputRef = useRef(null);
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(projectName);
  useEffect(() => { setNameVal(projectName); }, [projectName]);
  const commitName = () => { if (nameVal.trim()) setProjectName(nameVal.trim()); setEditingName(false); };

  const handleSave = () => {
    const data   = serializeProject();
    const blob   = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href       = url;
    a.download   = `${(projectName || 'lightweaver').replace(/\s+/g, '-').toLowerCase()}.lw.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleOpen = () => fileInputRef.current?.click();

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const ok = loadProject(data);
        if (!ok) alert('Invalid project file (version mismatch).');
      } catch {
        alert('Could not parse project file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="lw-topbar">
      <div className="lw-brand">
        <span className="lw-brand-dot"/>
        <span>Light Weaver</span>
      </div>
      <div className="lw-projbreadcrumbs">
        <span>Projects</span><span className="sep">/</span>
        {editingName ? (
          <input
            autoFocus
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false); }}
            style={{ background: 'none', border: 'none', borderBottom: '1px solid var(--accent)',
                     color: 'var(--text)', fontSize: 'var(--fs-md)', fontWeight: 500, outline: 'none', width: 180 }}
          />
        ) : (
          <strong onDoubleClick={() => setEditingName(true)} title="Double-click to rename"
                  style={{ cursor: 'text' }}>{projectName || 'Untitled'}</strong>
        )}
        <span className="status-chip"><span className="dot"/>ready</span>
        {liveRecording && <span className="status-chip" style={{color:'var(--danger)'}}>● REC</span>}
      </div>
      <div className="lw-topbar-actions">
        {audio && (
          <button className={`btn-ghost btn ${audio.enabled ? 'active' : ''}`}
                  onClick={audio.toggle}
                  title={audio.enabled ? 'Disable microphone' : 'Enable audio reactivity'}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="4" y="1" width="4" height="7" rx="2"/>
              <path d="M2 6a4 4 0 008 0M6 10v2"/>
            </svg>
            {audio.enabled && <span style={{ width: 5, height: 5, borderRadius: '50%',
              background: 'oklch(72% 0.18 155)', display: 'inline-block', marginLeft: 3 }}/>}
          </button>
        )}
        {midi && (
          <button className={`btn-ghost btn ${midi.enabled ? 'active' : ''}`}
                  onClick={midi.toggle}
                  title={midi.enabled ? `MIDI: ${midi.devices.length} device(s)` : 'Enable MIDI'}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="1" y="3" width="10" height="6" rx="1"/>
              <path d="M4 3V2M8 3V2M3 6v2M5 6v1M7 6v2M9 6v1"/>
            </svg>
          </button>
        )}
        <button className="btn-ghost btn" onClick={onKbdHelp} title="Keyboard shortcuts (?)">
          {Icon.kbd}
        </button>
        <a className="btn-ghost btn lw-version-link" href="http://localhost:9999" title="Switch to v1 — LED Art Mapper">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 6h8M6 2l4 4-4 4"/></svg>
          v1 Mapper
        </a>
        <button className="btn-ghost btn" onClick={() => {
          if (window.confirm('Start a new project? Unsaved changes will be lost.')) newProject();
        }}>New</button>
        <button className="btn-ghost btn" onClick={handleOpen}>Open</button>
        <button className="btn-ghost btn" onClick={handleSave}>Save</button>
        <BlackoutButton/>
        <input ref={fileInputRef} type="file" accept=".lw.json,.json"
               style={{ display: 'none' }} onChange={handleFileChange}/>
      </div>
    </div>
  );
}

export function LeftRail({ screen, onScreen }) {
  const { liveRecording } = useProject();
  const items = [
    { id: 'layout',   label: 'Layout',   icon: Icon.layout },
    { id: 'pattern',  label: 'Pattern',  icon: Icon.pattern },
    { id: 'timeline', label: 'Show',     icon: Icon.timeline },
    { id: 'live',     label: 'Live',     icon: Icon.live, badge: liveRecording ? '●' : null },
    { id: 'export',   label: 'Export',   icon: Icon.export },
    { id: 'flash',    label: 'Flash',    icon: Icon.flash },
  ];
  return (
    <div className="lw-rail">
      {items.map(it => (
        <button key={it.id}
                className={`lw-rail-btn ${screen === it.id ? 'active' : ''} ${it.id === 'live' && liveRecording ? 'recording' : ''}`}
                onClick={() => onScreen(it.id)}>
          {it.icon}
          <span>{it.label}</span>
          {it.badge && <span className="lw-rail-badge" style={{color:'var(--danger)'}}>{it.badge}</span>}
        </button>
      ))}
      <div className="lw-rail-spacer"/>
      <button className={`lw-rail-btn ${screen === 'devices' ? 'active' : ''}`} onClick={() => onScreen('devices')}>
        {Icon.devices}<span>Devices</span>
      </button>
      <button className={`lw-rail-btn ${screen === 'settings' ? 'active' : ''}`} onClick={() => onScreen('settings')}>
        {Icon.cog}<span>Settings</span>
      </button>
    </div>
  );
}

export function CanvasToolbar({ glow, setGlow, dot, setDot, heat, setHeat, onResetPreview, children }) {
  return (
    <div className="lw-canvas-toolbar">
      <span className="tbar-label">LEDs</span>
      <div className="tbar-slider">
        <span>Glow</span>
        <input type="range" min="0" max="3" step="0.1" value={glow} onChange={e => setGlow(+e.target.value)}/>
        <span className="v">{glow.toFixed(1)}×</span>
      </div>
      <div className="tbar-slider">
        <span>Dot</span>
        <input type="range" min="0.3" max="2.5" step="0.05" value={dot} onChange={e => setDot(+e.target.value)}/>
        <span className="v">{dot.toFixed(2)}×</span>
      </div>
      <button className={`btn ${heat ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setHeat(!heat)}>
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M6 1c-2 2-3 3-3 5a3 3 0 006 0c0-2-1-3-3-5z"/></svg>
        Coverage
      </button>
      <button className="btn btn-ghost" onClick={onResetPreview} title="Reset preview zoom and time">
        Reset
      </button>
      {children}
      <div style={{ flex: 1 }}/>
      <span style={{ fontFamily: 'var(--mono-font)', textTransform: 'none', letterSpacing: 0, color: 'var(--text-4)', fontSize: 'var(--fs-xs)' }}>
        640 × 400 mm · 2.8346 px/mm
      </span>
    </div>
  );
}

export function Transport({ playing, onPlay, bpm, setBpm, time, fps }) {
  const beats  = 16;
  const beatNow = Math.floor((time * bpm / 60) % beats);
  const tapsRef = useRef([]);
  const handleTap = () => {
    const now = Date.now();
    const taps = tapsRef.current;
    if (taps.length > 0 && now - taps[taps.length - 1] > 2500) tapsRef.current = [];
    tapsRef.current = [...tapsRef.current.slice(-7), now];
    if (tapsRef.current.length >= 2) {
      const intervals = [];
      for (let i = 1; i < tapsRef.current.length; i++)
        intervals.push(tapsRef.current[i] - tapsRef.current[i - 1]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      setBpm(Math.max(20, Math.min(600, Math.round(60000 / avg))));
    }
  };
  return (
    <div className="lw-transport">
      <button className={`lw-play-btn ${playing ? 'stop' : ''}`} onClick={onPlay}>
        {playing
          ? <><svg width="9" height="9" viewBox="0 0 9 9"><rect width="3" height="9" fill="currentColor"/><rect x="6" width="3" height="9" fill="currentColor"/></svg>Stop</>
          : <><svg width="9" height="9" viewBox="0 0 9 9"><path d="M1 0 L8 4.5 L1 9 Z" fill="currentColor"/></svg>Play</>}
        <span className="kbd" style={{ marginLeft: 4 }}>P</span>
      </button>
      <div className="lw-transport-meta">
        <span><span style={{color:'var(--text-4)'}}>BPM</span>&nbsp;&nbsp;<strong>{bpm}</strong></span>
        <button onClick={handleTap} style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', fontFamily: 'var(--mono-font)',
               background: 'var(--surface-2)', border: '1px solid var(--border)',
               borderRadius: 3, color: 'var(--text-2)', cursor: 'pointer', lineHeight: 1.4 }}>
          TAP
        </button>
        <span><span style={{color:'var(--text-4)'}}>FPS</span>&nbsp;&nbsp;<strong style={{ color: fps && fps < 30 ? 'var(--danger)' : undefined }}>{playing ? (fps || '…') : '—'}</strong></span>
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
  const { wledConnected, wledIp, strips, audioBands, bpm, lastSaved, activePatternId, masterBrightness, masterSpeed } = useProject();
  const savedAgo = lastSaved ? Math.round((Date.now() - lastSaved) / 1000) : null;
  const totalLEDs = strips.reduce((s, strip) => s + (strip.pixels?.length || 0), 0);
  const energy = audioBands?.energy || 0;
  return (
    <div className="lw-statusbar">
      <span>
        <span className="k">WLED</span>&nbsp;
        <span className={wledConnected ? 'ok' : 'err'}>
          {wledConnected ? '● connected' : '○ disconnected'}
        </span>
        {wledIp && <>&nbsp;<span className="v">{wledIp}</span></>}
      </span>
      <span className="sep">·</span>
      <span><span className="k">strip</span>&nbsp;<span className="v">WS2812B · 60/m</span></span>
      <span className="sep">·</span>
      <span><span className="k">total</span>&nbsp;<span className="v">{totalLEDs > 0 ? totalLEDs.toLocaleString() : '—'} LEDs · {strips.length} strips</span></span>
      <span className="sep">·</span>
      <span><span className="k">BPM</span>&nbsp;<span className="v">{bpm}</span></span>
      {activePatternId && (
        <>
          <span className="sep">·</span>
          <span><span className="k">pattern</span>&nbsp;<span className="v">{activePatternId}</span></span>
        </>
      )}
      {masterBrightness < 0.99 && (
        <>
          <span className="sep">·</span>
          <span><span className="k">dim</span>&nbsp;<span className="v" style={{ color: 'var(--accent)' }}>{Math.round(masterBrightness * 100)}%</span></span>
        </>
      )}
      {energy > 0.01 && (
        <>
          <span className="sep">·</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span className="k">audio</span>&nbsp;
            <span style={{ display: 'inline-flex', gap: 1, alignItems: 'flex-end', height: 10 }}>
              {[audioBands?.bass, audioBands?.mid, audioBands?.hi].map((v, i) => (
                <span key={i} style={{
                  width: 3, height: Math.max(1, Math.round((v || 0) * 10)),
                  background: ['var(--danger)', 'var(--accent)', 'var(--mint)'][i],
                  borderRadius: 1, display: 'inline-block',
                }}/>
              ))}
            </span>
          </span>
        </>
      )}
      <div style={{ flex: 1 }}/>
      {lastSaved && (
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>
          autosaved {savedAgo < 5 ? 'just now' : `${savedAgo}s ago`}
        </span>
      )}
      <span className="sep">·</span>
      <span className="v">⌘Z · Space · ? for shortcuts</span>
    </div>
  );
}
