import { useState, useRef, useCallback, useEffect } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { useCardStatus } from '../hooks/useCardStatus.js';
import { canPushDirectlyToCard } from '../lib/cardConnection.js';
import {
  bootstrapCardBridgeFromOpener,
  CARD_BRIDGE_CHANGED_EVENT,
  getCardBridgeState,
  openCardBridge,
} from '../lib/cardBridge.js';
import { downloadJsonFile } from '../lib/downloadFile.js';
import { saveCurrentProjectToLibrary, writeActiveProjectLibraryRecordId } from '../lib/projectStorage.js';

const Icon = {
  pattern: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M4 13.5c3.8-7.6 12.2-7.6 16 0"/><path d="M4 17.5c3.8-4.4 12.2-4.4 16 0"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="9" r="1"/><circle cx="16" cy="11" r="1"/></svg>,
  playlist:<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>,
  chip:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><rect x="10" y="10" width="4" height="4" rx=".5"/></svg>,
  flash:   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L4 14h7l-1 8 10-13h-7l0-7z"/></svg>,
  install: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l2 2 4-5"/><path d="M21 12a9 9 0 11-6.2-8.56"/><path d="M16 3h5v5"/></svg>,
  layout:  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M9 21V9"/></svg>,
};

export function TopBar() {
  const { projectName, setProjectName, serializeProject, loadProject, newProject } = useProject();
  const fileInputRef = useRef(null);
  const [editingName, setEditingName] = useState(false);
  const [nameVal, setNameVal] = useState(projectName);
  const [saveState, setSaveState] = useState('ready');
  useEffect(() => { setNameVal(projectName); }, [projectName]);
  useEffect(() => {
    if (saveState === 'ready') return undefined;
    const timer = setTimeout(() => setSaveState('ready'), 2200);
    return () => clearTimeout(timer);
  }, [saveState]);
  const commitName = () => { if (nameVal.trim()) setProjectName(nameVal.trim()); setEditingName(false); };

  const handleNewProject = () => {
    if (window.confirm('Start a new project? Unsaved changes will be lost.')) {
      writeActiveProjectLibraryRecordId('');
      newProject();
    }
  };

  const handleSave = () => {
    try {
      saveCurrentProjectToLibrary(serializeProject());
      setSaveState('saved in browser');
    } catch {
      setSaveState('save failed');
    }
  };

  const handleDownload = async () => {
    const data   = serializeProject();
    const ok = await downloadJsonFile(`${(projectName || 'lightweaver').replace(/\s+/g, '-').toLowerCase()}.lw.json`, data);
    setSaveState(ok ? 'file downloaded' : 'download failed');
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
        if (ok) writeActiveProjectLibraryRecordId('');
        if (!ok) alert('Invalid project file (version mismatch).');
      } catch {
        alert('Could not parse project file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="glyph"/>
        <span className="name">Light Weaver</span>
      </div>
      <nav className="crumb">
        <span>Projects</span><span className="sep">/</span>
        {editingName ? (
          <input
            autoFocus
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false); }}
            style={{ background: 'none', border: 'none', borderBottom: '1px solid var(--accent)',
                     color: 'var(--text-hi)', fontSize: '13px', fontWeight: 500, outline: 'none', width: 180 }}
          />
        ) : (
          <span className="proj" onDoubleClick={() => setEditingName(true)} title="Double-click to rename"
                  style={{ cursor: 'text' }}>{projectName || 'Untitled'}</span>
        )}
        {saveState !== 'ready' && (
          <span className={`savechip ${saveState.includes('failed') ? 'is-save-error' : ''}`}>
            <span className="dot"/>{saveState}
          </span>
        )}
      </nav>
      <div className="top-right">
        <button className="link-btn" onClick={handleNewProject} title="Start a new empty project">New project</button>
        <button className="link-btn" onClick={handleOpen} title="Open a project file from your computer">Load project</button>
        <span className="top-div"/>
        <button className="link-btn" onClick={handleDownload} title="Download a keepable project file you can reload anytime">Download file</button>
        <button className="btn primary" onClick={handleSave} title="Save the project in this browser">Save project</button>
        <input ref={fileInputRef} type="file" accept=".lw.json,.json"
               style={{ display: 'none' }} onChange={handleFileChange}/>
      </div>
    </header>
  );
}

