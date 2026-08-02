import { useState } from 'react';
import { TbIcon } from './layout/shared/InspectorPrimitives.jsx';
import { ModeSwitch } from './layout/shared/ModeSwitch.jsx';
import { GLOW_MODES, svgPt } from '../lib/layoutGeometry.js';
import { LayoutCanvas } from './layout/canvas/LayoutCanvas.jsx';
import { DrawModePanel } from './layout/modes/DrawModePanel.jsx';
import { WireModePanel } from './layout/modes/WireModePanel.jsx';
import { useLayoutState } from './layout/hooks/useLayoutState.js';
import { useProject } from '../state/ProjectContext.jsx';
import {
  createDefaultKaleidoscope,
  deriveReflectionPointIndices,
  nudgeKaleidoscopePoint,
  nudgeKaleidoscopeStart,
  setKaleidoscopePointCount,
} from '../lib/kaleidoscope.js';
import { useKaleidoscopeCalibration } from './layout/hooks/useKaleidoscopeCalibration.js';

// ── Main component ─────────────────────────────────────────────────────────
// All state, handlers, derived memos and effects live in useLayoutState() and
// its composed concern hooks (src/components/layout/hooks/*). This component is
// the thin composition: chrome toolbar + <LayoutCanvas/> + the per-mode panel.
// The full useLayoutState() bundle is passed straight through to DrawModePanel
// as a single `state` prop (that panel references nearly the entire bundle).

