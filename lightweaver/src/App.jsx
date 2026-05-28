import { Suspense, lazy, useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import { usePersistentPanelSize } from './hooks/usePersistentPanelSize.js';
import { PATTERNS } from './data.js';
import { shouldRunBackgroundPatternOutput } from './lib/backgroundOutput.js';
import {
  buildGammaLut,
  compilePattern,
  normalizePalette,
  renderPixelFrame,
} from './lib/frameEngine.js';
import { normalizeWledPhysicalControls } from './lib/wledControlContract.js';
import {
  adjustRotaryBrightness,
  getNextRotaryCyclePatternId,
  makeDefaultRotaryCycleIds,
  normalizeRotaryPatternCycle,
} from './lib/rotaryPatternCycle.js';
import { makePreviewFallbackStrip } from './lib/previewFallbackStrip.js';
import {
  SPEED_SLIDER_MAX,
  SPEED_SLIDER_MIN,
  formatControlSpeed,
  sliderValueToSpeed,
  speedToSliderValue,
} from './lib/controlScale.js';
import { acceptAiDraftAsCustomPattern } from './lib/customPatterns.js';
import { getPatternById } from './lib/patternRegistry.js';

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

function parseViewBoxRect(viewBox) {
  const parts = String(viewBox || '0 0 640 400').trim().split(/[\s,]+/).map(Number);
  return { x: parts[0] || 0, y: parts[1] || 0, w: parts[2] || 640, h: parts[3] || 400 };
}

function stripBoundsViewBox(strips, fallbackViewBox) {
  const pts = [];
  for (const strip of strips || []) {
    for (const px of strip.pixels || []) {
      if (Number.isFinite(px.x) && Number.isFinite(px.y)) pts.push(px);
    }
  }
  if (!pts.length) return fallbackViewBox || '0 0 640 400';

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of pts) {
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }

  const fallback = parseViewBoxRect(fallbackViewBox);
  const w = Math.max(maxX - minX, fallback.w * 0.08, 1);
  const h = Math.max(maxY - minY, fallback.h * 0.08, 1);
  const pad = Math.max(Math.max(w, h) * 0.18, 18);
  return [
    (minX - pad).toFixed(2),
    (minY - pad).toFixed(2),
    (w + pad * 2).toFixed(2),
    (h + pad * 2).toFixed(2),
  ].join(' ');
}

const ModeIcon = {
  cards: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><rect x="2" y="2" width="5" height="5" rx="0.5"/><rect x="9" y="2" width="5" height="5" rx="0.5"/><rect x="2" y="9" width="5" height="5" rx="0.5"/><rect x="9" y="9" width="5" height="5" rx="0.5"/></svg>,
  code:  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><path d="M5 4 L2 8 L5 12 M11 4 L14 8 L11 12 M9 3 L7 13" strokeLinecap="round"/></svg>,
  graph: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><circle cx="3" cy="4" r="1.5"/><circle cx="3" cy="12" r="1.5"/><circle cx="13" cy="8" r="1.5"/><path d="M4.3 4.5 L11.7 7.5 M4.3 11.5 L11.7 8.5"/></svg>,
  sym:   <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5V13.5M2.5 8H13.5M4.1 4.1L11.9 11.9M11.9 4.1L4.1 11.9"/></svg>,
};

