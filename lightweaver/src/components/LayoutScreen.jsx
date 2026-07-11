import { TbIcon } from './layout/shared/InspectorPrimitives.jsx';
import { ModeSwitch } from './layout/shared/ModeSwitch.jsx';
import {
  DENSITY_OPTIONS,
  GLOW_MODES,
  parsedVb,
} from '../lib/layoutGeometry.js';
import { mainChain, normalizePatchBoard } from '../lib/patchBoard.js';
import { LayoutCanvas } from './layout/canvas/LayoutCanvas.jsx';
import { DrawModePanel } from './layout/modes/DrawModePanel.jsx';
import { SizeModePanel } from './layout/modes/SizeModePanel.jsx';
import { useLayoutState } from './layout/hooks/useLayoutState.js';

// eslint-disable-next-line no-unused-vars
const SCALE_BASE_PX_PER_MM = 3.7795;            // 96 DPI, the current default
// eslint-disable-next-line no-unused-vars
const SCALE_OPTIONS = [
  { label: 'S',  mult: 0.5 },
  { label: 'M',  mult: 1 },
  { label: 'L',  mult: 2 },
  { label: 'XL', mult: 4 },
];
// eslint-disable-next-line no-unused-vars
const LED_COUNT_PRESETS = [30, 43, 60, 100, 150, 300, 600, 1000, 1500, 3000];

// ── Main component ─────────────────────────────────────────────────────────
// All state, handlers, derived memos and effects live in useLayoutState() and
// its composed concern hooks (src/components/layout/hooks/*). This component is
// the thin composition: chrome toolbar + <LayoutCanvas/> + the per-mode panel.
// The full useLayoutState() bundle is passed straight through to DrawModePanel
// as a single `state` prop (that panel references nearly the entire bundle).

