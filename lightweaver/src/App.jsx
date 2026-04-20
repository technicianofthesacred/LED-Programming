import { useState, useEffect, useCallback, useMemo } from 'react';
import { ProjectProvider, useProject } from './state/ProjectContext.jsx';
import { TopBar, LeftRail, CanvasToolbar, Transport, StatusBar } from './components/Chrome.jsx';
import { LEDPreview } from './components/Preview.jsx';
import { CardsMode, CodeMode, GraphMode } from './components/PatternModes.jsx';
import { SymmetryMode } from './components/SymmetryMode.jsx';
import { ExportScreen, FlashScreen } from './components/OtherScreens.jsx';
import { LayoutScreen } from './components/LayoutScreen.jsx';
import { TimelineScreen } from './components/TimelineScreen.jsx';
import { ExportDialog } from './components/ExportDialog.jsx';
import { useTweaks, TweaksPanel } from './components/Tweaks.jsx';
import { PATTERNS, PALETTE_DEFAULT } from './data.js';

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
  palette,
  onCodeChange,
  masterSpeed, setMasterSpeed,
  masterBrightness, setMasterBrightness,
  masterSaturation, setMasterSaturation,
  gammaEnabled, setGammaEnabled,
  gammaValue, setGammaValue,
}) {
  return (
    <div className="lw-panel">
      <div className="lw-panel-mode-switch">
        {[['cards','Cards',ModeIcon.cards],['code','Code',ModeIcon.code],['graph','Graph',ModeIcon.graph],['sym','Symmetry',ModeIcon.sym]].map(([v,l,ic]) => (
          <button key={v} className={`lw-panel-mode-btn ${panelMode === v ? 'active' : ''}`} onClick={() => setPanelMode(v)}>
            {ic}<span>{l}</span>
          </button>
        ))}
      </div>
      <div className="lw-panel-body">
        {panelMode === 'cards' && (
          <CardsMode patternId={patternId} onSelectPattern={onSelectPattern}
                     params={params} onParamChange={(k, v) => setParams({ ...params, [k]: v })}
                     palette={palette}/>
        )}
        {panelMode === 'code'  && <CodeMode patternId={patternId} onCodeChange={onCodeChange}/>}
        {panelMode === 'graph' && <GraphMode/>}
        {panelMode === 'sym'   && <SymmetryMode/>}
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

          <span className="lbl">Gamma</span>
          <input type="checkbox" checked={gammaEnabled} onChange={e => setGammaEnabled(e.target.checked)}/>
          <input type="range" min="1.0" max="3.0" step="0.1" value={gammaValue}
                 onChange={e => setGammaValue(+e.target.value)}
                 disabled={!gammaEnabled}/>
          <span className="v">{gammaValue.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
}

function PatternScreen({ panelMode, setPanelMode, panelWide }) {
  const { strips: projectStrips, viewBox: projectViewBox, svgText: projectSvgText, hidden: projectHidden } = useProject();
  const [patternId, setPatternId]           = useState('aurora');
  const [playing, setPlaying]               = useState(true);
  const [bpm, setBpm]                       = useState(120);
  const [glow, setGlow]                     = useState(1.2);
  const [dot, setDot]                       = useState(2.5);
  const [heat, setHeat]                     = useState(false);
  const [params, setParams]                 = useState({});
  const [masterSpeed,      setMasterSpeed]      = useState(1.0);
  const [masterBrightness, setMasterBrightness] = useState(1.0);
  const [masterSaturation, setMasterSaturation] = useState(1.0);
  const [gammaEnabled,     setGammaEnabled]     = useState(false);
  const [gammaValue,       setGammaValue]       = useState(2.2);
  const [compiledFn,       setCompiledFn]       = useState(null);
  const [zoom,             setZoom]             = useState(1.0);
  const [liveT,            setLiveT]            = useState(0);
  const [projectName]                       = useState('Untitled Project');

  const handleCodeChange = useCallback(({ fn, error }) => {
    setCompiledFn(error ? null : () => fn);
  }, []);

  // Selecting a library card clears any custom compiledFn so the library version plays
  const handleSelectPattern = useCallback((id) => {
    setPatternId(id);
    setCompiledFn(null);
  }, []);

  const cur = PATTERNS.find(p => p.id === patternId);

  return (
    <div className={`lw-pattern-screen ${panelWide ? 'panel-wide' : ''}`}>
      <div className="lw-canvas-col">
        <CanvasToolbar glow={glow} setGlow={setGlow} dot={dot} setDot={setDot} heat={heat} setHeat={setHeat}/>
        <div className="lw-viewport" style={{ overflow: 'hidden' }}>
          <div style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', width: '100%', height: '100%' }}>
            <LEDPreview
              patternId={patternId} playing={playing} glow={glow} dotSize={dot} speed={1}
              strips={projectStrips.length > 0 ? projectStrips : undefined}
              viewBox={projectStrips.length > 0 ? projectViewBox : undefined}
              svgText={projectSvgText}
              masterSpeed={masterSpeed}
              masterBrightness={masterBrightness}
              masterSaturation={masterSaturation}
              gammaEnabled={gammaEnabled}
              gammaValue={gammaValue}
              hidden={projectHidden}
              compiledFn={compiledFn}
              bpm={bpm}
              params={params}
              onTick={t => setLiveT(t)}
            />
          </div>
          <div className="lw-viewport-overlay tl">
            <div><span className="k">project</span> <span className="v">{projectName}</span></div>
            <div><span className="k">view</span> <span className="v">preview · directed glow</span></div>
          </div>
          <div className="lw-viewport-overlay br">
            <div><span className="k">running</span> <span className="v">{cur?.name}</span></div>
            <div><span className="k">t</span> <span className="v">{liveT.toFixed(2)}s</span></div>
          </div>
          <div className="lw-zoom-controls">
            <button onClick={() => setZoom(z => Math.min(3, z * 1.25))}>+</button>
            <div className="lw-zoom-level">{Math.round(zoom * 100)}%</div>
            <button onClick={() => setZoom(z => Math.max(0.25, z / 1.25))}>−</button>
            <button style={{ fontSize: 9 }} onClick={() => setZoom(1)}>1:1</button>
          </div>
        </div>
        <Transport playing={playing} onPlay={() => setPlaying(!playing)} bpm={bpm} setBpm={setBpm} time={liveT}/>
      </div>
      <PatternPanel
        panelMode={panelMode} setPanelMode={setPanelMode}
        patternId={patternId} onSelectPattern={handleSelectPattern}
        params={params} setParams={setParams}
        palette={PALETTE_DEFAULT}
        onCodeChange={handleCodeChange}
        masterSpeed={masterSpeed} setMasterSpeed={setMasterSpeed}
        masterBrightness={masterBrightness} setMasterBrightness={setMasterBrightness}
        masterSaturation={masterSaturation} setMasterSaturation={setMasterSaturation}
        gammaEnabled={gammaEnabled} setGammaEnabled={setGammaEnabled}
        gammaValue={gammaValue} setGammaValue={setGammaValue}
      />
    </div>
  );
}

export default function App() {
  const [screen, setScreen]       = useState('layout');
  const [panelMode, setPanelMode] = useState('cards');
  const [exportOpen, setExportOpen] = useState(false);
  const { tweaks, visible, set }  = useTweaks();

  return (
    <ProjectProvider>
    <div className="lw-app">
      <TopBar theme={tweaks.theme}/>
      <div className="lw-main">
        <LeftRail screen={screen} onScreen={setScreen}/>
        {screen === 'pattern'  && <PatternScreen panelMode={panelMode} setPanelMode={setPanelMode} panelWide={tweaks.panelWidth === 'wide'}/>}
        {screen === 'layout'   && <LayoutScreen/>}
        {screen === 'timeline' && <TimelineScreen onExport={() => setExportOpen(true)}/>}
        {screen === 'export'   && <ExportScreen/>}
        {screen === 'flash'    && <FlashScreen/>}
      </div>
      <StatusBar/>
      <TweaksPanel tweaks={tweaks} visible={visible} set={set}/>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)}/>
    </div>
    </ProjectProvider>
  );
}
