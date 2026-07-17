import { useState } from 'react';
import { TbIcon } from './layout/shared/InspectorPrimitives.jsx';
import { ModeSwitch } from './layout/shared/ModeSwitch.jsx';
import { GLOW_MODES, svgPt } from '../lib/layoutGeometry.js';
import { mainChain, normalizePatchBoard } from '../lib/patchBoard.js';
import { LayoutCanvas } from './layout/canvas/LayoutCanvas.jsx';
import { DrawModePanel } from './layout/modes/DrawModePanel.jsx';
import { SizeModePanel } from './layout/modes/SizeModePanel.jsx';
import { WireModePanel } from './layout/modes/WireModePanel.jsx';
import { useLayoutState } from './layout/hooks/useLayoutState.js';
import { useProject } from '../state/ProjectContext.jsx';

// ── Main component ─────────────────────────────────────────────────────────
// All state, handlers, derived memos and effects live in useLayoutState() and
// its composed concern hooks (src/components/layout/hooks/*). This component is
// the thin composition: chrome toolbar + <LayoutCanvas/> + the per-mode panel.
// The full useLayoutState() bundle is passed straight through to DrawModePanel
// as a single `state` prop (that panel references nearly the entire bundle).

export function LayoutScreen({ connected, cardHost }) {
  const state = useLayoutState();
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const { wiring, compiledWiring, updateWiring } = useProject();
  const {
    // context passthroughs + composer-level derived (chrome + canvas only)
    strips, layers, hidden,
    viewBox, svgText,
    patchBoard,
    selectStrip, toggleStripSel, togglePathSelection,
    layoutHistLen, layoutFutLen,
    doUndo, doRedo,
    selLayer, existingStrip,
    selStripId,
    pathSel,
    selectedPathDecorations,
    totalLeds,
    svgRef, artworkRef, vpRef,
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
    drawMode, setDrawMode, waypoints, ghostPt, setGhostPt,
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
    selection: { selStripId, selLayer, pathSel, selectedPathDecorations, existingStrip },
    lightPreview: {
      effectiveShowLight, effectiveGlowMode, glowStdDev, directedGlow,
      showHeat, showLeds, layoutPatternFrame, stripSamples, stripArrows,
    },
    wire: {
      wireOverlayMode, visibleWirePathCanvasSegments, wireRouteJumps, wireCutMarkers,
      wiring, compiledWiring,
      selectedWiringRunId: wiring.runs.find(run => run.type === 'strip' && run.source.stripId === selStripId)?.id || null,
      onControllerAnchorMove: event => {
        if (!svgRef.current || wiring.locked) return;
        const point = svgPt(svgRef.current, event.clientX, event.clientY);
        updateWiring(draft => { draft.controllerAnchor = { x: point.x, y: point.y }; }, { changeKind: 'controller-anchor' });
      },
      onSeamMove: (runId, event) => {
        if (!svgRef.current || wiring.locked) return;
        const point = svgPt(svgRef.current, event.clientX, event.clientY);
        updateWiring(draft => {
          const run = draft.runs.find(item => item.id === runId);
          if (!run || run.type !== 'strip' || run.verified || run.directionPolicy === 'fixed') throw new Error('Verified or fixed connector seams cannot move.');
          const strip = strips.find(item => item.id === run.source.stripId);
          const candidates = strip?.pixels?.slice(run.source.from, run.source.to + 1) || [];
          let nearest = 0;
          candidates.forEach((pixel, index) => {
            if (Math.hypot(point.x - pixel.x, point.y - pixel.y) < Math.hypot(point.x - candidates[nearest].x, point.y - candidates[nearest].y)) nearest = index;
          });
          run.seamLed = run.source.from + nearest;
        }, { changeKind: 'seam', runIds: [runId] });
      },
    },
    draw: { mode, drawMode, waypoints, ghostPt, ghostD },
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
      <div className={`la${inspectorCollapsed ? ' inspector-collapsed' : ''}`}>

      {/* ── Hidden file inputs ─────────────────────────────────────── */}
      <input ref={fileRef} type="file" accept=".svg"  style={{ display: 'none' }} onChange={handleFile}/>
      <input ref={loadRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoad}/>

      {/* ── Toolbar (mockup .toolbar) ──────────────────────────────── */}
        <div className="toolbar">
          <div className="tb-group" role="group" aria-label="Mode actions">
            <ModeSwitch mode={mode} setMode={setMode}/>
          </div>

          <div className="tb-div"/>

          {mode === 'draw' && (
            <>
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

              <button
                className={`tb-btn${drawMode ? ' active' : ''}`}
                title="Draw a new LED strip path on the artwork."
                onClick={() => { setDrawMode(m => !m); setWireOverlayMode('idle'); setGhostPt(null); }}>
                {TbIcon.draw}{drawMode ? 'Drawing…' : 'Draw'}
              </button>
            </>
          )}

          {/* Draw / Chop / Link tools */}
          {/* Split / Link are wire concerns — surfaced only in Wire mode
              (plan's canvas behavior matrix: chop/link overlays are Wire only). */}
          {mode === 'wire' && (
            <>
              <button
                className={`tb-btn${wireOverlayMode === 'chop' ? ' active' : ''}`}
                title="Split one physical strip where the wire jumps to a new spot."
                onClick={() => {
                  setDrawMode(false);
                  setGhostPt(null);
                  setWireOverlayMode(m => m === 'chop' ? 'idle' : 'chop');
                }}>
                Split
              </button>
              <button
                className={`tb-btn${wireOverlayMode === 'link' ? ' active' : ''}`}
                title="Join two strips into one continuous run."
                onClick={() => {
                  setDrawMode(false);
                  setGhostPt(null);
                  setSelectedWirePatchId(null);
                  setWireOverlayMode(m => {
                    const nextMode = m === 'link' ? 'idle' : 'link';
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
            </>
          )}

          {/* Undo / Redo */}
          <button className="tb-btn icon" onClick={doUndo} disabled={layoutHistLen === 0}
                  title={`Undo (⌘Z) · ${layoutHistLen} step${layoutHistLen !== 1 ? 's' : ''}`}>
            {TbIcon.undo}{layoutHistLen > 0 && <span className="cnt">{layoutHistLen}</span>}
          </button>
          <button className="tb-btn icon" onClick={doRedo} disabled={layoutFutLen === 0}
                  title={`Redo (⌘⇧Z) · ${layoutFutLen} step${layoutFutLen !== 1 ? 's' : ''}`}>
            {TbIcon.redo}{layoutFutLen > 0 && <span className="cnt">{layoutFutLen}</span>}
          </button>

          {/* Density + artwork-size controls live in Size mode only now
              (docs/layout-redesign-plan.md step 10 — the toolbar duplicates of
              the Size panel's density seg and width field were removed). */}

          <div className="tb-spring"/>

          {/* Zoom cluster */}
          <div className="la-zoom" role="group" aria-label="View">
            <button onClick={() => setZoom(z => Math.max(0.15, z / 1.25))} title="Zoom out (-)">−</button>
            <button className="zv" onClick={resetView} title="Reset view (F)">{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom(z => Math.min(40, z * 1.25))} title="Zoom in (+)">+</button>
          </div>

          <div className="tb-div"/>

          {/* Save / Load */}
          <div className="tb-group" role="group" aria-label="Project">
            <button className="tb-btn" onClick={saveProject} title="Save project file">
              {TbIcon.save}Save
            </button>
            <button className="tb-btn" onClick={() => loadRef.current?.click()} title="Load project file">
              {TbIcon.load}Load
            </button>
          </div>

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
      <aside className={`side${inspectorCollapsed ? ' is-collapsed' : ''}`}>
        <button
          type="button"
          className="la-sheet-handle"
          data-testid="layout-sheet-handle"
          aria-label={inspectorCollapsed ? 'Expand inspector' : 'Collapse inspector'}
          aria-expanded={!inspectorCollapsed}
          onClick={() => setInspectorCollapsed(collapsed => !collapsed)}>
          <span aria-hidden="true"/>
          <strong>Inspector</strong>
        </button>
        {mode === 'draw' && <DrawModePanel state={state}/>}
        {mode === 'size' && <SizeModePanel state={state}/>}
        {mode === 'wire' && <WireModePanel state={state} connected={connected} cardHost={cardHost}/>}
      </aside>
      </div>{/* .la */}
    </div>
  );
}