function GeometryGuideOverlay({ symSettings, setSymSettings, editing, setEditing }) {
  const overlayRef = useRef(null);
  const dragRef = useRef(null);
  const pendingAxisRef = useRef(null);
  const axisRafRef = useRef(0);
  const guide = symSettings?.guide || {};
  const axis = guide.axis || { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 };
  const enabled = symSettings?.enabled && symSettings?.type === 'guide-mirror';

  const clampAxis = useCallback((nextAxis) => ({
    x1: Math.max(0, Math.min(1, nextAxis.x1)),
    y1: Math.max(0, Math.min(1, nextAxis.y1)),
    x2: Math.max(0, Math.min(1, nextAxis.x2)),
    y2: Math.max(0, Math.min(1, nextAxis.y2)),
  }), []);

  const commitAxis = useCallback((nextAxis) => {
    const clamped = clampAxis(nextAxis);
    setSymSettings(prev => ({
      ...prev,
      enabled: true,
      type: 'guide-mirror',
      guide: {
        ...(prev.guide || {}),
        mode: prev.guide?.mode || 'fold',
        axis: clamped,
      },
    }));
  }, [clampAxis, setSymSettings]);

  const scheduleAxis = useCallback((nextAxis) => {
    pendingAxisRef.current = nextAxis;
    if (axisRafRef.current) return;
    axisRafRef.current = requestAnimationFrame(() => {
      axisRafRef.current = 0;
      if (pendingAxisRef.current) commitAxis(pendingAxisRef.current);
    });
  }, [commitAxis]);

  useEffect(() => () => {
    if (axisRafRef.current) cancelAnimationFrame(axisRafRef.current);
  }, []);

  const pointFromPointer = useCallback((e) => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return null;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return { x, y };
  }, []);

  const beginGuideDrag = useCallback((e, mode) => {
    if (!enabled) return;
    const point = pointFromPointer(e);
    if (!point) return;
    const startAxis = clampAxis(axis);
    const nextAxis = mode === 'draw'
      ? { x1: point.x, y1: point.y, x2: point.x, y2: point.y }
      : startAxis;
    dragRef.current = { pointerId: e.pointerId, mode, point, axis: nextAxis };
    if (mode === 'draw') commitAxis(nextAxis);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setEditing(true);
    e.preventDefault();
    e.stopPropagation();
  }, [axis, clampAxis, commitAxis, enabled, pointFromPointer, setEditing]);

  const handleDrawPointerDown = useCallback((e) => {
    if (!editing) return;
    beginGuideDrag(e, 'draw');
  }, [beginGuideDrag, editing]);

  const handlePointerMove = useCallback((e) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const point = pointFromPointer(e);
    if (!point) return;
    let nextAxis = drag.axis;
    if (drag.mode === 'draw') {
      nextAxis = { ...drag.axis, x2: point.x, y2: point.y };
    } else if (drag.mode === 'start') {
      nextAxis = { ...drag.axis, x1: point.x, y1: point.y };
    } else if (drag.mode === 'end') {
      nextAxis = { ...drag.axis, x2: point.x, y2: point.y };
    } else if (drag.mode === 'move') {
      const dx = point.x - drag.point.x;
      const dy = point.y - drag.point.y;
      nextAxis = {
        x1: drag.axis.x1 + dx,
        y1: drag.axis.y1 + dy,
        x2: drag.axis.x2 + dx,
        y2: drag.axis.y2 + dy,
      };
    }
    scheduleAxis(nextAxis);
    e.preventDefault();
  }, [pointFromPointer, scheduleAxis]);

  const handlePointerUp = useCallback((e) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      if (pendingAxisRef.current) commitAxis(pendingAxisRef.current);
      dragRef.current = null;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      setEditing(false);
    }
  }, [commitAxis, setEditing]);

  if (!enabled) return null;
  const x1 = axis.x1 * 100;
  const y1 = axis.y1 * 100;
  const x2 = axis.x2 * 100;
  const y2 = axis.y2 * 100;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.max(0.001, Math.hypot(dx, dy));
  const nx = (-dy / len) * 7;
  const ny = (dx / len) * 7;
  const flowPoints = [0.28, 0.5, 0.72].map((p, i) => ({
    x: x1 + dx * p,
    y: y1 + dy * p,
    a: Math.atan2(dy, dx) * 180 / Math.PI,
    i,
  }));
  const modeLabel = {
    fold: 'flow from guide',
    reflect: 'mirror one side',
    split: 'split color field',
  }[guide.mode || 'fold'] || 'motion guide';
  return (
    <div
      ref={overlayRef}
      className={`lw-geometry-guide-overlay ${editing ? 'is-editing' : ''}`}
      onPointerDown={handleDrawPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <svg className="lw-geometry-guide-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line className="lw-geometry-guide-band band-3" x1={x1 + nx * 3} y1={y1 + ny * 3} x2={x2 + nx * 3} y2={y2 + ny * 3} vectorEffect="non-scaling-stroke" />
        <line className="lw-geometry-guide-band band-2" x1={x1 + nx * 2} y1={y1 + ny * 2} x2={x2 + nx * 2} y2={y2 + ny * 2} vectorEffect="non-scaling-stroke" />
        <line className="lw-geometry-guide-band band-1" x1={x1 + nx} y1={y1 + ny} x2={x2 + nx} y2={y2 + ny} vectorEffect="non-scaling-stroke" />
        <line className="lw-geometry-guide-band band-1" x1={x1 - nx} y1={y1 - ny} x2={x2 - nx} y2={y2 - ny} vectorEffect="non-scaling-stroke" />
        <line className="lw-geometry-guide-band band-2" x1={x1 - nx * 2} y1={y1 - ny * 2} x2={x2 - nx * 2} y2={y2 - ny * 2} vectorEffect="non-scaling-stroke" />
        <line className="lw-geometry-guide-band band-3" x1={x1 - nx * 3} y1={y1 - ny * 3} x2={x2 - nx * 3} y2={y2 - ny * 3} vectorEffect="non-scaling-stroke" />
        <line
          className="lw-geometry-guide-ghost"
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          vectorEffect="non-scaling-stroke"
          onPointerDown={e => beginGuideDrag(e, 'move')}
        />
        <line
          className="lw-geometry-guide-line"
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          vectorEffect="non-scaling-stroke"
          onPointerDown={e => beginGuideDrag(e, 'move')}
        />
        {flowPoints.map(point => (
          <g
            key={point.i}
            className="lw-geometry-guide-arrow"
            transform={`translate(${point.x} ${point.y}) rotate(${point.a})`}
          >
            <path d="M -2.8 -2 L 2.8 0 L -2.8 2 Z" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        <circle
          className="lw-geometry-guide-handle"
          cx={x1}
          cy={y1}
          r="1.8"
          onPointerDown={e => beginGuideDrag(e, 'start')}
        />
        <circle
          className="lw-geometry-guide-handle"
          cx={x2}
          cy={y2}
          r="1.8"
          onPointerDown={e => beginGuideDrag(e, 'end')}
        />
      </svg>
      <div className="lw-geometry-guide-label">
        <span>{editing ? 'draw motion axis' : modeLabel}</span>
        <button onClick={() => setEditing(true)}>Redraw</button>
      </div>
    </div>
  );
}

function PatternPanel({
  panelMode, setPanelMode,
  patternId, onSelectPattern,
  params, setParams,
  patternParams, setPatternParams,
  palette, onPaletteChange,
  strips, onAssignStripPattern,
  onCodeChange,
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
  const safePanelMode = ['cards', 'graph', 'code', 'sym'].includes(panelMode) ? panelMode : 'cards';

  return (
    <div className="lw-panel">
      <div className="lw-panel-mode-switch">
        <button className="lw-panel-collapse-btn" onClick={onCollapse} title="Collapse panel">‹</button>
        {[['cards','Effects',ModeIcon.cards],['graph','Tune',ModeIcon.graph],['sym','Geometry',ModeIcon.sym],['code','Code',ModeIcon.code]].map(([v,l,ic]) => (
          <button key={v} className={`lw-panel-mode-btn ${safePanelMode === v ? 'active' : ''}`} onClick={() => setPanelMode(v)}>
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
      <div className={`lw-panel-body ${safePanelMode === 'cards' ? 'lw-panel-body--effects' : ''}`}>
        {safePanelMode === 'cards' && (
          <CardsMode patternId={patternId} onSelectPattern={onSelectPattern}
                     params={params} onParamChange={(k, v) => setParams({ ...params, [k]: v })}
                     patternParams={patternParams}
                     onPatternParamsChange={(targetPatternId, nextParams) => setPatternParams(prev => ({ ...prev, [targetPatternId]: nextParams }))}
                     palette={palette} onPaletteChange={onPaletteChange}
                     strips={strips}
                     onAssignStripPattern={onAssignStripPattern}/>
        )}
        {safePanelMode === 'code'  && (
          <CodeMode
            patternId={patternId}
            onCodeChange={onCodeChange}
            params={params}
            onParamChange={(k, v) => setParams({ ...params, [k]: v })}
          />
        )}
        {safePanelMode === 'graph' && (
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
        {safePanelMode === 'sym'   && <SymmetryMode/>}
        {safePanelMode !== 'graph' && (
        <div className={`lw-panel-master-block ${safePanelMode === 'cards' ? 'lw-panel-master-block--effects' : ''}`}>
          <div className="lw-sec-header">
            <span>Master</span>
            <span className="meta">applies globally</span>
          </div>
          <div className="lw-master">
            <span className="lbl">Speed</span>
            <input aria-label="Master speed" type="range" min={SPEED_SLIDER_MIN} max={SPEED_SLIDER_MAX} step="1" value={speedToSliderValue(masterSpeed)}
                   onChange={e => setMasterSpeed(sliderValueToSpeed(e.target.value))}/>
            <span className="v">{formatControlSpeed(masterSpeed)}</span>

            <span className="lbl">Bright</span>
            <input aria-label="Master brightness" type="range" min="0" max="1" step="0.01" value={masterBrightness}
                   onChange={e => setMasterBrightness(+e.target.value)}/>
            <span className="v">{Math.round(masterBrightness * 100)}%</span>

            <span className="lbl">Sat</span>
            <input aria-label="Master saturation" type="range" min="0" max="1" step="0.01" value={masterSaturation}
                   onChange={e => setMasterSaturation(+e.target.value)}/>
            <span className="v">{Math.round(masterSaturation * 100)}%</span>

            <span className="lbl">Gamma</span>
            <input aria-label="Enable gamma correction" type="checkbox" checked={gammaEnabled} onChange={e => setGammaEnabled(e.target.checked)}/>
            <input aria-label="Gamma value" type="range" min="1.0" max="3.0" step="0.1" value={gammaValue}
                   onChange={e => setGammaValue(+e.target.value)} disabled={!gammaEnabled}/>
            <span className="v">{gammaValue.toFixed(1)}</span>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

function PatternScreen({ panelMode, setPanelMode }) {
  const [panelWidth, , beginPanelResize] = usePersistentPanelSize('lw-panel-width', {
    defaultValue: 520,
    min: 420,
    max: 760,
  });
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [compareMode,    setCompareMode]    = useState(false);
  const [compareId,      setCompareId]      = useState('aurora');

  const {
    strips: projectStrips, viewBox: projectViewBox, svgText: projectSvgText, hidden: projectHidden,
    setStrips: setProjectStrips,
    activePatternId: patternId, setActivePatternId: setPatternId,
    palette, setPalette,
    masterSpeed, setMasterSpeed,
    masterBrightness, setMasterBrightness,
    masterSaturation, setMasterSaturation,
    masterHueShift,
    gammaEnabled, setGammaEnabled,
    gammaValue, setGammaValue,
    patternParams, setPatternParams,
    bpm, setBpm,
    motionSmoothing,
    pushOutputFrame,
    symSettings, setSymSettings,
    audioBands,
    physicalControls,
    showClips,
  } = useProject();

  // Read URL hash for initial pattern on mount
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash.includes('=') ? hash : '');
    const pid = params.get('pattern');
    if (pid && PATTERNS.find(p => p.id === pid)) setPatternId(pid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [playing, setPlaying]             = useState(true);
  const [glow, setGlow]                   = useState(0.45);
  const [dot, setDot]                     = useState(1.0);
  const [heat, setHeat]                   = useState(false);
  const [compiledFn, setCompiledFn]       = useState(null);
  const [zoom, setZoom]                   = useState(1.0);
  const [previewPan, setPreviewPan]       = useState({ x: 0, y: 0 });
  const [isPreviewPanning, setIsPreviewPanning] = useState(false);
  const [isSpacePan, setIsSpacePan]       = useState(false);
  const [fitLeds, setFitLeds]             = useState(true);
  const [editingGuide, setEditingGuide]   = useState(false);
  const [liveT, setLiveT]                 = useState(0);
  const [liveFps, setLiveFps]             = useState(0);
  const [previewResetKey, setPreviewResetKey] = useState(0);
  const previewViewportRef = useRef(null);
  const previewPanRef = useRef(previewPan);
  const previewDragRef = useRef(null);
  const spacePanRef = useRef(false);

  useEffect(() => { previewPanRef.current = previewPan; }, [previewPan]);

  const params    = patternParams[patternId] || {};
  const setParams = useCallback((newParams) => {
    setPatternParams(prev => ({ ...prev, [patternId]: newParams }));
  }, [patternId, setPatternParams]);

  const handleFrame = useCallback((pixels) => { pushOutputFrame(pixels); }, [pushOutputFrame]);

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

  const handleAssignStripPattern = useCallback((stripId, nextPatternId) => {
    setProjectStrips(prev => prev.map(strip => (
      strip.id === stripId ? { ...strip, patternId: nextPatternId || null } : strip
    )));
  }, [setProjectStrips]);

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

  const fallbackPreviewStrip = useMemo(
    () => makePreviewFallbackStrip(projectViewBox, { pixelCount: 30 }),
    [projectViewBox],
  );
  const previewStrips = projectStrips.length > 0 ? projectStrips : [fallbackPreviewStrip];
  const previewHidden = projectStrips.length > 0 ? projectHidden : {};
  const visibleProjectStrips = useMemo(
    () => previewStrips.filter(strip => !previewHidden[strip.id]),
    [previewStrips, previewHidden],
  );

  const fittedPatternViewBox = useMemo(
    () => stripBoundsViewBox(visibleProjectStrips, projectViewBox),
    [visibleProjectStrips, projectViewBox],
  );
  const previewViewBox = fitLeds ? fittedPatternViewBox : projectViewBox;

  const resetPatternView = useCallback(() => {
    setZoom(1);
    setPreviewPan({ x: 0, y: 0 });
  }, []);

  const handlePreviewPointerDown = useCallback((e) => {
    if (compareMode) return;
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target?.closest?.('button,input,select,.lw-zoom-controls')) return;
    if (e.button === 0 && !spacePanRef.current) return;
    previewDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      pan: previewPanRef.current,
      target: e.currentTarget,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setIsPreviewPanning(true);
    e.preventDefault();
  }, [compareMode]);

  const handlePreviewPointerMove = useCallback((e) => {
    const drag = previewDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setPreviewPan({
      x: drag.pan.x + e.clientX - drag.startX,
      y: drag.pan.y + e.clientY - drag.startY,
    });
  }, []);

  const finishPreviewPan = useCallback((e) => {
    const drag = previewDragRef.current;
    const target = e?.currentTarget || drag?.target;
    if (drag && target?.releasePointerCapture) {
      try { target.releasePointerCapture(drag.pointerId); } catch {}
    }
    previewDragRef.current = null;
    setIsPreviewPanning(false);
  }, []);

  const handlePreviewWheel = useCallback((e) => {
    if (compareMode) return;
    e.preventDefault();
    const rect = previewViewportRef.current?.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextZoom = Math.max(0.25, Math.min(6, zoom * factor));
    if (rect && nextZoom !== zoom) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const cursorX = e.clientX - cx;
      const cursorY = e.clientY - cy;
      const pan = previewPanRef.current;
      const ratio = 1 - nextZoom / zoom;
      const nextPan = {
        x: pan.x + (cursorX - pan.x) * ratio,
        y: pan.y + (cursorY - pan.y) * ratio,
      };
      previewPanRef.current = nextPan;
      setPreviewPan(nextPan);
    }
    setZoom(nextZoom);
  }, [compareMode, zoom]);

  useEffect(() => {
    const el = previewViewportRef.current;
    if (!el) return;
    el.addEventListener('wheel', handlePreviewWheel, { passive: false });
    return () => el.removeEventListener('wheel', handlePreviewWheel);
  }, [handlePreviewWheel]);

  useEffect(() => {
    const isEditableTarget = (target) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;
    const onKeyDown = (e) => {
      if (e.code !== 'Space' || isEditableTarget(e.target)) return;
      spacePanRef.current = true;
      setIsSpacePan(true);
      e.preventDefault();
    };
    const onKeyUp = (e) => {
      if (e.code !== 'Space') return;
      spacePanRef.current = false;
      setIsSpacePan(false);
      finishPreviewPan();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      spacePanRef.current = false;
    };
  }, [finishPreviewPan]);

  const cur = getPatternById(patternId) || PATTERNS.find(p => p.id === patternId);
  const gridCols = panelCollapsed ? '1fr 32px' : `1fr 5px ${panelWidth}px`;
  const knownPatternIds = useMemo(() => new Set(PATTERNS.map(pattern => pattern.id)), []);
  const rotaryControls = useMemo(() => normalizeWledPhysicalControls(physicalControls), [physicalControls]);
  const previewCycleIds = useMemo(() => {
    const stored = normalizeRotaryPatternCycle(rotaryControls.encoder.patternCycleIds, knownPatternIds);
    return stored.length ? stored : makeDefaultRotaryCycleIds({
      activePatternId: patternId,
      showClips: showClips || [],
      knownPatternIds,
    });
  }, [knownPatternIds, patternId, rotaryControls.encoder.patternCycleIds, showClips]);
  const handlePreviewRotaryTurn = useCallback((turn) => {
    setMasterBrightness(current => adjustRotaryBrightness({
      currentBrightness: current,
      rotateDirection: rotaryControls.encoder.rotateDirection,
      turn,
      step: Math.max(0.01, (rotaryControls.encoder.brightnessStep || 8) / 255),
    }));
  }, [rotaryControls.encoder.brightnessStep, rotaryControls.encoder.rotateDirection, setMasterBrightness]);
  const handlePreviewRotaryPush = useCallback(() => {
    const nextPatternId = getNextRotaryCyclePatternId(previewCycleIds, patternId, knownPatternIds);
    if (nextPatternId) handleSelectPattern(nextPatternId);
  }, [handleSelectPattern, knownPatternIds, patternId, previewCycleIds]);

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
          onResetPreview={() => { resetPatternView(); setPreviewResetKey(k => k + 1); }}
        >
          <button
            className={`btn btn-ghost ${fitLeds ? 'active' : ''}`}
            style={{ fontSize: 'var(--fs-xs)' }}
            onClick={() => { setFitLeds(v => !v); resetPatternView(); }}
            title="Fit the preview to the LED bounds instead of the full SVG artboard">
            Fit LEDs
          </button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 'var(--fs-xs)' }}
            onClick={resetPatternView}
            title="Center the pattern preview">
            Center
          </button>
          <button
            className={`btn btn-ghost ${compareMode ? 'active' : ''}`}
            style={{ fontSize: 'var(--fs-xs)' }}
            onClick={() => setCompareMode(m => !m)}
            title="A/B compare mode">
            A|B
          </button>
          <button
            className={`btn btn-ghost ${symSettings.enabled && symSettings.type === 'guide-mirror' ? 'active' : ''}`}
            style={{ fontSize: 'var(--fs-xs)' }}
            onClick={() => {
              setSymSettings(prev => ({
                ...prev,
                enabled: true,
                type: 'guide-mirror',
                guide: prev.guide || { mode: 'fold', axis: { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 } },
              }));
              setEditingGuide(true);
              setPanelMode('sym');
            }}
            title="Draw a motion guide that patterns flow from">
            Motion Guide
          </button>
        </CanvasToolbar>
        <div className="lw-viewport" style={{ overflow: 'hidden' }}>
          {projectStrips.length === 0 && (
            <div className="lw-pattern-empty">
              <div className="title">No Layout strips</div>
              <div className="meta">Using a 30 LED preview strip until the artwork layout is loaded.</div>
            </div>
          )}
          {compareMode ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', width: '100%', height: '100%' }}>
              <div style={{ position: 'relative', overflow: 'hidden', borderRight: '1px solid var(--border)' }}>
                <LEDPreview
                  key={`a-${previewResetKey}`}
                  patternId={patternId} playing={playing} glow={glow} dotSize={dot} speed={1}
                  strips={previewStrips}
                  viewBox={previewViewBox}
                  svgText={projectSvgText}
                  masterSpeed={masterSpeed} masterBrightness={masterBrightness}
                  masterSaturation={masterSaturation} masterHueShift={masterHueShift} gammaEnabled={gammaEnabled}
                  gammaValue={gammaValue} hidden={projectHidden} compiledFn={compiledFn}
                  bpm={bpm} params={params} symSettings={symSettings} audioBands={audioBands}
                  patternParamsById={patternParams}
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
                  strips={previewStrips}
                  viewBox={previewViewBox}
                  svgText={projectSvgText}
                  masterSpeed={masterSpeed} masterBrightness={masterBrightness}
                  masterSaturation={masterSaturation} masterHueShift={masterHueShift} gammaEnabled={gammaEnabled}
                  gammaValue={gammaValue} hidden={projectHidden}
                  bpm={bpm} params={{}} symSettings={symSettings} audioBands={audioBands}
                  patternParamsById={patternParams}
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
            <div
              ref={previewViewportRef}
              className={`lw-pattern-pan-stage ${isSpacePan ? 'is-space-panning' : ''} ${isPreviewPanning ? 'is-panning' : ''}`}
              onPointerDown={handlePreviewPointerDown}
              onPointerMove={handlePreviewPointerMove}
              onPointerUp={finishPreviewPan}
              onPointerCancel={finishPreviewPan}
              onDoubleClick={resetPatternView}
            >
              <div
                className="lw-pattern-pan-content"
                style={{
                  transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${zoom})`,
                }}
              >
                <LEDPreview
                  key={previewResetKey}
                  patternId={patternId} playing={playing} glow={glow} dotSize={dot} speed={1}
                  strips={previewStrips}
                  viewBox={previewViewBox}
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
                  patternParamsById={patternParams}
                  symSettings={symSettings}
                  audioBands={audioBands}
                  palette={palette}
                  motionSmoothing={motionSmoothing}
                  heat={heat}
                  onTick={setLiveT}
                  onFrame={handleFrame}
                  onFps={setLiveFps}
                />
                <GeometryGuideOverlay
                  symSettings={symSettings}
                  setSymSettings={setSymSettings}
                  editing={editingGuide}
                  setEditing={setEditingGuide}
                />
              </div>
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
                <button onClick={() => setZoom(z => Math.min(3, z * 1.25))} title="Zoom in" aria-label="Zoom in">+</button>
                <div className="lw-zoom-level">{Math.round(zoom * 100)}%</div>
                <button onClick={() => setZoom(z => Math.max(0.25, z / 1.25))} title="Zoom out" aria-label="Zoom out">−</button>
                <button style={{ fontSize: 'var(--fs-2xs)' }} onClick={resetPatternView} title="Fit and center preview">Fit</button>
              </div>
              <PreviewRotaryKnob
                brightness={masterBrightness}
                cycleCount={previewCycleIds.length}
                rotateDirection={rotaryControls.encoder.rotateDirection}
                onTurn={handlePreviewRotaryTurn}
                onPress={handlePreviewRotaryPush}
              />
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
          <div
            className="lw-resize-handle lw-resize-handle--vertical"
            data-resize-key="lw-panel-width"
            onMouseDown={e => beginPanelResize(e, { axis: 'x', invert: true })}
          />
          <PatternPanel
            panelMode={panelMode} setPanelMode={setPanelMode}
            patternId={patternId} onSelectPattern={handleSelectPattern}
            params={params} setParams={setParams}
            patternParams={patternParams} setPatternParams={setPatternParams}
            palette={palette} onPaletteChange={setPalette}
            strips={projectStrips}
            onAssignStripPattern={handleAssignStripPattern}
            onCodeChange={handleCodeChange}
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

function PreviewRotaryKnob({ brightness, cycleCount, rotateDirection, onTurn, onPress }) {
  const knobRef = useRef(null);
  const dragRef = useRef(null);
  const clockwiseLabel = rotateDirection === 'clockwise-dimmer' ? 'dims' : 'brightens';

  const angleFromPointer = useCallback((event) => {
    const rect = knobRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return Math.atan2(
      event.clientY - (rect.top + rect.height / 2),
      event.clientX - (rect.left + rect.width / 2),
    );
  }, []);

  const beginTurn = useCallback((event) => {
    const angle = angleFromPointer(event);
    if (angle == null) return;
    dragRef.current = {
      pointerId: event.pointerId,
      angle,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, [angleFromPointer]);

  const moveTurn = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextAngle = angleFromPointer(event);
    if (nextAngle == null) return;
    let delta = nextAngle - drag.angle;
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    if (Math.abs(delta) > 0.18) {
      onTurn(delta > 0 ? 'clockwise' : 'counterclockwise');
      drag.angle = nextAngle;
      drag.moved = true;
    }
    event.preventDefault();
  }, [angleFromPointer, onTurn]);

  const endTurn = useCallback((event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleWheel = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    onTurn(event.deltaY < 0 ? 'clockwise' : 'counterclockwise');
  }, [onTurn]);

  const handlePush = useCallback((event) => {
    if (dragRef.current?.moved) return;
    event.preventDefault();
    event.stopPropagation();
    onPress();
  }, [onPress]);

  return (
    <div className="lw-preview-rotary" aria-label="Preview rotary control">
      <button
        ref={knobRef}
        className="lw-preview-rotary-dial"
        type="button"
        aria-label="Turn or push preview rotary button"
        title="Drag or scroll to turn. Click to push through the pattern cycle."
        onPointerDown={beginTurn}
        onPointerMove={moveTurn}
        onPointerUp={endTurn}
        onPointerCancel={endTurn}
        onClick={handlePush}
        onWheel={handleWheel}
      >
        <span className="lw-preview-rotary-indicator" style={{ transform: `rotate(${Math.round(brightness * 270 - 135)}deg)` }} />
        <span className="lw-preview-rotary-core">Push</span>
      </button>
      <div className="lw-preview-rotary-meta">
        <span>{Math.round(brightness * 100)}%</span>
        <span>cw {clockwiseLabel}</span>
        <span>{cycleCount || 0} looks</span>
      </div>
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

function BackgroundPatternOutput({ screen }) {
  const {
    strips,
    hidden,
    activePatternId,
    palette,
    masterSpeed,
    masterBrightness,
    masterSaturation,
    masterHueShift,
    gammaEnabled,
    gammaValue,
    patternParams,
    bpm,
    symSettings,
    audioBands,
    pushOutputFrame,
  } = useProject();
  const rafRef = useRef(0);
  const tRef = useRef(0);
  const lastPushRef = useRef(0);
  const shouldRun = shouldRunBackgroundPatternOutput(screen);

  const outputStrips = useMemo(() => {
    return (strips || [])
      .filter(strip => strip && !hidden?.[strip.id] && Array.isArray(strip.pixels) && strip.pixels.length > 0)
      .map(strip => ({
        id: strip.id,
        patternId: strip.patternId || null,
        speed: strip.speed,
        brightness: strip.brightness,
        hueShift: strip.hueShift,
        pts: strip.pixels.map((pixel, index) => ({
          x: pixel.x,
          y: pixel.y,
          p: strip.pixels.length > 1 ? index / (strip.pixels.length - 1) : 0.5,
          i: index,
        })),
      }));
  }, [hidden, strips]);

  const perStripFns = useMemo(() => {
    const next = new Map();
    for (const strip of outputStrips) {
      if (strip.patternId && !next.has(strip.patternId)) {
        const fn = compilePattern(strip.patternId);
        if (fn) next.set(strip.patternId, fn);
      }
    }
    return next;
  }, [outputStrips]);

  const paletteNorm = useMemo(() => normalizePalette(palette), [palette]);
  const gammaLUT = useMemo(() => buildGammaLut(gammaEnabled, gammaValue), [gammaEnabled, gammaValue]);

  useEffect(() => {
    if (!shouldRun || !outputStrips.length) return undefined;
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      tRef.current += dt;

      if (now - lastPushRef.current >= 33) {
        const frame = renderPixelFrame({
          t: tRef.current,
          strips: outputStrips,
          patternId: activePatternId,
          activeFn: compilePattern(activePatternId),
          params: patternParams?.[activePatternId] || {},
          patternParamsById: patternParams,
          paletteNorm,
          bpm,
          masterSpeed,
          masterBrightness,
          masterSaturation,
          masterHueShift,
          gammaLUT,
          symSettings,
          audioBands,
          perStripFns,
        });
        pushOutputFrame(frame.pixels);
        lastPushRef.current = now;
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [
    activePatternId,
    audioBands,
    bpm,
    gammaLUT,
    masterBrightness,
    masterHueShift,
    masterSaturation,
    masterSpeed,
    outputStrips,
    paletteNorm,
    patternParams,
    perStripFns,
    pushOutputFrame,
    shouldRun,
    symSettings,
  ]);

  return null;
}

export default function App() {
  const [screen, setScreen]         = useState(() => {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash.includes('=') ? hash : '');
    return params.get('screen') || 'layout';
  });
  const [panelMode, setPanelMode]   = useState(
    () => localStorage.getItem('lw-panel-mode') || 'cards'
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [kbdOpen,    setKbdOpen]    = useState(false);
  const [cmdOpen,    setCmdOpen]    = useState(false);
  const { tweaks, visible, set }    = useTweaks();
  const audio                       = useAudio();
  const midi                        = useMidi();

  const navigate = useCallback((nextScreen) => {
    setScreen(nextScreen);
    setExportOpen(false);
    setKbdOpen(false);
    setCmdOpen(false);
  }, []);

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
        if (screenMap[e.key]) { navigate(screenMap[e.key]); return; }
      }

      // Audio toggle: A
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey) { audio.toggle(); return; }

      // Compare mode toggle on pattern screen: C
      // (handled inline in PatternScreen via callback)
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate, audio]);

  return (
    <ProjectProvider>
      <AudioBridge audio={audio}/>
      <MidiBridge/>
      <BackgroundPatternOutput screen={screen}/>
      <div className="lw-app">
        <TopBar theme={tweaks.theme} onKbdHelp={() => setKbdOpen(true)}
                audio={audio} midi={midi}/>
        <div className="lw-main">
          <LeftRail screen={screen} onScreen={navigate}/>
          <Suspense fallback={<LoadingPane/>}>
            {screen === 'pattern'  && <PatternScreen panelMode={panelMode} setPanelMode={handleSetPanelMode}/>}
            {screen === 'layout'   && <LayoutScreen/>}
            {screen === 'timeline' && <TimelineScreen onExport={() => setExportOpen(true)}/>}
            {screen === 'live'     && <LiveScreen onOpenShow={() => navigate('timeline')}/>}
            {screen === 'export'   && <ExportScreen/>}
            {screen === 'flash'    && <FlashScreen/>}
            {screen === 'settings' && <SettingsScreen/>}
          </Suspense>
        </div>
        <StatusBar/>
        <TweaksPanel tweaks={tweaks} visible={visible} set={set}/>
        <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)}/>
        <KeyboardHelp open={kbdOpen} onClose={() => setKbdOpen(false)}/>
        <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} navigate={navigate}/>
        <Suspense fallback={null}>
          {screen === 'devices' && <DevicesPanel onClose={() => navigate('layout')}/>}
        </Suspense>
      </div>
    </ProjectProvider>
  );
}
