import { Suspense, lazy, useState, useEffect, useCallback, useRef } from 'react';
import { ProjectProvider, useProject } from './state/ProjectContext.jsx';
import { TopBar, LeftRail, CanvasToolbar, Transport, StatusBar } from './components/Chrome.jsx';
import { LEDPreview } from './components/Preview.jsx';
import { ExportDialog } from './components/ExportDialog.jsx';
import { KeyboardHelp } from './components/KeyboardHelp.jsx';
import { CommandPalette } from './components/CommandPalette.jsx';
import { useTweaks, TweaksPanel } from './components/Tweaks.jsx';
import { WledBar } from './components/WledBar.jsx';
import { useAudio } from './hooks/useAudio.js';
import { useMidi } from './hooks/useMidi.js';
import { PATTERNS } from './data.js';
import { acceptAiDraftAsCustomPattern } from './lib/customPatterns.js';

const LoadingPane = () => <div className="lw-loading-pane">Loading...</div>;

const CardsMode = lazy(() => import('./components/PatternModes.jsx').then(m => ({ default: m.CardsMode })));
const CodeMode = lazy(() => import('./components/PatternModes.jsx').then(m => ({ default: m.CodeMode })));
const GraphMode = lazy(() => import('./components/PatternModes.jsx').then(m => ({ default: m.GraphMode })));
const SymmetryMode = lazy(() => import('./components/SymmetryMode.jsx').then(m => ({ default: m.SymmetryMode })));
const LayoutScreen = lazy(() => import('./components/LayoutScreen.jsx').then(m => ({ default: m.LayoutScreen })));
const TimelineScreen = lazy(() => import('./components/TimelineScreen.jsx').then(m => ({ default: m.TimelineScreen })));
const LiveScreen = lazy(() => import('./components/LiveScreen.jsx').then(m => ({ default: m.LiveScreen })));
const ExportScreen = lazy(() => import('./components/OtherScreens.jsx').then(m => ({ default: m.ExportScreen })));
const FlashScreen = lazy(() => import('./components/OtherScreens.jsx').then(m => ({ default: m.FlashScreen })));
const DevicesPanel = lazy(() => import('./components/DevicesPanel.jsx').then(m => ({ default: m.DevicesPanel })));
const SettingsScreen = lazy(() => import('./components/SettingsScreen.jsx').then(m => ({ default: m.SettingsScreen })));
const AiPatternAssistant = lazy(() => import('./components/AiPatternAssistant.jsx').then(m => ({ default: m.AiPatternAssistant })));

const ModeIcon = {
  cards: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><rect x="2" y="2" width="5" height="5" rx="0.5"/><rect x="9" y="2" width="5" height="5" rx="0.5"/><rect x="2" y="9" width="5" height="5" rx="0.5"/><rect x="9" y="9" width="5" height="5" rx="0.5"/></svg>,
  code:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><path d="M5 4 L2 8 L5 12 M11 4 L14 8 L11 12 M9 3 L7 13" strokeLinecap="round"/></svg>,
  graph: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><circle cx="3" cy="4" r="1.5"/><circle cx="3" cy="12" r="1.5"/><circle cx="13" cy="8" r="1.5"/><path d="M4.3 4.5 L11.7 7.5 M4.3 11.5 L11.7 8.5"/></svg>,
  sym:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5V13.5M2.5 8H13.5M4.1 4.1L11.9 11.9M11.9 4.1L4.1 11.9"/></svg>,
};