export function LeftRail({ screen, onScreen }) {
  // Main rail items (Settings is pinned to the foot, matching the v3 mockup).
  // Show/timeline is intentionally not in the rail yet (framework kept, not live).
  const main = [
    { id: 'patterns', label: 'Patterns', icon: Icon.pattern },
    { id: 'playlist', label: 'Playlist', icon: Icon.playlist },
    { id: 'layout',   label: 'Layout',   icon: Icon.layout },
    { id: 'flash',    label: 'Flash',    icon: Icon.flash },
    { id: 'installer', label: 'Installer', icon: Icon.install },
  ];
  const foot = [
    { id: 'settings', label: 'Settings', icon: Icon.chip },
  ];
  const item = (it) => (
    <button key={it.id}
            className={`rail-item ${screen === it.id ? 'active' : ''}`}
            onClick={() => onScreen(it.id)}>
      <span className="ico">{it.icon}</span>
      <span className="lbl">{it.label}</span>
    </button>
  );
  return (
    <aside className="rail">
      {main.map(item)}
      <div className="spring"/>
      {foot.map(item)}
    </aside>
  );
}

export function CanvasToolbar({ glow, setGlow, dot, setDot, heat, setHeat, onResetPreview, children }) {
  const glowLabel = glow <= 0 ? 'Off' : glow < 0.8 ? 'Tune' : 'Show';
  const cycleGlow = () => {
    const next = glow <= 0 ? 0.45 : glow < 0.8 ? 1.05 : 0;
    setGlow(next);
  };
  const dotLabel = dot < 0.8 ? 'Small' : dot < 1.45 ? 'Normal' : 'Large';
  const cycleDot = () => {
    const next = dot < 0.8 ? 1 : dot < 1.45 ? 1.75 : 0.55;
    setDot(next);
  };

  return (
    <div className="lw-canvas-toolbar">
      <span className="tbar-label">LEDs</span>
      <button className={`btn ${glow > 0 ? 'btn-primary' : 'btn-ghost'}`} onClick={cycleGlow} title="Cycle glow strength">
        Glow {glowLabel}
      </button>
      <button className="btn btn-ghost" onClick={cycleDot} title="Cycle LED dot size">
        Dot {dotLabel}
      </button>
      <button className={`btn ${heat ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setHeat(!heat)} title="Toggle coverage view" aria-pressed={heat}>
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
      <button className={`lw-play-btn ${playing ? 'stop' : ''}`} onClick={onPlay} aria-label={playing ? 'Stop preview' : 'Play preview'}>
        {playing
          ? <><svg width="9" height="9" viewBox="0 0 9 9"><rect width="3" height="9" fill="currentColor"/><rect x="6" width="3" height="9" fill="currentColor"/></svg>Stop</>
          : <><svg width="9" height="9" viewBox="0 0 9 9"><path d="M1 0 L8 4.5 L1 9 Z" fill="currentColor"/></svg>Play</>}
        <span className="kbd" style={{ marginLeft: 4 }}>P</span>
      </button>
      <div className="lw-transport-meta">
        <span><span style={{color:'var(--text-4)'}}>BPM</span>&nbsp;&nbsp;<strong>{bpm}</strong></span>
        <button onClick={handleTap} aria-label="Tap tempo" style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px', fontFamily: 'var(--mono-font)',
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

export function StatusBar({ screen = 'patterns' }) {
  const { wledConnected, wledIp, strips, lastSaved } = useProject();
  const directCardControl = typeof window === 'undefined' ? false : canPushDirectlyToCard(window.location.protocol);
  const cardStatus = useCardStatus({ enabled: directCardControl });
  const [bridgeState, setBridgeState] = useState(getCardBridgeState);
  const [cardHint, setCardHint] = useState('');
  useEffect(() => {
    bootstrapCardBridgeFromOpener();
    setBridgeState(getCardBridgeState());
    const onBridgeChange = () => setBridgeState(getCardBridgeState());
    window.addEventListener?.(CARD_BRIDGE_CHANGED_EVENT, onBridgeChange);
    return () => window.removeEventListener?.(CARD_BRIDGE_CHANGED_EVENT, onBridgeChange);
  }, []);
  useEffect(() => {
    if (!cardHint) return undefined;
    const timer = setTimeout(() => setCardHint(''), 2500);
    return () => clearTimeout(timer);
  }, [cardHint]);
  const savedAgo = lastSaved ? Math.round((Date.now() - lastSaved) / 1000) : null;
  const totalLEDs = strips.reduce((s, strip) => s + (strip.pixels?.length || 0), 0);
  const bridgeConnected = !directCardControl && bridgeState.connected;
  const cardConnected = cardStatus.connected || wledConnected || bridgeConnected;
  const cardHost = bridgeConnected ? bridgeState.host : (cardStatus.connected ? cardStatus.host : (wledIp || cardStatus.host || bridgeState.host));
  const cardRecovering = Boolean(cardStatus.reconnecting) && !wledConnected;
  const cardLabel = cardStatus.checking && !cardConnected
    ? '◌ finding'
    : cardRecovering ? '◌ reconnecting'
      : bridgeConnected ? '● bridge' : cardConnected ? '● connected' : '○ disconnected';
  const cardStatusClass = cardRecovering ? 'warn' : cardConnected ? 'ok' : 'err';
  const cardActionLabel = cardStatus.checking && !cardConnected
    ? directCardControl ? 'scan' : 'handoff'
    : cardRecovering
      ? directCardControl ? `auto ${Math.min(cardStatus.missCount || 1, 3)}/3` : 'handoff'
      : bridgeConnected ? 'ready' : cardConnected ? 'recheck' : directCardControl ? 'reconnect' : 'handoff';
  const cardTitle = directCardControl
    ? 'Click to run a deeper reconnect. Lightweaver remembers working card addresses and keeps retrying in the background.'
    : 'Public HTTPS browsers block direct local-card reconnects. Click to open the local card bridge and hand Studio to it.';
  const handleCardReconnect = async () => {
    setCardHint('');
    if (!directCardControl) {
      openCardBridge(cardHost, {
        autoOpenStudio: true,
        studioUrl: typeof window !== 'undefined' ? window.location.href : '',
      });
      setCardHint('handoff opened');
      return;
    }
    const result = await cardStatus.connect();
    if (result.connected) {
      setCardHint('locked');
      return;
    }
    setCardHint(directCardControl ? 'still scanning' : 'use local');
  };
  return (
    <footer className="status-bar">
      <div className="sb-card">
        <button
          type="button"
          className="lw-status-card-btn"
          data-testid="card-status-reconnect"
          aria-label="Card status"
          title={cardTitle}
          onClick={handleCardReconnect}
          style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'none', padding: 0 }}
        >
          <span className={'sb-dot ' + (cardConnected ? 'on' : 'off')}/>
          <span className="sb-label">Card</span>
          <span className={cardStatusClass} style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{cardLabel}</span>
        </button>
        {cardHost && <span className="sb-host" style={{ display: 'inline-flex', alignItems: 'center' }}>{cardHost}</span>}
        <button
          type="button"
          className={'sb-connect' + (cardConnected ? ' is-on' : '')}
          onClick={handleCardReconnect}
          title={cardTitle}
        >{cardHint || cardActionLabel}</button>
        {cardConnected && <span className="sb-stream"><span className="pulse"/>Art-Net live</span>}
      </div>

      <div className="sb-div"/>

      <div className="sb-facts">
        <span className="sb-fact"><span>strip</span><span className="fv">WS2812B · 60/m</span></span>
        <span className="sb-fact"><span>total</span><span className="fv">{totalLEDs > 0 ? totalLEDs.toLocaleString() : '—'} LEDs · {strips.length} strips</span></span>
        {lastSaved && <span className="sb-fact"><span>saved</span><span className="fv">{savedAgo < 5 ? 'just now' : `${savedAgo}s ago`}</span></span>}
      </div>

      <div className="sb-spring"/>

      <div className="sb-right">
        <span className="sb-fact"><span>1</span><span className="fv">Patterns</span></span>
        <span className="sb-fact"><span>2</span><span className="fv">Playlist</span></span>
        <span className="sb-fact"><span>3</span><span className="fv">Layout</span></span>
        <span className="sb-fact"><span>4</span><span className="fv">Settings</span></span>
        <span className="sb-fact"><span>5</span><span className="fv">Flash</span></span>
        <span className="sb-fact"><span>6</span><span className="fv">Installer</span></span>
        <span className="sb-fact"><span className="kbd">?</span><span className="fv">shortcuts</span></span>
      </div>
    </footer>
  );
}
