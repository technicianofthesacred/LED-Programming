/* Studio shell (app.jsx), converted from the v3 mockup to an ES module and
   wired to the real ProjectProvider. The shell chrome (TopBar/Rail/StatusBar)
   keeps the mockup markup; data/handlers are threaded in from project state. */
import React, { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { ProjectProvider, useProject } from '../state/ProjectContext.jsx';
import { useCardStatus } from '../hooks/useCardStatus.js';
import { canPushDirectlyToCard } from '../lib/cardConnection.js';
import { DEFAULT_WLED_PUSH_FPS } from '../lib/deviceController.js';
import {
  bootstrapCardLink,
  cardLinkStatusText,
  connectCardLink,
  getCardLinkState,
  isCardLinkConnected,
  reportDirectCardStatus,
  subscribeCardLink,
} from '../lib/cardLink.js';
import { downloadJsonFile } from '../lib/downloadFile.js';
import { saveCurrentProjectToLibrary, writeActiveProjectLibraryRecordId } from '../lib/projectStorage.js';
import { formatBrowserProjectSaveLabel } from '../lib/studioActionStatus.js';
import { readTestStrip, writeTestStrip, TEST_STRIP_CHANGED_EVENT } from '../lib/testStrip.js';
import { PatternScreen } from './lw-pattern.jsx';
import { PlaylistScreen } from './lw-playlist.jsx';
import { LayoutScreen } from './lw-layout.jsx';
import { ShowScreen } from './lw-show.jsx';
import { FlashScreen } from './lw-flash.jsx';
import { SettingsScreen } from './lw-settings.jsx';
import { InstallerScreen } from './lw-installer.jsx';

const SCREEN_KEYS = ['pattern', 'playlist', 'layout', 'show', 'flash', 'settings', 'installer'];
function normalizeView(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'patterns') return 'pattern';
  return SCREEN_KEYS.includes(s) ? s : 'layout';
}
function viewFromHash() {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash.includes('=') ? hash : '');
  return normalizeView(params.get('screen') || 'layout');
}

/* ---------- tiny icon set (stroked, 1.6) ---------- */
const I = {
  layout: <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></svg>,
  pattern: <svg viewBox="0 0 24 24"><path d="M4 12c2-5 6-5 8 0s6 5 8 0"/><path d="M4 17c2-3 6-3 8 0s6 3 8 0"/></svg>,
  show: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M18.4 5.6l-2 2M7.6 16.4l-2 2"/></svg>,
  flash: <svg viewBox="0 0 24 24"><path d="M13 3 5 13h6l-1 8 8-10h-6z"/></svg>,
  settings: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>,
  playlist: <svg viewBox="0 0 24 24"><path d="M4 7h11M4 12h11M4 17h7"/><circle cx="18" cy="16" r="2.4"/><path d="M20.4 16V9l-3 1"/></svg>,
  installer: <svg viewBox="0 0 24 24"><path d="M3 13l2.5-7.5A1 1 0 0 1 6.5 5h11a1 1 0 0 1 1 .7L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1.5 2.2h5L16 13h5"/></svg>,
};

/* ---------- Top bar (wired to real project state via props) ---------- */
function TopBar({ projectName, saveLabel, onNew, onLoad, onDownload, onSave }) {
  return (
    <header className="topbar">
      <div className="brand"><span className="glyph" /><span className="name">Light Weaver</span></div>
      <nav className="crumb">
        <span>Projects</span><span className="sep">/</span><span className="proj">{projectName}</span>
        {saveLabel && <span className="savechip"><span className="dot" />{saveLabel}</span>}
      </nav>
      <div className="top-right">
        <button className="link-btn" title="Start a new empty project" onClick={onNew}>New project</button>
        <button className="link-btn" title="Open a project file from your computer" onClick={onLoad}>Load project</button>
        <span className="top-div" />
        <button className="link-btn" title="Download a keepable project file to your computer (reload it anytime)" onClick={onDownload}>Download file</button>
        <button className="btn primary" title="Save the project in this browser" onClick={onSave}>Save project</button>
      </div>
    </header>
  );
}