export function LayoutScreen({ connected, cardHost, onConnectCard, onOpenConnectionCenter }) {
  const state = useLayoutState();
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [firstLedPicker, setFirstLedPicker] = useState(null);
  const [firstLedError, setFirstLedError] = useState(null);
  const [firstLedMarkerRunId, setFirstLedMarkerRunId] = useState(null);
  const [kaleidoscopeEditor, setKaleidoscopeEditor] = useState(null);
  const { wiring, compiledWiring, updateWiring } = useProject();
  const {
    // context passthroughs + composer-level derived (chrome + canvas only)
    strips, layers, hidden,
    viewBox, svgText,
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
    chopStripAtEvent,
    // canvas + preview
    showLight, setShowLight, showLeds, setShowLeds,
    glowMode, setGlowMode, directedGlow, setDirectedGlow,
    showHeat, setShowHeat, lightMenuOpen, setLightMenuOpen,
    enableLightPreview, effectiveGlowMode, effectiveShowLight, glowStdDev,
    drawMode, setDrawMode, waypoints, ghostPt, setGhostPt,
    ghostD,
    zoom, zoomByFactor, isPanning, spaceRef, resetView,
    computedViewBox, vbScale, rubberBand, cursorSvgPt,
    startStripMove, movingStripIds, stripDragSuppressClickRef,
    handleSvgMouseDown, handleSvgClick, handleSvgDblClick, handleSvgMouseMove,
    handleSvgMouseUp, handleSvgMouseLeave, handleContextMenu, handleWheel,
    isEditingGesture, layoutPatternFrame, stripSamples, stripArrows,
    visibleWirePathCanvasSegments, wireRouteJumps, wireCutMarkers,
    // import
    dragOver, fileRef, loadRef,
    handleFile, handleDragOver, handleDragLeave, handleDrop, saveProject, handleLoad, importAccept,
    // mode (Draw | Wire)
    mode, setMode,
  } = state;

  const beginFirstLedPicker = stripId => {
    selectStrip(stripId);
    setFirstLedError(null);
    setFirstLedPicker({ stripId, ledIndex: null });
  };
  const cancelFirstLedPicker = () => {
    setFirstLedError(null);
    setFirstLedPicker(null);
  };
  const pickFirstLed = (stripId, ledIndex) => {
    if (firstLedPicker?.stripId !== stripId) return;
    const strip = strips.find(item => item.id === stripId);
    if (!strip?.pixels?.[ledIndex]) {
      setFirstLedError({ stripId, message: 'That light is outside this strip.' });
      return;
    }
    let pickedRunId = null;
    const result = updateWiring(draft => {
      if (draft.locked) {
        draft.locked = false;
        draft.verified = false;
        draft.runs.forEach(run => { run.verified = false; });
      }
      const runs = draft.runs.filter(item => item.type === 'strip' && item.source?.stripId === stripId);
      if (!runs.length) throw new Error('This strip is not connected to a GPIO output yet.');

      // A normal Draw strip owns one complete run. LED-count and size edits can
      // leave that run's old range behind, so repair it before validation.
      // Advanced split strips remain split; the clicked LED identifies the run.
      let run;
      if (runs.length === 1) {
        [run] = runs;
        run.source.from = 0;
        run.source.to = strip.pixels.length - 1;
      } else {
        run = runs.find(item => ledIndex >= item.source.from && ledIndex <= item.source.to);
      }
      if (!run) throw new Error('That light is not covered by this strip’s wiring runs.');
      pickedRunId = run.id;
      run.seamLed = ledIndex;
    }, { changeKind: 'seam' });
    if (!result.ok) {
      setFirstLedError({ stripId, message: result.errors?.[0]?.message || 'The first LED could not be changed.' });
      return;
    }
    setFirstLedMarkerRunId(pickedRunId);
    setFirstLedError(null);
    setFirstLedPicker(null);
  };

  const markerRun = wiring.runs.find(run => run.id === firstLedMarkerRunId && run.type === 'strip' && run.source.stripId === selStripId);

  const updateKaleidoscope = (stripId, next, options) => {
    state.updateStripKaleidoscope(stripId, next, options);
    setKaleidoscopeEditor(current => current?.stripId === stripId
      ? { ...current, error: null }
      : current);
  };
  const openKaleidoscope = (stripId, replacement = null) => {
    const strip = strips.find(item => item.id === stripId);
    if (!strip || strip.pixelCount < 2) return;
    if (!strip.kaleidoscope) updateKaleidoscope(
      stripId,
      replacement || createDefaultKaleidoscope(strip.pixelCount),
    );
    selectStrip(stripId);
    setKaleidoscopeEditor(current => current?.stripId === stripId
      ? null
      : { stripId, mode: 'open', selectedPointIndex: 0, error: null });
  };
  const changeKaleidoscopeCount = (stripId, count) => {
    const strip = strips.find(item => item.id === stripId);
    if (!strip?.kaleidoscope) return;
    if (count !== strip.kaleidoscope.pointCount
      && strip.kaleidoscope.offsets.some(offset => offset !== 0)
      && !window.confirm('Changing the point count resets your fine-tuned LED spacing. Continue?')) return;
    try {
      updateKaleidoscope(stripId, setKaleidoscopePointCount(strip.kaleidoscope, strip.pixelCount, count));
      setKaleidoscopeEditor(current => ({ ...current, selectedPointIndex: 0 }));
    } catch (error) {
      setKaleidoscopeEditor(current => ({ ...current, error: error.message }));
    }
  };
  const nudgeKaleidoscopeSet = (stripId, delta) => {
    const strip = strips.find(item => item.id === stripId);
    if (!strip?.kaleidoscope) return;
    updateKaleidoscope(stripId, nudgeKaleidoscopeStart(strip.kaleidoscope, strip.pixelCount, delta));
  };
  const moveKaleidoscopePoint = (stripId, pointIndex, ledIndex, { recordHistory = true } = {}) => {
    const strip = strips.find(item => item.id === stripId);
    if (!strip?.kaleidoscope) return false;
    const points = deriveReflectionPointIndices(strip.kaleidoscope, strip.pixelCount);
    let delta = ledIndex - points[pointIndex];
    if (delta > strip.pixelCount / 2) delta -= strip.pixelCount;
    if (delta < -strip.pixelCount / 2) delta += strip.pixelCount;
    const result = nudgeKaleidoscopePoint(strip.kaleidoscope, strip.pixelCount, pointIndex, delta);
    if (!result.ok) {
      setKaleidoscopeEditor(current => ({ ...current, error: result.error?.message || 'That point cannot move there.' }));
      return false;
    }
    updateKaleidoscope(stripId, result.value, { recordHistory });
    return true;
  };
  const pickKaleidoscopeLed = (stripId, ledIndex, pointIndex = null, options) => {
    const strip = strips.find(item => item.id === stripId);
    if (!strip?.kaleidoscope || kaleidoscopeEditor?.stripId !== stripId) return false;
    if (kaleidoscopeEditor.mode === 'pick' && pointIndex == null) {
      updateKaleidoscope(stripId, { ...strip.kaleidoscope, startLed: ledIndex });
      setKaleidoscopeEditor(current => ({ ...current, mode: 'open' }));
      return true;
    }
    const selected = pointIndex ?? kaleidoscopeEditor.selectedPointIndex;
    return moveKaleidoscopePoint(stripId, selected, ledIndex, options);
  };
  const kaleidoscopeCalibration = useKaleidoscopeCalibration({
    editor: kaleidoscopeEditor,
    strips,
    compiledWiring,
    connected,
    host: cardHost,
    selectedStripId: selStripId,
    layoutMode: mode,
  });

  const canvasProps = {
    refs: { svgRef, artworkRef, vpRef, spaceRef, stripDragSuppressClickRef },
    strips: state.starterLayoutActive && mode === 'draw' ? [] : strips, layers, hidden,
    viewBox, computedViewBox, vbScale, svgText, artworkHTML, totalLeds,
    selection: { selStripId, selLayer, pathSel, selectedPathDecorations, existingStrip },
    lightPreview: {
      effectiveShowLight, effectiveGlowMode, glowStdDev, directedGlow,
      showHeat, showLeds, layoutPatternFrame, stripSamples, stripArrows,
    },
    wire: {
      wireOverlayMode, visibleWirePathCanvasSegments, wireRouteJumps, wireCutMarkers,
      wiring, compiledWiring,
      firstLedPicker,
      onFirstLedPick: pickFirstLed,
      kaleidoscopeEditor,
      onKaleidoscopeLedPick: pickKaleidoscopeLed,
      onKaleidoscopeSelectPoint: pointIndex => setKaleidoscopeEditor(current => ({
        ...current,
        mode: 'fine',
        selectedPointIndex: pointIndex,
        error: null,
      })),
      selectedWiringRunId: markerRun?.id || wiring.runs.find(run => run.type === 'strip' && run.source.stripId === selStripId)?.id || null,
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
      togglePathSelection, setHoveredLayerId, setHoveredSubPathId,
      onFitBoard: resetView,
    },
  };

  return (
    <div className="screen">
      <div className={`la mode-${mode}${inspectorCollapsed ? ' inspector-collapsed' : ''}`}>

      {/* ── Hidden file inputs ─────────────────────────────────────── */}
      <input ref={fileRef} type="file" accept=".svg"  style={{ display: 'none' }} onChange={handleFile}/>
      <input ref={loadRef} type="file" accept={importAccept} data-testid="layout-import-input" style={{ display: 'none' }} onChange={handleLoad}/>

      {/* ── Toolbar (mockup .toolbar) ──────────────────────────────── */}
        <div className="toolbar">
          <div className="tb-group" role="group" aria-label="Mode actions">
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

          {/* Split and cable-jump tools live inside Test & Install's closed
              Advanced section so the normal toolbar stays task-focused. */}
          </div>

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
            <button onClick={() => zoomByFactor(1 / 1.25)} aria-label="Zoom out" title="Zoom out (-)">−</button>
            <span
              className="zv"
              aria-label={`Zoom ${Math.round(zoom * 100)}%`}
              data-testid="layout-zoom-percentage">
              {Math.round(zoom * 100)}%
            </span>
            <button onClick={() => zoomByFactor(1.25)} aria-label="Zoom in" title="Zoom in (+)">+</button>
            <button onClick={resetView} aria-label="Fit all" title="Fit all (F, Cmd/Ctrl+0)">Fit</button>
          </div>

          <div className="tb-div"/>

          {/* Save / Load */}
          <div className="tb-group" role="group" aria-label="Project">
            <button className="tb-btn" onClick={saveProject} title="Export a portable project file (.lw.json)">
              {TbIcon.save}Export
            </button>
            <button className="tb-btn" onClick={() => loadRef.current?.click()} title="Import a project file">
              {TbIcon.load}Import
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
        <div className="la-mode-nav">
          <ModeSwitch mode={mode} setMode={setMode}/>
        </div>
        <div className={`la-mode-content is-${mode}`}>
          {mode === 'draw' && (
            <DrawModePanel state={state}
                           firstLedPicker={firstLedPicker}
                           firstLedError={firstLedError}
                           onBeginFirstLedPicker={beginFirstLedPicker}
                           onCancelFirstLedPicker={cancelFirstLedPicker}
                           kaleidoscopeEditor={kaleidoscopeEditor}
                           onToggleKaleidoscope={openKaleidoscope}
                           onCloseKaleidoscope={() => setKaleidoscopeEditor(null)}
                           onChangeKaleidoscopeCount={changeKaleidoscopeCount}
                           onNudgeKaleidoscopeSet={nudgeKaleidoscopeSet}
                           onPickKaleidoscopeStart={stripId => setKaleidoscopeEditor(current => ({ ...current, stripId, mode: 'pick', error: null }))}
                           onSelectKaleidoscopePoint={(stripId, pointIndex) => setKaleidoscopeEditor({ stripId, mode: 'fine', selectedPointIndex: pointIndex, error: null })}
                           onNudgeKaleidoscopePoint={(stripId, pointIndex, delta) => {
                             const strip = strips.find(item => item.id === stripId);
                             const led = deriveReflectionPointIndices(strip?.kaleidoscope, strip?.pixelCount || 0)[pointIndex];
                             if (Number.isInteger(led)) moveKaleidoscopePoint(stripId, pointIndex, led + delta);
                           }}
                           kaleidoscopeCalibration={kaleidoscopeCalibration}
                           onConnectCard={onConnectCard}
                           onOpenConnectionCenter={onOpenConnectionCenter}/>
          )}
          {mode === 'wire' && <WireModePanel state={state} connected={connected} cardHost={cardHost}/>} 
        </div>
      </aside>
      </div>{/* .la */}
    </div>
  );
}