export function LayoutScreen() {
  const state = useLayoutState();
  const {
    // context passthroughs + composer-level derived (chrome + canvas only)
    strips, layers, hidden,
    viewBox, svgText, density, pxPerMm,
    patchBoard,
    selectStrip, toggleStripSel, togglePathSelection,
    layoutHistLen, layoutFutLen,
    doUndo, doRedo,
    selLayer, existingStrip,
    selStripId,
    pathSel,
    totalLeds,
    svgRef, artworkRef, vpRef,
    // size
    scaleUnit, setScaleUnit,
    handleDensityChange, handleScaleChange,
    // strips
    addAllStrips,
    // artwork
    artworkHTML,
    setHoveredLayerId, hoveredSubPathId, setHoveredSubPathId,
    // wire
    wireOverlayMode, setWireOverlayMode,
    setSelectedWirePatchId, setLinkRouteIds, linkRouteStartedRef,
    chopStripAtEvent, toggleRoutePatch,
    // canvas + preview
    showLight, setShowLight, showLeds, setShowLeds,
    glowMode, setGlowMode, directedGlow, setDirectedGlow,
    showHeat, setShowHeat, lightMenuOpen, setLightMenuOpen,
    enableLightPreview, effectiveGlowMode, effectiveShowLight, glowStdDev,
    drawMode, setDrawMode, waypoints, setWaypoints, ghostPt, setGhostPt,
    ghostD,
    zoom, setZoom, isPanning, spaceRef, resetView,
    computedViewBox, vbScale, rubberBand, cursorSvgPt,
    startStripMove, movingStripIds, stripDragSuppressClickRef,
    handleSvgMouseDown, handleSvgClick, handleSvgDblClick, handleSvgMouseMove,
    handleSvgMouseUp, handleSvgMouseLeave, handleContextMenu, handleWheel,
    isEditingGesture, layoutPatternFrame, stripSamples, stripArrows,
    visibleWirePathCanvasSegments, wireRouteJumps, wireCutMarkers,
    // import
    dragOver, fileRef, loadRef,
    handleFile, handleDragOver, handleDragLeave, handleDrop, saveProject, handleLoad,
    // mode (Draw | Size | Wire)
    mode, setMode,
  } = state;

  const canvasProps = {
    refs: { svgRef, artworkRef, vpRef, spaceRef, stripDragSuppressClickRef },
    strips, layers, hidden,
    viewBox, computedViewBox, vbScale, svgText, artworkHTML, totalLeds,
    selection: { selStripId, selLayer, pathSel, existingStrip },
    lightPreview: {
      effectiveShowLight, effectiveGlowMode, glowStdDev, directedGlow,
      showHeat, showLeds, layoutPatternFrame, stripSamples, stripArrows,
    },
    wire: { wireOverlayMode, visibleWirePathCanvasSegments, wireRouteJumps, wireCutMarkers },
    draw: { drawMode, waypoints, ghostPt, ghostD },
    interaction: {
      isEditingGesture, isPanning, rubberBand, movingStripIds,
      dragOver, cursorSvgPt, zoom, hoveredSubPathId,
    },
    interactionHandlers: {
      handleSvgClick, handleSvgDblClick, handleSvgMouseMove, handleSvgMouseDown,
      handleSvgMouseUp, handleSvgMouseLeave, handleContextMenu, handleWheel,
      handleDragOver, handleDragLeave, handleDrop,
      startStripMove, chopStripAtEvent, toggleStripSel, selectStrip,
      toggleRoutePatch, togglePathSelection, setHoveredLayerId, setHoveredSubPathId,
    },
  };

  return (
    <div className="screen">
      <div className="la">

      {/* ── Hidden file inputs ─────────────────────────────────────── */}
      <input ref={fileRef} type="file" accept=".svg"  style={{ display: 'none' }} onChange={handleFile}/>
      <input ref={loadRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoad}/>

      {/* ── Toolbar (mockup .toolbar) ──────────────────────────────── */}
        <div className="toolbar">
          <ModeSwitch mode={mode} setMode={setMode}/>

          <div className="tb-div"/>

          <button className="tb-btn solid" onClick={() => fileRef.current?.click()}
                  title="Import an SVG to map LED strips">
            {TbIcon.import}Import SVG
          </button>

          {layers.length > 0 && (
            <button className="tb-btn" onClick={addAllStrips}
                    title={`Add all ${layers.length} layers as strips (A)`}>
              + All ({layers.length})
            </button>
          )}

          <div className="tb-div"/>

          {/* Draw / Chop / Link tools */}
          <button
            className={`tb-btn${drawMode ? ' active' : ''}`}
            title="Draw a new LED strip path on the artwork."
            onClick={() => { setDrawMode(m => !m); setWireOverlayMode('idle'); setWaypoints([]); setGhostPt(null); }}>
            {TbIcon.draw}{drawMode ? 'Drawing…' : 'Draw'}
          </button>
          <button
            className={`tb-btn${wireOverlayMode === 'chop' ? ' active' : ''}`}
            title="Split one physical strip where the wire jumps to a new spot."
            onClick={() => {
              setDrawMode(false);
              setWaypoints([]);
              setGhostPt(null);
              setWireOverlayMode(mode => mode === 'chop' ? 'idle' : 'chop');
            }}>
            Split
          </button>
          <button
            className={`tb-btn${wireOverlayMode === 'link' ? ' active' : ''}`}
            title="Join two strips into one continuous run."
            onClick={() => {
              setDrawMode(false);
              setWaypoints([]);
              setGhostPt(null);
              setSelectedWirePatchId(null);
              setWireOverlayMode(mode => {
                const nextMode = mode === 'link' ? 'idle' : 'link';
                if (nextMode === 'link') {
                  const currentRows = mainChain(normalizePatchBoard(patchBoard, strips)).rowIds;
                  setLinkRouteIds(currentRows);
                  linkRouteStartedRef.current = false;
                } else {
                  setLinkRouteIds([]);
                  linkRouteStartedRef.current = false;
                }
                return nextMode;
              });
            }}>
            Link
          </button>

          {/* Undo / Redo */}
          <button className="tb-btn icon" onClick={doUndo} disabled={layoutHistLen === 0}
                  title={`Undo (⌘Z) · ${layoutHistLen} step${layoutHistLen !== 1 ? 's' : ''}`}>
            {TbIcon.undo}{layoutHistLen > 0 && <span className="cnt">{layoutHistLen}</span>}
          </button>
          <button className="tb-btn icon" onClick={doRedo} disabled={layoutFutLen === 0}
                  title={`Redo (⌘⇧Z) · ${layoutFutLen} step${layoutFutLen !== 1 ? 's' : ''}`}>
            {TbIcon.redo}{layoutFutLen > 0 && <span className="cnt">{layoutFutLen}</span>}
          </button>

          <div className="tb-div"/>

          {/* Density segmented control */}
          <div className="seg">
            <span className="seg-label" title="LEDs per metre — count = size × density.">Density</span>
            {DENSITY_OPTIONS.map(d => (
              <button key={d} className={density === d ? 'on' : ''}
                      onClick={() => handleDensityChange(d)}>{d}</button>
            ))}
          </div>

          <div className="tb-div"/>
          {/* Size — the loaded artwork's real-world dimensions. Type a width to
              rescale everything; LED counts follow size × density. */}
          {(() => {
            const vb = parsedVb(viewBox);
            const per = scaleUnit === 'in' ? 25.4 : 10;      // mm per display unit
            const wDisp = (vb.w / pxPerMm) / per;
            const hDisp = (vb.h / pxPerMm) / per;
            const applyWidth = (raw) => {
              const val = parseFloat(raw);
              if (!(val > 0)) return;
              handleScaleChange(vb.w / (val * per));          // pxPerMm = svgWidth / targetWidthMm
            };
            return (
              <div className="seg" title="Real-world size of the loaded artwork. Type a width to scale it — LED counts follow size × density.">
                <span className="seg-label">Size</span>
                <input type="number" min="0.1" step="0.1" inputMode="decimal"
                       key={`sz-${scaleUnit}-${wDisp.toFixed(2)}`}
                       defaultValue={wDisp.toFixed(1)}
                       aria-label={`Artwork width in ${scaleUnit}`}
                       style={{ width: 64, height: 24, textAlign: 'right', fontVariantNumeric: 'tabular-nums', background: 'var(--bg-app)',
                                border: '1px solid var(--border-soft)', borderRadius: 4, color: 'var(--text-hi)',
                                fontFamily: 'var(--font-mono)', fontSize: 12, padding: '0 6px' }}
                       onFocus={e => e.target.select()}
                       onBlur={e => applyWidth(e.target.value)}
                       onKeyDown={e => { if (e.key === 'Enter') { applyWidth(e.target.value); e.target.blur(); } }}/>
                <span style={{ color: 'var(--text-faint)', fontSize: 12, whiteSpace: 'nowrap' }}>× {hDisp.toFixed(1)}</span>
                <button title="Toggle centimetres / inches"
                        onClick={() => setScaleUnit(u => (u === 'cm' ? 'in' : 'cm'))}>{scaleUnit}</button>
              </div>
            );
          })()}

          <div className="tb-spring"/>

          {/* Zoom cluster */}
          <div className="la-zoom">
            <button onClick={() => setZoom(z => Math.max(0.15, z / 1.25))} title="Zoom out (-)">−</button>
            <button className="zv" onClick={resetView} title="Reset view (F)">{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom(z => Math.min(40, z * 1.25))} title="Zoom in (+)">+</button>
          </div>

          <div className="tb-div"/>

          {/* Save / Load */}
          <button className="tb-btn" onClick={saveProject} title="Save project file">
            {TbIcon.save}Save
          </button>
          <button className="tb-btn" onClick={() => loadRef.current?.click()} title="Load project file">
            {TbIcon.load}Load
          </button>

          <div className="tb-div"/>

          {/* Render toggles — LEDs + Heat top-level; Directed-glow + glow-mode tuck under Light */}
          <div className="la-light-wrap">
            <button className={`tb-btn${showLight ? ' active' : ''}`}
                    onClick={() => setShowLight(v => !v)}
                    onContextMenu={e => { e.preventDefault(); setLightMenuOpen(o => !o); }}
                    title="Toggle ambient light preview (click). Right-click or use ▾ for glow options.">
              {TbIcon.bulb}Light
            </button>
            <button className="tb-btn icon" title="Light glow options"
                    onClick={() => setLightMenuOpen(o => !o)}>▾</button>
            {lightMenuOpen && (
              <>
                <div className="la-light-pop-backdrop" onClick={() => setLightMenuOpen(false)}/>
                <div className="la-light-pop" role="menu">
                  <button className={`la-light-item${directedGlow ? ' on' : ''}`}
                          onClick={() => { setDirectedGlow(v => !v); enableLightPreview(); }}
                          title="Directed glow — elongate bloom along strip direction">
                    <span>Directed glow</span>
                    <span className="st">{directedGlow ? 'on' : 'off'}</span>
                  </button>
                  <div className="la-light-sep"/>
                  <button className="la-light-item"
                          onClick={() => setGlowMode(m => GLOW_MODES[(GLOW_MODES.indexOf(m) + 1) % GLOW_MODES.length])}
                          title="Cycle glow mode (dots is fastest for editing)">
                    <span>Glow mode</span>
                    <span className="st">{glowMode}</span>
                  </button>
                </div>
              </>
            )}
          </div>
          <button className={`tb-btn${showLeds ? ' active' : ''}`} onClick={() => setShowLeds(v => !v)}
                  title="Toggle LED dots">
            {TbIcon.grid}LEDs
          </button>
          <button className={`tb-btn${showHeat ? ' active' : ''}`} onClick={() => setShowHeat(v => !v)}
                  title="Coverage heatmap">
            {TbIcon.heat}Heat
          </button>
        </div>

        {/* ── Canvas (SVG stage + overlays) ─────────────────────────── */}
        <LayoutCanvas {...canvasProps}/>

      {/* ── Right panel (mockup .side) ─────────────────────────────── */}
      <aside className="side">
      {mode === 'draw' && <DrawModePanel state={state}/>}
      {mode === 'size' && <SizeModePanel state={state}/>}
      {mode === 'wire' && (
        <div className="la-mode-stub" data-testid="layout-wire-stub">
          Wire tools arrive in the next step
        </div>
      )}
      </aside>
      </div>{/* .la */}
    </div>
  );
}