/* ---------- Left rail ---------- */
function Rail({ view, setView }) {
  const main = [["layout", "Layout"], ["pattern", "Patterns"], ["playlist", "Playlist"], ["show", "Show"], ["flash", "Flash"], ["installer", "Installer"]];
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

/* ---------- Status / Card bar (wired to the card-link state machine) ---------- */
/* The connection indicator reads the cardLink state machine ONLY: green dot +
   transport label when connected; otherwise the honest reason plus the
   one-click fix (Connect to card opens the card page popup, which is the only
   live path from the HTTPS Studio). */
function StatusBar({ link, onConnectCard, totalLeds, stripCount, density, fps, testStrip, onToggleTestStrip, onTestStripLengthChange }) {
  const connected = isCardLinkConnected(link);
  const connecting = link.state === 'connecting';
  return (
    <footer className="status-bar">
      <div className="sb-card">
        <span className={"sb-dot " + (connected ? "on" : "off")} />
        <span className="sb-label">Card</span>
        <input className="sb-host" value={link.host || 'lightweaver.local'} readOnly disabled aria-label="Card hostname or IP" />
        {connected ? (
          <span className="sb-stream" data-testid="card-link-status"><span className="pulse" />{cardLinkStatusText(link)}</span>
        ) : (
          <>
            <span data-testid="card-link-status" style={{ color: 'var(--text-mid)', whiteSpace: 'nowrap' }}>
              {cardLinkStatusText(link)}
            </span>
            {!connecting && (
              <button className="sb-connect" onClick={onConnectCard}>Connect to card</button>
            )}
          </>
        )}
      </div>

      <div className="sb-div" />

      <div className="sb-facts">
        <span className="sb-fact"><span>density</span><span className="fv">{density > 0 ? `${density}/m` : "—"}</span></span>
        <span className="sb-fact"><span>total</span><span className="fv">{totalLeds > 0 ? totalLeds.toLocaleString() : "—"} LEDs · {stripCount} strips</span></span>
        <span className="sb-fact"><span>push</span><span className="fv">{connected ? `${fps} fps` : "—"}</span></span>
      </div>

      <div className="sb-div" />

      <div className="sb-teststrip" data-testid="test-strip-control">
        <button
          type="button"
          className={"sb-ts-toggle" + (testStrip.enabled ? " on" : "")}
          onClick={() => onToggleTestStrip(!testStrip.enabled)}
          aria-pressed={testStrip.enabled}
          title="Bench-test on a short strip without changing your saved design"
        >
          Test strip
        </button>
        <input
          className="sb-ts-input"
          type="number"
          min={1}
          max={2000}
          value={testStrip.length}
          disabled={!testStrip.enabled}
          onChange={(e) => onTestStripLengthChange(e.target.value)}
          aria-label="Test strip LED count"
        />
        <span>LEDs</span>
        {testStrip.enabled && (
          <span className="sb-ts-note">Testing on {testStrip.length} LEDs — your design is unchanged.</span>
        )}
      </div>

      <div className="sb-spring" />
    </footer>
  );
}

/* ---------- Shell (inside ProjectProvider, real data wired in) ---------- */
/* The configured card push rate — same setting useWled reads (Settings →
   "Card push fps", persisted by Tweaks under lw_wled_push_fps). */
function readPushFps() {
  try {
    const v = Number(localStorage.getItem('lw_wled_push_fps'));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_WLED_PUSH_FPS;
  } catch { return DEFAULT_WLED_PUSH_FPS; }
}

function Shell() {
  const [view, setView] = useState(viewFromHash);
  const {
    projectName, serializeProject, loadProject, newProject,
    strips, layoutDensity,
  } = useProject();
  const [saveLabel, setSaveLabel] = useState('');
  const fileInputRef = useRef(null);

  // navigation <-> URL hash. Preserve the layout screen's `mode` deep-link
  // (e.g. #screen=layout&mode=size) so jumps like the Playlist "Adjust LED
  // count" button land on the right Layout mode; other screens carry no mode.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.set('screen', view);
    if (view !== 'layout') params.delete('mode');
    const next = `#${params.toString()}`;
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
    }
  }, [view]);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!saveLabel) return undefined;
    const t = setTimeout(() => setSaveLabel(''), 2200);
    return () => clearTimeout(t);
  }, [saveLabel]);

  // real card status — every screen and the footer read the cardLink state
  // machine, which merges direct HTTP polling (http/file pages) with the
  // card-page postMessage bridge keepalive (the only live path on HTTPS).
  const directCardControl = typeof window === 'undefined' ? false : canPushDirectlyToCard(window.location.protocol);
  const cardStatus = useCardStatus({ enabled: directCardControl });
  const cardLink = useSyncExternalStore(subscribeCardLink, getCardLinkState, getCardLinkState);
  useEffect(() => { void bootstrapCardLink(); }, []);
  useEffect(() => {
    if (!directCardControl) return;
    reportDirectCardStatus({
      connected: cardStatus.connected,
      // "checking" here means searching-while-not-connected: a disconnected
      // re-probe shows "Looking for the card…" again, while a routine poll on
      // a live link (connected=true) can never demote it — the reducer also
      // guards established links against a direct 'connecting' event.
      checking: cardStatus.checking && !cardStatus.connected,
      host: cardStatus.host,
    });
  }, [directCardControl, cardStatus.connected, cardStatus.checking, cardStatus.host]);
  const connected = isCardLinkConnected(cardLink);
  const totalLeds = strips.reduce((s, strip) => s + (strip.pixels?.length || 0), 0);
  const onConnectCard = useCallback(() => {
    if (directCardControl) {
      cardStatus.connect?.();
      return;
    }
    connectCardLink();
  }, [directCardControl, cardStatus]);

  // configured push rate; Tweaks fires lw-preview-settings when it changes
  const [pushFps, setPushFps] = useState(readPushFps);
  useEffect(() => {
    const sync = () => setPushFps(readPushFps());
    window.addEventListener('lw-preview-settings', sync);
    return () => window.removeEventListener('lw-preview-settings', sync);
  }, []);

  // Test strip mode (src/lib/testStrip.js) — a bench/session-only override,
  // never part of the saved project. Read fresh at mount, then kept in sync
  // with any other write (e.g. another tab) via its changed event.
  const [testStrip, setTestStripState] = useState(readTestStrip);
  useEffect(() => {
    const sync = () => setTestStripState(readTestStrip());
    window.addEventListener(TEST_STRIP_CHANGED_EVENT, sync);
    return () => window.removeEventListener(TEST_STRIP_CHANGED_EVENT, sync);
  }, []);
  const onToggleTestStrip = useCallback((enabled) => {
    setTestStripState(writeTestStrip({ enabled, length: readTestStrip().length }));
  }, []);
  const onTestStripLengthChange = useCallback((rawLength) => {
    const length = Number(rawLength);
    setTestStripState(writeTestStrip({ enabled: readTestStrip().enabled, length }));
  }, []);

  // real project actions
  const onSave = useCallback(() => {
    try {
      const record = saveCurrentProjectToLibrary(serializeProject());
      setSaveLabel(formatBrowserProjectSaveLabel(record));
    }
    catch { setSaveLabel('save failed'); }
  }, [serializeProject]);
  const onDownload = useCallback(async () => {
    const ok = await downloadJsonFile(
      `${(projectName || 'lightweaver').replace(/\s+/g, '-').toLowerCase()}.lw.json`,
      serializeProject(),
    );
    setSaveLabel(ok ? 'file downloaded' : 'download failed');
  }, [projectName, serializeProject]);
  const onLoad = useCallback(() => fileInputRef.current?.click(), []);
  const onNew = useCallback(() => {
    if (window.confirm('Start a new project? Unsaved changes will be lost.')) {
      writeActiveProjectLibraryRecordId('');
      newProject();
    }
  }, [newProject]);
  const onFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const ok = loadProject(data);
        if (ok) writeActiveProjectLibraryRecordId('');
        if (!ok) alert('Invalid project file (version mismatch).');
      } catch { alert('Could not parse project file.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [loadProject]);

  const Screen = { pattern: PatternScreen, playlist: PlaylistScreen, layout: LayoutScreen, show: ShowScreen, flash: FlashScreen, settings: SettingsScreen, installer: InstallerScreen }[view];

  return (
    <div className="app">
      <TopBar
        projectName={projectName || 'Untitled'}
        saveLabel={saveLabel}
        onNew={onNew} onLoad={onLoad} onDownload={onDownload} onSave={onSave}
      />
      <Rail view={view} setView={setView} />

      {Screen ? <Screen connected={connected} go={setView} /> : null}

      <StatusBar
        link={cardLink}
        onConnectCard={onConnectCard}
        totalLeds={totalLeds}
        stripCount={strips.length}
        density={layoutDensity}
        fps={pushFps}
        testStrip={testStrip}
        onToggleTestStrip={onToggleTestStrip}
        onTestStripLengthChange={onTestStripLengthChange}
      />
      <input ref={fileInputRef} type="file" accept=".lw.json,.json" style={{ display: 'none' }} onChange={onFile} />
    </div>
  );
}

function App() {
  return (
    <ProjectProvider>
      <Shell />
    </ProjectProvider>
  );
}

export default App;