function PatternPanel({
  panelMode, setPanelMode,
  patternId, onSelectPattern,
  params, setParams,
  palette, onPaletteChange,
  onCodeChange,
  strips,
  hidden,
  audioBands,
  onAcceptAiDraft,
  masterSpeed, setMasterSpeed,
  masterBrightness, setMasterBrightness,
  masterSaturation, setMasterSaturation,
  gammaEnabled, setGammaEnabled,
  gammaValue, setGammaValue,
  onCollapse,
}) {
  const updateMasterPaletteColor = (index, value) => {
    const next = [...(palette || [])];
    next[index] = value;
    onPaletteChange(next);
  };

  return (
    <div className="lw-panel">
      <div className="lw-panel-mode-switch">
        <button className="lw-panel-collapse-btn" onClick={onCollapse} title="Collapse panel">‹</button>
        {[['graph','Tune',ModeIcon.graph],['cards','Browse',ModeIcon.cards],['code','Code',ModeIcon.code],['sym','Symmetry',ModeIcon.sym]].map(([v,l,ic]) => (
          <button key={v} className={`lw-panel-mode-btn ${panelMode === v ? 'active' : ''}`} onClick={() => setPanelMode(v)}>
            {ic}<span>{l}</span>
          </button>
        ))}
      </div>
      <Suspense fallback={null}>
        <AiPatternAssistant
          patternId={patternId}
          palette={palette}
          params={params}
          strips={strips}
          hidden={hidden}
          audioBands={audioBands}
          onAcceptDraft={onAcceptAiDraft}
        />
      </Suspense>
      <div className="lw-panel-body">
        {panelMode === 'cards' && (
          <CardsMode patternId={patternId} onSelectPattern={onSelectPattern}
                     params={params} onParamChange={(k, v) => setParams({ ...params, [k]: v })}
                     palette={palette} onPaletteChange={onPaletteChange}/>
        )}
        {panelMode === 'code'  && (
          <CodeMode
            patternId={patternId}
            onCodeChange={onCodeChange}
            params={params}
            onParamChange={(k, v) => setParams({ ...params, [k]: v })}
          />
        )}
        {panelMode === 'graph' && (
          <GraphMode
            patternId={patternId}
            onOpenCode={() => setPanelMode('code')}
            onOpenSymmetry={() => setPanelMode('sym')}
            masterSpeed={masterSpeed}
            setMasterSpeed={setMasterSpeed}
            masterBrightness={masterBrightness}
            setMasterBrightness={setMasterBrightness}
            masterSaturation={masterSaturation}
            setMasterSaturation={setMasterSaturation}
          />
        )}
        {panelMode === 'sym'   && <SymmetryMode/>}
        {panelMode !== 'graph' && (
          <>
            <div className="lw-sec-header" style={{ marginTop: 24 }}>
              <span>Master</span>
              <span className="meta">applies globally</span>
            </div>
            <div className="lw-master">
              <span className="lbl">Speed</span>
              <input type="range" min="0" max="4" step="0.01" value={masterSpeed}
                     onChange={e => setMasterSpeed(+e.target.value)}/>
              <span className="v">{masterSpeed.toFixed(2)}×</span>

              <span className="lbl">Bright</span>
              <input type="range" min="0" max="1" step="0.01" value={masterBrightness}
                     onChange={e => setMasterBrightness(+e.target.value)}/>
              <span className="v">{Math.round(masterBrightness * 100)}%</span>

              <span className="lbl">Sat</span>
              <input type="range" min="0" max="1" step="0.01" value={masterSaturation}
                     onChange={e => setMasterSaturation(+e.target.value)}/>
              <span className="v">{Math.round(masterSaturation * 100)}%</span>

              <span className="lbl">Color</span>
              <div className="lw-master-palette" aria-label="Master palette">
                {(palette || []).slice(0, 6).map((hex, index) => (
                  <label key={`${hex}-${index}`} className="lw-master-swatch" style={{ background: hex }}>
                    <input
                      aria-label={`Master palette color ${index + 1}`}
                      type="color"
                      value={hex}
                      onChange={event => updateMasterPaletteColor(index, event.target.value)}
                    />
                  </label>
                ))}
              </div>
              <span className="v">{(palette || []).length}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PatternScreen({ panelMode, setPanelMode }) {
  const [panelWidth, setPanelWidth] = useState(
    () => parseInt(localStorage.getItem('lw-panel-width') || '300', 10)
  );
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [compareMode,    setCompareMode]    = useState(false);
  const [compareId,      setCompareId]      = useState('aurora');

  const handleDividerMouseDown = (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = panelWidth;
    const el = e.currentTarget;
    el.classList.add('dragging');
    const onMove = (ev) => {
      const newW = Math.max(180, Math.min(600, startW + (startX - ev.clientX)));
      setPanelWidth(newW);
      localStorage.setItem('lw-panel-width', String(newW));
    };
    const onUp = () => {
      el.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const {
    strips: projectStrips, viewBox: projectViewBox, svgText: projectSvgText, hidden: projectHidden,
    activePatternId: patternId, setActivePatternId: setPatternId,
    palette, setPalette,
    masterSpeed, setMasterSpeed,
    masterBrightness, setMasterBrightness,
    masterSaturation, setMasterSaturation,
    masterHueShift,
    motionSmoothing,
    gammaEnabled, setGammaEnabled,
    gammaValue, setGammaValue,
    patternParams, setPatternParams,
    bpm, setBpm,
    wledPush,
    symSettings,
    audioBands,
  } = useProject();

  // Read URL hash for initial pattern on mount
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash.includes('=') ? hash : '');
    const pid = params.get('pattern');
    if (pid && PATTERNS.find(p => p.id === pid)) setPatternId(pid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [playing, setPlaying]             = useState(true);
  const [glow, setGlow]                   = useState(1.2);
  const [dot, setDot]                     = useState(1.0);
  const [heat, setHeat]                   = useState(false);
  const [compiledFn, setCompiledFn]       = useState(null);
  const [zoom, setZoom]                   = useState(1.0);
  const [liveT, setLiveT]                 = useState(0);
  const [liveFps, setLiveFps]             = useState(0);
  const [previewResetKey, setPreviewResetKey] = useState(0);

  const params    = patternParams[patternId] || {};
  const setParams = useCallback((newParams) => {
    setPatternParams(prev => ({ ...prev, [patternId]: newParams }));
  }, [patternId, setPatternParams]);

  const handleFrame = useCallback((pixels) => { wledPush(pixels); }, [wledPush]);

  const handleCodeChange = useCallback(({ fn, error, parsedParams }) => {
    setCompiledFn(error ? null : () => fn);
    // Auto-populate default param values from @param annotations
    if (parsedParams?.length > 0) {
      setPatternParams(prev => {
        const existing = prev[patternId] || {};
        const defaults = Object.fromEntries(parsedParams.map(p => [p.name, p.value]));
        return { ...prev, [patternId]: { ...defaults, ...existing } };
      });
    }
  }, [patternId, setPatternParams]);

  const handleSelectPattern = useCallback((id) => {
    setPatternId(id);
    setCompiledFn(null);
  }, [setPatternId]);

  const handleAcceptAiDraft = useCallback((acceptedDraft, sourcePattern, parsedParams = []) => {
    const accepted = acceptAiDraftAsCustomPattern({ sourcePattern, draft: acceptedDraft });
    if (!accepted?.id) return null;
    setPatternId(accepted.id);
    setCompiledFn(null);
    setPreviewResetKey(key => key + 1);
    if (accepted.palette?.length) setPalette(accepted.palette);
    const defaults = Object.fromEntries(parsedParams.map(param => [param.name, param.value]));
    setPatternParams(prev => ({
      ...prev,
      [accepted.id]: {
        ...defaults,
        ...(accepted.params || {}),
      },
    }));
    return accepted;
  }, [setPalette, setPatternId, setPatternParams]);

  const cur = PATTERNS.find(p => p.id === patternId);
  const gridCols = panelCollapsed ? '1fr 32px' : `1fr 5px ${panelWidth}px`;

  return (
    <div className="lw-pattern-screen" style={{ gridTemplateColumns: gridCols }}>
      <div className="lw-canvas-col">
        <CanvasToolbar
          glow={glow}
          setGlow={setGlow}
          dot={dot}
          setDot={setDot}
          heat={heat}
          setHeat={setHeat}
          onResetPreview={() => { setZoom(1); setPreviewResetKey(k => k + 1); }}
        >
          <button
            className={`btn btn-ghost ${compareMode ? 'active' : ''}`}
            style={{ fontSize: 'var(--fs-xs)' }}
            onClick={() => setCompareMode(m => !m)}
            title="A/B compare mode">
            A|B
          </button>
        </CanvasToolbar>
        <div className="lw-viewport" style={{ overflow: 'hidden' }}>
          {compareMode ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', width: '100%', height: '100%' }}>
              <div style={{ position: 'relative', overflow: 'hidden', borderRight: '1px solid var(--border)' }}>
                <LEDPreview
                  key={`a-${previewResetKey}`}
                  patternId={patternId} playing={playing} glow={glow} dotSize={dot} speed={1}
                  strips={projectStrips.length > 0 ? projectStrips : undefined}
                  viewBox={projectStrips.length > 0 ? projectViewBox : undefined}
                  svgText={projectSvgText}
                  masterSpeed={masterSpeed} masterBrightness={masterBrightness}
                  masterSaturation={masterSaturation} masterHueShift={masterHueShift} gammaEnabled={gammaEnabled}
                  gammaValue={gammaValue} hidden={projectHidden} compiledFn={compiledFn}
                  bpm={bpm} params={params} symSettings={symSettings} audioBands={audioBands}
                  motionSmoothing={motionSmoothing}
                  heat={heat}
                  onTick={setLiveT} onFrame={handleFrame}
                />
                <div className="lw-viewport-overlay tl" style={{ fontSize: 'var(--fs-2xs)' }}>
                  <span style={{ background: 'var(--accent)', color: 'var(--on-accent)', padding: '1px 5px', borderRadius: 2 }}>A</span>
                  <span className="v">{cur?.name || patternId}</span>
                </div>
              </div>
              <div style={{ position: 'relative', overflow: 'hidden' }}>
                <LEDPreview
                  key={`b-${previewResetKey}`}
                  patternId={compareId} playing={playing} glow={glow} dotSize={dot} speed={1}
                  strips={projectStrips.length > 0 ? projectStrips : undefined}
                  viewBox={projectStrips.length > 0 ? projectViewBox : undefined}
                  svgText={projectSvgText}
                  masterSpeed={masterSpeed} masterBrightness={masterBrightness}
                  masterSaturation={masterSaturation} masterHueShift={masterHueShift} gammaEnabled={gammaEnabled}
                  gammaValue={gammaValue} hidden={projectHidden}
                  bpm={bpm} params={{}} symSettings={symSettings} audioBands={audioBands}
                  motionSmoothing={motionSmoothing}
                  heat={heat}
                />
                <div className="lw-viewport-overlay tl" style={{ fontSize: 'var(--fs-2xs)' }}>
                  <span style={{ background: 'var(--danger)', color: 'var(--on-accent)', padding: '1px 5px', borderRadius: 2 }}>B</span>
                  <select value={compareId} onChange={e => setCompareId(e.target.value)}
                    style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)',
                             fontSize: 'var(--fs-2xs)', padding: '1px 4px', borderRadius: 2, cursor: 'pointer' }}>
                    {PATTERNS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', width: '100%', height: '100%' }}>
              <LEDPreview
                key={previewResetKey}
                patternId={patternId} playing={playing} glow={glow} dotSize={dot} speed={1}
                strips={projectStrips.length > 0 ? projectStrips : undefined}
                viewBox={projectStrips.length > 0 ? projectViewBox : undefined}
                svgText={projectSvgText}
                masterSpeed={masterSpeed}
                masterBrightness={masterBrightness}
                masterSaturation={masterSaturation}
                masterHueShift={masterHueShift}
                gammaEnabled={gammaEnabled}
                gammaValue={gammaValue}
                hidden={projectHidden}
                compiledFn={compiledFn}
                bpm={bpm}
                params={params}
                symSettings={symSettings}
                audioBands={audioBands}
                palette={palette}
                motionSmoothing={motionSmoothing}
                heat={heat}
                onTick={setLiveT}
                onFrame={handleFrame}
                onFps={setLiveFps}
              />
            </div>
          )}
          {!compareMode && (
            <>
              <div className="lw-viewport-overlay tl">
                <div><span className="k">pattern</span> <span className="v">{cur?.name || patternId}</span></div>
                <div><span className="k">view</span> <span className="v">preview · directed glow</span></div>
              </div>
              <div className="lw-viewport-overlay br">
                <div><span className="k">t</span> <span className="v">{liveT.toFixed(2)}s</span></div>
                <div><span className="k">fps</span> <span className="v" style={{ color: liveFps >= 55 ? 'var(--mint)' : liveFps >= 30 ? 'var(--accent)' : 'var(--danger)' }}>{liveFps}</span></div>
              </div>
              <div className="lw-zoom-controls">
                <button onClick={() => setZoom(z => Math.min(3, z * 1.25))}>+</button>
                <div className="lw-zoom-level">{Math.round(zoom * 100)}%</div>
                <button onClick={() => setZoom(z => Math.max(0.25, z / 1.25))}>−</button>
                <button style={{ fontSize: 'var(--fs-2xs)' }} onClick={() => setZoom(1)}>1:1</button>
              </div>
            </>
          )}
        </div>
        <Transport playing={playing} onPlay={() => setPlaying(!playing)} bpm={bpm} setBpm={setBpm} time={liveT} fps={liveFps}/>
        <WledBar/>
      </div>

      {panelCollapsed ? (
        <div className="lw-panel-collapsed-strip">
          <button className="lw-panel-collapse-btn" onClick={() => setPanelCollapsed(false)} title="Expand panel">›</button>
        </div>
      ) : (
        <>
          <div className="lw-resize-handle" onMouseDown={handleDividerMouseDown}/>
          <PatternPanel
            panelMode={panelMode} setPanelMode={setPanelMode}
            patternId={patternId} onSelectPattern={handleSelectPattern}
            params={params} setParams={setParams}
            palette={palette} onPaletteChange={setPalette}
            onCodeChange={handleCodeChange}
            strips={projectStrips}
            hidden={projectHidden}
            audioBands={audioBands}
            onAcceptAiDraft={handleAcceptAiDraft}
            masterSpeed={masterSpeed} setMasterSpeed={setMasterSpeed}
            masterBrightness={masterBrightness} setMasterBrightness={setMasterBrightness}
            masterSaturation={masterSaturation} setMasterSaturation={setMasterSaturation}
            gammaEnabled={gammaEnabled} setGammaEnabled={setGammaEnabled}
            gammaValue={gammaValue} setGammaValue={setGammaValue}
            onCollapse={() => setPanelCollapsed(true)}
          />
        </>
      )}
    </div>
  );
}

// ── Audio bridge: runs inside ProjectProvider, syncs bands to context ────
function AudioBridge({ audio }) {
  const { setAudioBands } = useProject();
  useEffect(() => {
    if (audio.enabled) setAudioBands(audio.bands);
  }, [audio.bands, audio.enabled, setAudioBands]);
  return null;
}

// ── MIDI bridge: maps CC to master controls ───────────────────────────────
function MidiBridgeInner() {
  const { setMasterSpeed, setMasterBrightness, setMasterSaturation } = useProject();
  // Expose CC handler globally so useMidi cbRef can pick it up
  useEffect(() => {
    window.__lwMidiCC = (_ch, cc, val) => {
      if (cc === 1)  setMasterSpeed(val * 4);
      if (cc === 7)  setMasterBrightness(val);
      if (cc === 11) setMasterSaturation(val);
    };
    return () => { delete window.__lwMidiCC; };
  }, [setMasterSpeed, setMasterBrightness, setMasterSaturation]);
  return null;
}

function MidiBridge() {
  return <MidiBridgeInner/>;
}

export default function App() {
  const [screen, setScreen]         = useState(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash.includes('=') ? hash : '');
    return params.get('screen') || 'layout';
  });
  const [panelMode, setPanelMode]   = useState(
    () => localStorage.getItem('lw-panel-mode') || 'graph'
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [kbdOpen,    setKbdOpen]    = useState(false);
  const [cmdOpen,    setCmdOpen]    = useState(false);
  const { tweaks, visible, set }    = useTweaks();
  const audio                       = useAudio();
  const midi                        = useMidi();

  // Persist panel mode
  const handleSetPanelMode = useCallback((m) => {
    setPanelMode(m);
    localStorage.setItem('lw-panel-mode', m);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      // Don't fire when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

      if (e.key === '?') { setKbdOpen(o => !o); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdOpen(o => !o); return; }

      // Screen nav: 1-5 keys
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const screenMap = { '1': 'layout', '2': 'pattern', '3': 'timeline', '4': 'live', '5': 'export' };
        if (screenMap[e.key]) { setScreen(screenMap[e.key]); return; }
      }

      // Audio toggle: A
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey) { audio.toggle(); return; }

      // Compare mode toggle on pattern screen: C
      // (handled inline in PatternScreen via callback)
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <ProjectProvider>
      <AudioBridge audio={audio}/>
      <MidiBridge/>
      <div className="lw-app">
        <TopBar theme={tweaks.theme} onKbdHelp={() => setKbdOpen(true)}
                audio={audio} midi={midi}/>
        <div className="lw-main">
          <LeftRail screen={screen} onScreen={setScreen}/>
          <Suspense fallback={<LoadingPane/>}>
            {screen === 'pattern'  && <PatternScreen panelMode={panelMode} setPanelMode={handleSetPanelMode}/>}
            {screen === 'layout'   && <LayoutScreen/>}
            {screen === 'timeline' && <TimelineScreen onExport={() => setExportOpen(true)}/>}
            {screen === 'live'     && <LiveScreen/>}
            {screen === 'export'   && <ExportScreen/>}
            {screen === 'flash'    && <FlashScreen/>}
            {screen === 'settings' && <SettingsScreen/>}
          </Suspense>
        </div>
        <StatusBar/>
        <TweaksPanel tweaks={tweaks} visible={visible} set={set}/>
        <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)}/>
        <KeyboardHelp open={kbdOpen} onClose={() => setKbdOpen(false)}/>
        <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} navigate={setScreen}/>
        <Suspense fallback={null}>
          {screen === 'devices' && <DevicesPanel onClose={() => setScreen('layout')}/>}
        </Suspense>
      </div>
    </ProjectProvider>
  );
}
