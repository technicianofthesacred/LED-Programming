import {
  EyeIcon,
  EyeOffIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  DragHandleIcon,
  GroupIcon,
  TbIcon,
  EmitCompass,
  InlineRename,
  LightCone,
  OmniHalo,
} from './layout/shared/InspectorPrimitives.jsx';
import {
  STRIP_COLORS,
  DENSITY_OPTIONS,
  GLOW_MODES,
  stripSourceKey,
  clampLedCount,
  rgbCss,
  pointsAttr,
  actionablePolylinePoints,
  parsedVb,
} from '../lib/layoutGeometry.js';
import {
  activeLedCoreAlpha,
  ledCssColor,
  restingLedAlpha,
} from '../lib/previewVisuals.js';
import {
  LED_COUNT_MAX,
  LED_COUNT_SLIDER_MAX,
  LED_COUNT_SLIDER_MIN,
  ledCountToSliderValue,
  sliderValueToLedCount,
} from '../lib/controlScale.js';
import { mainChain, normalizePatchBoard } from '../lib/patchBoard.js';
import { PatchBoardScreen } from './PatchBoardScreen.jsx';
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

function startedFromDragHandle(e) {
  return !!e.target?.closest?.('[data-drag-handle="true"]');
}

// ── Main component ─────────────────────────────────────────────────────────
// All state, handlers, derived memos and effects live in useLayoutState() and
// its composed concern hooks (src/components/layout/hooks/*). This component is
// the JSX tree + the destructure of that bundle — no logic of its own.

export function LayoutScreen() {
  const {
    // context passthroughs + composer-level derived
    strips, layers, hidden, setHidden,
    viewBox, svgText, density, pxPerMm,
    editCounts, setEditCounts, layerGroups, layerOrder, setLayers,
    patchBoard,
    selectStrip, selectLayer, selectPaths, toggleStripSel,
    clearLayoutSelection, renameLayoutSelection,
    layoutHistLen, layoutFutLen, usbLedConnected,
    doUndo, doRedo,
    selLayer, existingStrip,
    selStripId, selLayerId, selectedStripIds,
    pathSel, pathSelName, stripSelectionName,
    orderedStrips, selectedStrips,
    totalLeds, defaultCircleLayoutActive, usbLedMaxPixels,
    expandedStrips, setExpandedStrips,
    svgRef, artworkRef, vpRef, stripListRef,
    // size
    scaleUnit, setScaleUnit, getLedCount, resampleStrip,
    handleDensityChange, handleScaleChange, calibrateScaleFromStrip,
    // strips
    updateStrip, removeStrip, reverseStrip, renameStrip, duplicateStrip,
    addStripsToGroup, groupSelectedStrips, mergeSelectedStrips, reorderStripRows,
    // artwork
    artworkHTML,
    expandedLayers, setExpandedLayers,
    layerDragging, setLayerDragging,
    layerDragOver, setLayerDragOver,
    stripGroupDragOver, setStripGroupDragOver,
    readDraggedStripIds, readDraggedPathEntries,
    createLayerGroupFromEntries, addPathsToGroup, togglePathSelection,
    addStrip, addSubPathStrip, addSelectedPathsAsStrips, addAllStrips,
    renameLayer, renameSubPath, renameGroup,
    deleteLayer, createLayerGroup, deleteLayerGroup,
    toggleGroupExpanded, toggleGroupHidden, reorderLayerOrder,
    // wire
    wireOverlayMode, setWireOverlayMode,
    selectedWireCut, setSelectedWireCut, setSelectedWirePatchId,
    setLinkRouteIds, linkRouteStartedRef,
    chopStripAtEvent, toggleRoutePatch, nudgeSelectedWireCut, deleteSelectedWireCut,
    // canvas + preview
    showLight, setShowLight, showLeds, setShowLeds,
    glowMode, setGlowMode, directedGlow, setDirectedGlow,
    showHeat, setShowHeat, lightMenuOpen, setLightMenuOpen,
    enableLightPreview, effectiveGlowMode, effectiveShowLight, glowStdDev,
    drawMode, setDrawMode, waypoints, setWaypoints, ghostPt, setGhostPt,
    pendingDraw, pendingDrawName, setPendingDrawName,
    pendingDrawCount, setPendingDrawCount, pendingDrawNameRef,
    confirmDraw, cancelDraw, drawEstimatedLeds, ghostD,
    zoom, setZoom, isPanning, spaceRef, resetView,
    computedViewBox, vbScale, rubberBand, cursorSvgPt,
    setHoveredLayerId, hoveredSubPathId, setHoveredSubPathId,
    startStripMove, movingStripIds, stripDragSuppressClickRef,
    handleSvgMouseDown, handleSvgClick, handleSvgDblClick, handleSvgMouseMove,
    handleSvgMouseUp, handleSvgMouseLeave, handleContextMenu, handleWheel,
    isEditingGesture, layoutPatternFrame, stripSamples, stripArrows,
    visibleWirePathCanvasSegments, wireRouteJumps, wireCutMarkers,
    // import
    error, setError, dragOver, fileRef, loadRef,
    handleFile, handleDragOver, handleDragLeave, handleDrop, saveProject, handleLoad,
  } = useLayoutState();

  return (
    <div className="screen">
      <div className="la">

      {/* ── Hidden file inputs ─────────────────────────────────────── */}
      <input ref={fileRef} type="file" accept=".svg"  style={{ display: 'none' }} onChange={handleFile}/>
      <input ref={loadRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoad}/>

      {/* ── Toolbar (mockup .toolbar) ──────────────────────────────── */}
        <div className="toolbar">
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

        {/* Body (mockup .body) — dotgrid + stage SVG + overlays */}
        <main className="body">
        <div className="dotgrid"/>
        <div className="stage">
        {/* Viewport */}
        <div
          ref={vpRef}
          className={`lw-viewport${dragOver ? ' lw-viewport--drop' : ''}`}
          style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', cursor: isPanning ? 'grabbing' : 'default' }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragOver && (
            <div style={{
              position: 'absolute', inset: 12, border: '2px dashed var(--accent)',
              borderRadius: 8, pointerEvents: 'none', zIndex: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--accent-soft)',
            }}>
              <span style={{ color: 'var(--accent)', fontSize: 'var(--fs-md)', fontWeight: 500 }}>Drop SVG here</span>
            </div>
          )}
          <svg
            ref={svgRef}
            viewBox={computedViewBox}
            overflow="visible"
            preserveAspectRatio="xMidYMid meet"
            style={{
              width: '100%', height: '100%',
              maxWidth: '100%', maxHeight: '100%',
              aspectRatio: `${parsedVb(viewBox).w} / ${parsedVb(viewBox).h}`,
              objectFit: 'contain',
              cursor: drawMode ? 'crosshair' : rubberBand ? 'crosshair' : isPanning ? 'grabbing' : spaceRef.current ? 'grab' : 'default',
            }}
            onClick={handleSvgClick}
            onDoubleClick={handleSvgDblClick}
            onMouseMove={handleSvgMouseMove}
            onMouseDown={handleSvgMouseDown}
            onMouseUp={handleSvgMouseUp}
            onMouseLeave={handleSvgMouseLeave}
            onContextMenu={handleContextMenu}
            onWheel={handleWheel}
          >
            <defs>
              {effectiveGlowMode !== 'dots' && (
                <filter id="lw-led-bloom" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation={glowStdDev}/>
                </filter>
              )}
              {/* Single filter for all ambient light — one blur op on the whole group, not per-element */}
              <filter id="lw-light-glow" x="-150%" y="-150%" width="400%" height="400%">
                <feGaussianBlur stdDeviation={vbScale * 4}/>
              </filter>
              <radialGradient id="heat-grad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="oklch(80% 0.2 30)" stopOpacity="1"/>
                <stop offset="100%" stopColor="oklch(80% 0.2 30)" stopOpacity="0"/>
              </radialGradient>
            </defs>

            {/* ── Artwork background ── */}
            {artworkHTML && (
              <g ref={artworkRef}
                 style={{ pointerEvents: 'none', filter: 'saturate(3) brightness(1.4)', mixBlendMode: 'screen',
                          opacity: effectiveShowLight ? 0.18 : 1, transition: isEditingGesture ? 'none' : 'opacity 0.2s' }}
                 dangerouslySetInnerHTML={{ __html: artworkHTML }}/>
            )}

            {/* ── Coverage heat map ── */}
            {showHeat && (
              <g style={{ pointerEvents: 'none' }}>
                {strips.filter(s => !hidden[s.id]).flatMap(s =>
                  s.pixels.map((px, i) => (
                    <circle key={`${s.id}-heat-${i}`} cx={px.x} cy={px.y}
                            r={vbScale * 18}
                            fill="url(#heat-grad)" opacity={0.09}
                            style={{ mixBlendMode: 'screen' }}/>
                  ))
                )}
              </g>
            )}

            {/* ── Selected layer glow (only when selected from panel, not canvas path-click) ── */}
            {selLayer && !selStripId && pathSel.length === 0 && (() => {
              const glowPaths = selLayer.subPaths?.length > 0
                ? selLayer.subPaths.map(sp => ({ id: sp.pathId, d: sp.pathData }))
                : [{ id: selLayer.layerId, d: selLayer.pathData }];
              return glowPaths.filter(p => p.d).map(p => (
                <g key={p.id} style={{ pointerEvents: 'none' }}>
                  <path d={p.d} stroke={selLayer._color} strokeWidth="2" strokeOpacity={0.5} fill="none" strokeLinecap="round"/>
                  <path d={p.d} stroke="oklch(0.553 0.109 56)" strokeWidth="7" strokeOpacity={0.14} fill="none" strokeLinecap="round"/>
                  <path d={p.d} stroke="oklch(0.615 0.112 57)" strokeWidth="3" strokeOpacity={0.6} fill="none" strokeLinecap="round"/>
                  <path d={p.d} stroke="white"   strokeWidth="1"  strokeOpacity={0.85} fill="none" strokeLinecap="round"/>
                </g>
              ));
            })()}

            {/* ── Hit paths — individual path selection ── */}
            {!drawMode && layers.map(l => {
              if (hidden[l.layerId] || !l.pathData) return null;
              const hasSubPaths = l.subPaths?.length > 0;
              const targets = hasSubPaths
                ? l.subPaths.map(sp => ({ pathId: sp.pathId, pathData: sp.pathData, name: sp.name, svgLength: sp.svgLength }))
                : [{ pathId: l.layerId, pathData: l.pathData, name: l.name, svgLength: l.svgLength }];
              return targets.map(t => {
                const entry = {
                  layerId: l.layerId, pathId: t.pathId, pathData: t.pathData,
                  name: hasSubPaths ? `${l.name} · ${t.name}` : l.name,
                  svgLength: t.svgLength,
                };
                return (
                  <path key={t.pathId} d={t.pathData}
                        data-vector-layer-id={l.layerId}
                        data-vector-path-id={t.pathId}
                        fill="none" stroke="#fff" strokeOpacity="0.001"
                        strokeWidth="16" strokeLinecap="round" pointerEvents="stroke"
                        style={{ cursor: 'pointer' }}
                        onMouseDown={e => e.stopPropagation()}
                        onMouseEnter={() => { setHoveredLayerId(l.layerId); setHoveredSubPathId(t.pathId); }}
                        onMouseLeave={() => { setHoveredLayerId(null); setHoveredSubPathId(null); }}
                        onClick={e => {
                          e.stopPropagation();
                          // Shift-click toggles this path in/out of the selection;
                          // plain click selects only it. Path selection clears
                          // strip/layer selection in the reducer.
                          togglePathSelection(entry, e.shiftKey);
                        }}/>
                );
              });
            })}

            {/* ── Hovered sub-path outline ── */}
            {hoveredSubPathId && (() => {
              for (const l of layers) {
                if (hidden[l.layerId]) continue;
                const t = l.subPaths?.find(s => s.pathId === hoveredSubPathId)
                       ?? (l.layerId === hoveredSubPathId ? { pathData: l.pathData } : null);
                if (t?.pathData) return (
                  <path key="hover-sp" d={t.pathData} fill="none"
                        stroke="oklch(0.615 0.112 57)" strokeWidth="3" strokeOpacity={0.55}
                        strokeLinecap="round" pointerEvents="none"/>
                );
              }
              return null;
            })()}


            {/* ── Path selection highlight (marching ants = canvas path-pick for strip assignment) ── */}
            {pathSel.map((p, idx) => {
              const midEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
              midEl.setAttribute('d', p.pathData);
              const len = midEl.getTotalLength ? midEl.getTotalLength() : 100;
              const midPt = midEl.getPointAtLength ? midEl.getPointAtLength(len * 0.5) : { x: 0, y: 0 };
              return (
                <g key={'sel-' + p.pathId} style={{ pointerEvents: 'none' }}>
                  <path d={p.pathData} stroke="oklch(0.615 0.112 57)" strokeWidth="8" fill="none" opacity={0.16} strokeLinecap="round"/>
                  <path d={p.pathData} stroke="oklch(0.615 0.112 57)" strokeWidth="2.5" fill="none" opacity={0.95}
                        strokeDasharray="10 5" strokeLinecap="round"
                        style={{ animation: 'lw-march 0.5s linear infinite' }}/>
                  <circle cx={midPt.x} cy={midPt.y} r={vbScale * 9} fill="oklch(0.615 0.112 57)" opacity={0.95}/>
                  <text x={midPt.x} y={midPt.y + vbScale * 4} textAnchor="middle" fill="oklch(0.190 0.018 52)" fontSize={vbScale * 9}
                        fontWeight="bold" style={{ userSelect: 'none' }}>{idx + 1}</text>
                </g>
              );
            })}

            {/* ── Light visualization ── */}
            {effectiveShowLight && (
              <g filter={directedGlow ? undefined : 'url(#lw-light-glow)'} style={{ mixBlendMode: 'screen', pointerEvents: 'none' }}>
                {strips.map(s => !hidden[s.id] && (stripSamples[s.id] || []).map((pt, i) => {
                  const stripFrame = layoutPatternFrame.get(s.id);
                  const lightColor = rgbCss(stripFrame?.leds?.[i] || stripFrame, s.color);
                  const reach = vbScale * (effectiveGlowMode === 'inward' ? 24 : effectiveGlowMode === 'outward' ? 50 : 38);
                  const intensity = s.id === selStripId ? 0.42 : 0.28;
                  if (directedGlow) {
                    const isOmni = s.emit === 'omni';
                    const tangentAngle = Math.atan2(pt.ty || 0, pt.tx || 1) * 180 / Math.PI + 90;
                    const angle = Number.isFinite(Number(s.angle)) ? Number(s.angle) : tangentAngle;
                    return isOmni
                      ? <OmniHalo key={`${s.id}-${i}`} uid={`${s.id}-${i}`} cx={pt.x} cy={pt.y} color={lightColor} reach={reach * 0.72} intensity={intensity}/>
                      : <LightCone key={`${s.id}-${i}`} uid={`${s.id}-${i}`} cx={pt.x} cy={pt.y} angle={angle} color={lightColor} reach={reach} intensity={intensity}/>;
                  }
                  return (
                    <circle key={`${s.id}-${i}`}
                            cx={pt.x} cy={pt.y}
                            r={vbScale * 22}
                            fill={lightColor}
                            opacity={0.28}/>
                  );
                }))}
              </g>
            )}

            {/* ── Strip paths ── */}
            {strips.map(s => {
              const isSel = s.id === selStripId;
              const isHid = !!hidden[s.id];
              const isMoving = movingStripIds.includes(s.id);
              const stripFrame = layoutPatternFrame.get(s.id);
              // Schematic at rest = warm identity color; only let the (possibly
              // cool) pattern frame tint the strand when light preview is on.
              const stripColor = effectiveShowLight ? rgbCss(stripFrame, s.color) : (s.color || 'var(--accent)');
              // The physical strip RAIL is neutral hardware — decoupled from the
              // LED colour so the lit pixels (warm dots) read as distinct from the
              // rail they sit on. Only the live pattern preview tints the rail.
              const railColor = isHid
                ? 'oklch(40% 0.01 75)'
                : (effectiveShowLight ? stripColor : 'oklch(62% 0.012 75)');
              return (
                <g key={s.id} transform={`translate(${s.x || 0} ${s.y || 0})`}>
                  <path d={s.pathData}
                        data-strip-path={s.id}
                        fill="none"
                        stroke="white"
                        strokeOpacity="0.001"
                        strokeWidth="18"
                        strokeLinecap="round"
                        pointerEvents="visibleStroke"
                        style={{ cursor: isMoving ? 'grabbing' : 'grab' }}
                        onMouseDown={e => {
                          if (wireOverlayMode === 'chop') {
                            e.preventDefault();
                            e.stopPropagation();
                            return;
                          }
                          startStripMove(e, s);
                        }}
                        onClick={e => {
                          e.stopPropagation();
                          if (stripDragSuppressClickRef.current) return;
                          if (wireOverlayMode === 'chop') {
                            chopStripAtEvent(e, s);
                            return;
                          }
                          if (e.shiftKey || e.metaKey || e.ctrlKey) toggleStripSel(s.id);
                          else selectStrip(s.id);
                        }}/>
                  <path d={s.pathData}
                        stroke={railColor}
                        strokeWidth={isSel ? 5 : 3} fill="none"
                        strokeOpacity={isHid ? 0 : isSel ? 0.16 : 0.09}
                        strokeLinecap="round"
                        pointerEvents="none"/>
                  <path d={s.pathData}
                        stroke={railColor}
                        strokeWidth={isSel ? 1.6 : 1} fill="none"
                        pointerEvents="none"
                        opacity={isHid ? 0.25 : isMoving ? 0.95 : isSel ? 0.9 : 0.55}
                        style={{ filter: isSel && !isEditingGesture ? `drop-shadow(0 0 3px ${stripColor})` : 'none' }}/>
                </g>
              );
            })}

            {!isEditingGesture && visibleWirePathCanvasSegments.length > 0 && (
              <g
                className="lw-wire-canvas-segments"
                style={{ pointerEvents: wireOverlayMode === 'link' ? 'auto' : 'none' }}
              >
                {visibleWirePathCanvasSegments.map(segment => (
                  <g key={segment.id}>
                    {wireOverlayMode === 'link' && (
                      <polyline
                        points={pointsAttr(actionablePolylinePoints(segment.points))}
                        className="lw-wire-canvas-segment-hit"
                        onClick={event => {
                          event.stopPropagation();
                          toggleRoutePatch(segment.patchId);
                        }}
                      />
                    )}
                    <polyline
                      points={pointsAttr(segment.points)}
                      className="lw-wire-canvas-segment"
                      style={{ '--wire-color': segment.color }}
                    />
                    {segment.linked && Number.isFinite(segment.order) && (
                      <g className="lw-route-badge">
                        <circle cx={segment.mid.x} cy={segment.mid.y} r={vbScale * 9}/>
                        <text x={segment.mid.x} y={segment.mid.y + vbScale * 3.5} fontSize={vbScale * 8}>
                          {segment.order + 1}
                        </text>
                      </g>
                    )}
                  </g>
                ))}
              </g>
            )}

            {!isEditingGesture && wireRouteJumps.length > 0 && (
              <g className="lw-wire-route-jumps" style={{ pointerEvents: 'none' }}>
                {wireRouteJumps.map(jump => (
                  <line
                    key={jump.id}
                    className="lw-wire-route-jump"
                    x1={jump.from.x}
                    y1={jump.from.y}
                    x2={jump.to.x}
                    y2={jump.to.y}
                  />
                ))}
              </g>
            )}

            {!isEditingGesture && wireCutMarkers.length > 0 && (
              <g className="lw-wire-cut-markers" style={{ pointerEvents: 'none' }}>
                {wireCutMarkers.map(marker => {
                  const notchSize = vbScale * (marker.selected ? 10 : 8);
                  const wing = notchSize * 0.48;
                  return (
                    <g
                      key={marker.id}
                      className={`lw-wire-cut-marker ${marker.selected ? 'selected' : ''}`}
                      transform={`translate(${marker.x} ${marker.y}) rotate(${marker.angle})`}
                      style={{ '--wire-color': marker.color }}
                    >
                      <path
                        className="lw-wire-cut-marker-notch"
                        d={`M 0 ${-notchSize} L 0 ${notchSize} M ${-wing} ${-notchSize * 0.62} L 0 0 L ${-wing} ${notchSize * 0.62}`}
                      />
                    </g>
                  );
                })}
              </g>
            )}

            {/* ── LED dots — dim hardware at rest, bright only when pattern is lit ── */}
            {showLeds && !isEditingGesture && strips.filter(s => !hidden[s.id]).map(s => (
              effectiveGlowMode === 'dots' ? (
	                <g key={s.id + '-dots'} style={{ pointerEvents: 'none' }}>
                  {s.pixels.map((px, i) => {
                    const ledFrame = layoutPatternFrame.get(s.id)?.leds?.[i];
                    const selected = s.id === selStripId;
                    // Warm identity color at rest; pattern-driven tint only when lit.
                    const ledColor = effectiveShowLight ? ledCssColor(ledFrame, s.color || 'oklch(58% 0.04 70)') : (s.color || 'oklch(58% 0.04 70)');
                    // Keep unlit LEDs clearly visible so the strip's pixels are countable at rest.
                    const shellOpacity = Math.max(selected ? 0.85 : 0.62, restingLedAlpha(ledFrame, { selected }));
                    const coreOpacity = activeLedCoreAlpha(ledFrame, { selected });
                    return (
                    <g key={i}>
                      <circle cx={px.x} cy={px.y}
                              r={s.id === selStripId ? vbScale * 5.2 : vbScale * 3.8}
                              fill={ledColor} opacity={shellOpacity}/>
                      {coreOpacity > 0 && (
                        <circle cx={px.x} cy={px.y}
                                r={selected ? vbScale * 2.9 : vbScale * 2.25}
                                fill={ledColor} opacity={coreOpacity}/>
                      )}
                    </g>
                    );
                  })}
                </g>
              ) : (
	                <g key={s.id + '-dots'} filter="url(#lw-led-bloom)" style={{ pointerEvents: 'none' }}>
                  {s.pixels.map((px, i) => {
                    const ledFrame = layoutPatternFrame.get(s.id)?.leds?.[i];
                    const selected = s.id === selStripId;
                    // Warm identity color at rest; pattern-driven tint only when lit.
                    const ledColor = effectiveShowLight ? ledCssColor(ledFrame, s.color || 'oklch(58% 0.04 70)') : (s.color || 'oklch(58% 0.04 70)');
                    const coreOpacity = activeLedCoreAlpha(ledFrame, { selected });
                    const restOpacity = Math.max(selected ? 0.72 : 0.5, restingLedAlpha(ledFrame, { selected }));
                    return (
                    <circle key={i} cx={px.x} cy={px.y}
                            r={s.id === selStripId ? vbScale * 2.8 : vbScale * 2.2}
                            fill={ledColor}
                            opacity={Math.max(coreOpacity * (effectiveGlowMode === 'outward' ? 0.58 : 0.74), restOpacity)}/>
                    );
                  })}
                </g>
              )
            ))}

            {/* ── Strip mid-path labels (selected strip only) ── */}
            {!isEditingGesture && strips.filter(s => !hidden[s.id] && s.pixels?.length > 0 && s.id === selStripId).map(s => {
              const mid = s.pixels[Math.floor(s.pixels.length / 2)];
              return (
                <text key={s.id + '-lbl'}
                      x={mid.x} y={mid.y - vbScale * 14}
                      textAnchor="middle"
                      fill={s.color}
                      fontSize={vbScale * 10}
                      fontFamily="var(--ui-font, monospace)"
                      opacity={1}
                      style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  {s.name} · {s.pixelCount} LEDs
                </text>
              );
            })}

            {/* ── Direction arrows (all visible strips) ── */}
            {!isEditingGesture && strips.filter(s => !hidden[s.id]).map(s => {
              const arrow = stripArrows[s.id];
              if (!arrow) return null;
              const isSel = s.id === selStripId;
              return (
                <g key={s.id + '-arrow'} style={{ pointerEvents: 'none' }} opacity={isSel ? 1 : 0.55}>
                  <polygon
                    points={`${arrow.tip.x},${arrow.tip.y} ${arrow.left.x},${arrow.left.y} ${arrow.right.x},${arrow.right.y}`}
                    fill={s.color} opacity={0.9}/>
                  <circle cx={arrow.start.x} cy={arrow.start.y} r={vbScale * 4} fill="oklch(0.745 0.095 150)" opacity={0.9}/>
                </g>
              );
            })}

            {/* ── Selection frame — mockup clay corner-tick frame (not a blue/green box) ── */}
            {selStripId && !isEditingGesture && (() => {
              const s = strips.find(st => st.id === selStripId);
              if (!s || !s.pixels?.length) return null;
              const xs = s.pixels.map(p => p.x);
              const ys = s.pixels.map(p => p.y);
              const pad = vbScale * 14;
              const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
              const w = (Math.max(...xs) - Math.min(...xs)) + pad * 2;
              const h = (Math.max(...ys) - Math.min(...ys)) + pad * 2;
              const t = Math.min(w, h) * 0.18 || vbScale * 13;
              const corners = [
                [x, y, x + t, y, x, y + t],
                [x + w, y, x + w - t, y, x + w, y + t],
                [x, y + h, x + t, y + h, x, y + h - t],
                [x + w, y + h, x + w - t, y + h, x + w, y + h - t],
              ];
              return (
                <g key="sel-frame" style={{ pointerEvents: 'none' }}>
                  <rect x={x} y={y} width={w} height={h} rx={vbScale * 6} fill="none"
                        stroke="var(--accent-line)" strokeWidth={vbScale} strokeDasharray={`${vbScale * 2} ${vbScale * 5}`}/>
                  {corners.map((c, i) => (
                    <path key={i} d={`M${c[2]} ${c[3]} L${c[0]} ${c[1]} L${c[4]} ${c[5]}`} fill="none"
                          stroke="var(--accent)" strokeWidth={vbScale * 2} strokeLinecap="round"/>
                  ))}
                </g>
              );
            })()}

            {/* ── Head/tail connectors on selected strip ── */}
            {selStripId && (() => {
              const s = strips.find(st => st.id === selStripId);
              if (!s || !s.pixels?.length) return null;
              const first = s.pixels[0];
              const last  = s.pixels[s.pixels.length - 1];
              return (
                <g key="strip-connectors" style={{ pointerEvents: 'none' }}>
                  <circle cx={first.x} cy={first.y} r={vbScale * 5}  fill="oklch(0.745 0.095 150)" opacity={0.95}/>
                  <circle cx={first.x} cy={first.y} r={vbScale * 9}  fill="none" stroke="oklch(0.745 0.095 150)" strokeWidth={1.5} opacity={0.35}/>
                  <circle cx={last.x}  cy={last.y}  r={vbScale * 7}  fill="none" stroke="oklch(0.800 0.130 72)" strokeWidth={2} opacity={0.9}/>
                  <circle cx={last.x}  cy={last.y}  r={vbScale * 11} fill="none" stroke="oklch(0.800 0.130 72)" strokeWidth={1} opacity={0.3}/>
                </g>
              );
            })()}

            {/* ── Draw mode ghost ── */}
            {drawMode && ghostD && (
              <path d={ghostD} stroke="oklch(0.615 0.112 57)" strokeWidth="1.5" fill="none"
                    strokeDasharray="5 3" strokeLinecap="round" pointerEvents="none"/>
            )}
            {drawMode && waypoints.map((pt, i) => (
              <circle key={i} cx={pt.x} cy={pt.y} r={vbScale * 4} fill="oklch(0.615 0.112 57)"
                      opacity={0.9} pointerEvents="none"/>
            ))}
            {/* Draw cursor dot before first waypoint */}
            {drawMode && ghostPt && waypoints.length === 0 && (
              <circle cx={ghostPt.x} cy={ghostPt.y} r={vbScale * 3}
                      fill="oklch(0.615 0.112 57)" opacity={0.5} pointerEvents="none"/>
            )}

            {/* ── Empty state ── */}
            {!svgText && strips.length === 0 && (
              <>
                <rect x="1" y="1" width="638" height="398" rx="4" fill="none"
                      stroke="oklch(30% 0.01 75)" strokeDasharray="6 4"/>
                <text x="320" y="185" textAnchor="middle" fill="oklch(55% 0.04 70)"
                      fontSize="14" fontFamily="var(--ui-font)">
                  Drop an SVG or click Import SVG
                </text>
                <text x="320" y="205" textAnchor="middle" fill="oklch(48% 0.03 70)"
                      fontSize="11" fontFamily="var(--ui-font)">
                  Illustrator: File → Export As → SVG (layers preserved)
                </text>
                <text x="320" y="222" textAnchor="middle" fill="oklch(42% 0.025 70)"
                      fontSize="10" fontFamily="var(--ui-font)">
                  Drag and drop supported
                </text>
              </>
            )}
          </svg>

          {/* ── Rubber-band lasso overlay (absolute inside viewport — position:fixed breaks with backdrop-filter ancestors) ── */}
          {rubberBand && (
            <div style={{
              position: 'absolute',
              left:   Math.min(rubberBand.x1, rubberBand.x2),
              top:    Math.min(rubberBand.y1, rubberBand.y2),
              width:  Math.abs(rubberBand.x2 - rubberBand.x1),
              height: Math.abs(rubberBand.y2 - rubberBand.y1),
              border: '1px dashed var(--accent)',
              background: 'var(--accent-soft)',
              pointerEvents: 'none',
              zIndex: 9999,
              userSelect: 'none',
            }}/>
          )}
        </div>
        </div>{/* .stage */}

        {/* ── Canvas corner readouts (mockup .la-overlay) ── */}
        <div className="la-overlay tl">
          <div><span className="k">artwork</span><span className="v">{parsedVb(viewBox).w} × {parsedVb(viewBox).h}</span></div>
          <div><span className="k">layers</span><span className="v">{layers.length} · {strips.length} strips</span></div>
          <div><span className="k">leds</span><span className="v">{totalLeds.toLocaleString()}</span></div>
        </div>
        <div className="la-overlay br">
          <div><span className="k">emit</span><span className="v">{existingStrip ? (existingStrip.emit === 'omni' ? 'omni' : `dir ${existingStrip.angle || 0}°`) : '—'}</span></div>
          {cursorSvgPt && (
            <div><span className="k">cursor</span><span className="v">{cursorSvgPt.x.toFixed(0)} · {cursorSvgPt.y.toFixed(0)}</span></div>
          )}
          <div><span className="k">zoom</span><span className="v">{Math.round(zoom * 100)}%</span></div>
        </div>
      </main>{/* .body */}

      {/* ── Right panel (mockup .side) ─────────────────────────────── */}
      <aside className="side">

        {error && (
          <div className="la-error-banner">
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {/* Draw mode hint */}
        {drawMode && (
          <div className="la-draw-hint">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <strong style={{ color: 'var(--text-hi)' }}>Drawing mode</strong>
              <button style={{ fontSize: 11, color: 'var(--accent)', padding: '0 4px' }}
                      onClick={() => { setDrawMode(false); setWaypoints([]); setGhostPt(null); }}>
                Cancel (Esc)
              </button>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-faint)', display: 'block' }}>
              {waypoints.length} point{waypoints.length !== 1 ? 's' : ''}
              {waypoints.length >= 2 && ` · ~${drawEstimatedLeds} LEDs · double-click to finish`}
              {waypoints.length < 2 && ' · click to place, ⌫ undo, right-click cancel'}
            </span>
          </div>
        )}

        {/* Pending draw naming panel */}
        {pendingDraw && (
          <div className="la-pending">
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', marginBottom: 8 }}>
              Name your new strip
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                ref={pendingDrawNameRef}
                type="text"
                value={pendingDrawName}
                onChange={e => setPendingDrawName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmDraw(); if (e.key === 'Escape') cancelDraw(); }}
                placeholder="Strip name…"
                autoFocus
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ color: 'var(--text-mid)', width: 72, flexShrink: 0 }}>LED count</span>
                <input className="lw" type="range" min={LED_COUNT_SLIDER_MIN} max={LED_COUNT_SLIDER_MAX} step="1"
                       value={ledCountToSliderValue(pendingDrawCount)}
                       aria-label="New strip LED count slider"
                       onChange={e => setPendingDrawCount(sliderValueToLedCount(e.target.value))}
                       style={{ flex: 1, minWidth: 0 }}/>
                <input type="number" min="1" max={LED_COUNT_MAX}
                       value={pendingDrawCount}
                       aria-label="New strip LED count"
                       inputMode="numeric"
                       onFocus={e => e.target.select()}
                       onChange={e => setPendingDrawCount(clampLedCount(e.target.value))}/>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={confirmDraw}>
                  + Add Strip
                </button>
                <button className="btn" onClick={cancelDraw}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Layer list ── */}
        {layers.length > 0 && (
          <>
            <div className="panel-head">
              <span className="ttl">Artwork layers</span>
              <div className="la-head-tools">
                <span className="meta">{layers.length} · {totalLeds.toLocaleString()} LEDs</span>
                <button title="Show all layers"
                        onClick={() => setHidden(h => { const n={...h}; layers.forEach(l=>{n[l.layerId]=false;}); return n; })}>
                  <EyeIcon/>
                </button>
                <button title="Hide all layers"
                        onClick={() => setHidden(h => { const n={...h}; layers.forEach(l=>{n[l.layerId]=true;}); return n; })}>
                  <EyeOffIcon/>
                </button>
              </div>
            </div>

            <div className="layers" style={{ overflow: 'auto', flex: '0 0 auto', maxHeight: '42%' }}>
              {/* Build ordered list: groups + layers in layerOrder, fallback to layers */}
              {(() => {
                const ordered = layerOrder.length > 0
                  ? layerOrder
                  : layers.map(l => ({ type: 'layer', id: l.layerId }));

                return ordered.map(item => {
                  // ── Group row ──
                  if (item.type === 'group') {
                    const group = layerGroups.find(g => g.groupId === item.id);
                    if (!group) return null;
	                    const isGroupHidden = !!group._hidden;
	                    const isStripGroup = group.type === 'strip';
	                    const isDragTarget = layerDragOver === group.groupId;
	                    return (
                      <div key={group.groupId}
                           draggable
                           onDragStart={e => {
                             if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
                             e.dataTransfer.effectAllowed='move';
                             setLayerDragging(group.groupId);
                           }}
	                           onDragOver={e => {
	                             e.preventDefault();
	                             if (isStripGroup && Array.from(e.dataTransfer.types).includes('application/x-lightweaver-strip')) {
	                               setStripGroupDragOver(group.groupId);
	                             } else if (!isStripGroup && Array.from(e.dataTransfer.types).includes('application/x-lightweaver-path')) {
	                               setLayerDragOver(group.groupId);
	                             } else {
	                               setLayerDragOver(group.groupId);
	                             }
	                           }}
	                           onDrop={e => {
	                             e.preventDefault();
	                             const draggedStripIds = readDraggedStripIds(e);
	                             const draggedPaths = readDraggedPathEntries(e);
	                             if (isStripGroup && draggedStripIds.length) addStripsToGroup(group.groupId, draggedStripIds);
	                             else if (!isStripGroup && draggedPaths.length) addPathsToGroup(group.groupId, draggedPaths);
	                             else if (layerDragging) reorderLayerOrder(layerDragging, group.groupId);
                             setLayerDragging(null);
                             setLayerDragOver(null);
                             setStripGroupDragOver(null);
                           }}
                           onDragLeave={() => setStripGroupDragOver(null)}
                           onDragEnd={() => { setLayerDragging(null); setLayerDragOver(null); setStripGroupDragOver(null); }}>
	                        <div className="la-group-row"
	                             style={{ background: stripGroupDragOver === group.groupId ? 'color-mix(in oklab, var(--accent) 16%, transparent)' : isDragTarget ? 'var(--accent-soft)' : undefined,
	                                      opacity: isGroupHidden ? 0.45 : 1 }}>
                          <span data-drag-handle="true" className="la-grip"><DragHandleIcon/></span>
                          <button onClick={e => { e.stopPropagation(); toggleGroupHidden(group.groupId); }}>
                            {isGroupHidden ? <EyeOffIcon/> : <EyeIcon/>}
                          </button>
                          <button onClick={e => { e.stopPropagation(); toggleGroupExpanded(group.groupId); }}>
                            {group._expanded ? <ChevronDownIcon/> : <ChevronRightIcon/>}
                          </button>
                          <span style={{ color: 'var(--accent)', display:'flex', alignItems:'center' }}><GroupIcon/></span>
	                          <InlineRename value={group.name} onCommit={n => renameGroup(group.groupId, n)}
	                                        className="nm"/>
	                          <span className="ct">
	                            {group.members.length}{isStripGroup ? 's' : 'p'}
	                          </span>
                          <button title="Ungroup" onClick={e => { e.stopPropagation(); deleteLayerGroup(group.groupId); }}>⊠</button>
                        </div>
	                        {group._expanded && group.members.map((m, mi) => {
	                          const memberId = m.stripId || m.pathId;
	                          const memberHidden = !!hidden[memberId];
	                          return (
	                          <div key={memberId} className="la-subrow"
	                               style={{ cursor: isStripGroup ? 'pointer' : 'default' }}
	                               onClick={() => { if (isStripGroup) selectStrip(memberId); }}>
	                            <span className="n">{mi+1}</span>
	                            <button className="la-eye" style={{ opacity: 1 }}
	                                    onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [memberId]: !h[memberId] })); }}>
	                              {memberHidden ? <EyeOffIcon/> : <EyeIcon/>}
	                            </button>
	                            {isStripGroup && (
	                              <span className="layer-swatch" style={{ background: m.color || 'var(--accent)' }}/>
	                            )}
	                            <span className="nm">{m.name}</span>
	                            {isStripGroup ? (
	                              <span className="len">{(m.pixelCount || 0).toLocaleString()}px</span>
	                            ) : m.svgLength > 0 && (
	                              <span className="len">{Math.round(m.svgLength / pxPerMm)}mm</span>
	                            )}
	                            <button className="add" style={{ color: 'var(--text-faint)' }}
	                                    onClick={e => {
	                                      e.stopPropagation();
	                                      setLayerGroups(prev => prev
	                                        .map(g => g.groupId !== group.groupId ? g : { ...g, members: g.members.filter((_,i)=>i!==mi) })
	                                        .filter(g => g.members.length > 0));
	                                    }}>✕</button>
	                          </div>
	                          );
	                        })}
                      </div>
                    );
                  }

                  // ── Layer row ──
                  const l = layers.find(lyr => lyr.layerId === item.id);
                  if (!l) return null;
                  const isHidden   = !!hidden[l.layerId];
                  const hasStrip   = strips.some(s => stripSourceKey(s) === l.layerId);
                  const isSel      = l.layerId === selLayerId;
                  const canExpand  = l.subPaths?.length > 1;
                  const isExpanded = !!expandedLayers[l.layerId];
                  const stripForLayer = strips.find(s => stripSourceKey(s) === l.layerId);
                  const isDragTarget  = layerDragOver === l.layerId;

                  return (
	                    <div key={l.layerId}
	                         draggable
	                         onDragStart={e => {
	                           if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
	                           e.dataTransfer.effectAllowed='move';
	                           e.dataTransfer.setData('application/x-lightweaver-path', JSON.stringify([{
	                             layerId: l.layerId,
	                             pathId: l.layerId,
	                             pathData: l.pathData,
	                             name: l.name,
	                             svgLength: l.svgLength,
	                           }]));
	                           setLayerDragging(l.layerId);
	                         }}
                         onDragOver={e => { e.preventDefault(); setLayerDragOver(l.layerId); }}
                         onDrop={e => { e.preventDefault(); if (layerDragging) reorderLayerOrder(layerDragging, l.layerId); setLayerDragging(null); setLayerDragOver(null); }}
                         onDragEnd={() => { setLayerDragging(null); setLayerDragOver(null); }}>
                      <div className={`layer-row${isSel?' sel':''}${isHidden?' hidden':''}`}
                           style={{ borderTop: isDragTarget ? '2px solid var(--accent)' : undefined }}
                           onClick={() => selectLayer(l.layerId)}
                           onMouseEnter={() => setHoveredLayerId(l.layerId)}
                           onMouseLeave={() => setHoveredLayerId(null)}>
                        <span data-drag-handle="true" className="la-grip">
                          <DragHandleIcon/>
                        </span>
                        <button className="la-eye" title={isHidden?'Show':'Hide'}
                                onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [l.layerId]: !h[l.layerId] })); }}>
                          {isHidden ? <EyeOffIcon/> : <EyeIcon/>}
                        </button>
                        {canExpand
                          ? <button className="la-eye" title={isExpanded?'Collapse':'Expand'}
                                    onClick={e => { e.stopPropagation(); setExpandedLayers(ex => ({ ...ex, [l.layerId]: !ex[l.layerId] })); }}
                                    style={{ opacity: 1 }}>
                              {isExpanded ? <ChevronDownIcon/> : <ChevronRightIcon/>}
                            </button>
                          : <span style={{ width:16, flexShrink:0 }}/>
                        }
                        <span className="layer-swatch" style={{ background: l._color }}/>
                        <InlineRename value={l.name} onCommit={n => renameLayer(l.layerId, n)}
                                      className="layer-name"/>
                        {hasStrip && (
                          <span className="la-stripdot" title="Select LED strip" style={{ cursor: 'pointer' }}
                                onClick={e => { e.stopPropagation(); if (stripForLayer) selectStrip(stripForLayer.id); }}/>
                        )}
                        {canExpand && (
                          <span style={{ fontSize:10, color:'var(--text-faint)', fontFamily:'var(--font-mono)', flexShrink:0 }}>
                            {l.subPaths.length}p
                          </span>
                        )}
                        {l.svgLength > 0 && (
                          <span className="layer-len">{Math.round(l.svgLength / pxPerMm)}mm</span>
                        )}
                        <button className="la-del" title="Delete layer"
                                onClick={e => { e.stopPropagation(); deleteLayer(l.layerId); }}>×</button>
                      </div>

	                      {isExpanded && l.subPaths?.map(sp => {
	                        const spHidden = !!hidden[sp.pathId];
	                        const spSel    = pathSel.some(p => p.pathId === sp.pathId);
	                        const entry = { layerId: l.layerId, pathId: sp.pathId, pathData: sp.pathData, name: `${l.name} · ${sp.name}`, svgLength: sp.svgLength };
	                        return (
	                          <div key={sp.pathId}
	                               draggable
	                               className={`la-subrow${spSel ? ' sel' : ''}`}
	                               onClick={e => togglePathSelection(entry, e.shiftKey || e.metaKey || e.ctrlKey)}
	                               onDragStart={e => {
	                                 if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
	                                 const payload = spSel && pathSel.length > 0 ? pathSel : [entry];
	                                 e.dataTransfer.effectAllowed = 'move';
	                                 e.dataTransfer.setData('application/x-lightweaver-path', JSON.stringify(payload));
	                                 e.dataTransfer.setData('text/plain', payload.map(p => p.name).join(', '));
	                                 if (!spSel) selectPaths([entry]);
	                               }}
	                               onDragOver={e => {
	                                 if (!Array.from(e.dataTransfer.types).includes('application/x-lightweaver-path')) return;
	                                 e.preventDefault();
	                                 setLayerDragOver(sp.pathId);
	                               }}
	                               onDragLeave={() => setLayerDragOver(null)}
	                               onDrop={e => {
	                                 const draggedPaths = readDraggedPathEntries(e);
	                                 if (!draggedPaths.length) return;
	                                 e.preventDefault();
	                                 e.stopPropagation();
	                                 createLayerGroupFromEntries([...draggedPaths, entry]);
	                                 setLayerDragOver(null);
	                               }}
	                               onMouseEnter={() => setHoveredSubPathId(sp.pathId)}
	                               onMouseLeave={() => setHoveredSubPathId(null)}>
	                            <span data-drag-handle="true" className="la-grip" style={{ color: spSel ? 'var(--accent)' : 'var(--text-faint)', flexShrink: 0 }}>
	                              <DragHandleIcon/>
	                            </span>
	                            <button className="la-eye" style={{ opacity: 1 }}
	                                    onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [sp.pathId]: !h[sp.pathId] })); }}>
	                              {spHidden ? <EyeOffIcon/> : <EyeIcon/>}
	                            </button>
                            <InlineRename value={sp.name} onCommit={n => renameSubPath(l.layerId, sp.pathId, n)}
                                          className="nm" style={{ color: spHidden ? 'var(--text-faint)' : 'var(--text-mid)' }}/>
                            <span className="len">
                              {sp.svgLength > 0 ? `${Math.round(sp.svgLength / pxPerMm)}mm` : ''}
                            </span>
                            <button className="add"
                                    onClick={e => { e.stopPropagation(); addSubPathStrip(sp, l); }}>+</button>
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()}

	              <div className="la-hint">
	                Click rows to select · <strong>⇧/⌘ click</strong> adds · drag rows into groups
	              </div>
            </div>
          </>
        )}

        {/* ── Path selection panel (mockup .la-pathsel) ── */}
        {pathSel.length > 0 && (
          <div className="la-pathsel">
            <div className="la-sub-h">
              <span>{pathSel.length} path{pathSel.length > 1 ? 's' : ''} selected</span>
              <button className="meta" style={{ color: 'var(--text-faint)' }}
                      onClick={clearLayoutSelection}>✕</button>
            </div>
            <div style={{ maxHeight: 80, overflow: 'auto', marginBottom: 8 }}>
              {pathSel.map((p, i) => (
                <div key={p.pathId} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12,
                                              color: 'var(--text-mid)', padding: '2px 0' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent)',
                                 fontWeight: 'bold', width: 14, flexShrink: 0, textAlign: 'center' }}>{i + 1}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  {p.svgLength > 0 && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, flexShrink: 0, color: 'var(--text-faint)' }}>
                      {Math.round(p.svgLength / pxPerMm)}mm
                    </span>
                  )}
                  <button disabled={i === 0} style={{ fontSize: 11, padding: '0 3px', color: 'var(--text-faint)', opacity: i === 0 ? 0.3 : 1 }}
                          onClick={() => {
                            const a = [...pathSel]; [a[i-1], a[i]] = [a[i], a[i-1]];
                            selectPaths(a);
                            if (pathSelName) renameLayoutSelection(pathSelName); // keep the typed name across reorders
                          }}>↑</button>
                  <button disabled={i === pathSel.length - 1} style={{ fontSize: 11, padding: '0 3px', color: 'var(--text-faint)', opacity: i === pathSel.length - 1 ? 0.3 : 1 }}
                          onClick={() => {
                            const a = [...pathSel]; [a[i], a[i+1]] = [a[i+1], a[i]];
                            selectPaths(a);
                            if (pathSelName) renameLayoutSelection(pathSelName); // keep the typed name across reorders
                          }}>↓</button>
                  <button style={{ fontSize: 12, padding: '0 4px', color: 'var(--text-faint)' }}
                          onClick={() => {
                            const next = pathSel.filter((_, j) => j !== i);
                            selectPaths(next);
                            // Dropping to one path auto-names after it (reducer);
                            // otherwise keep whatever the user typed.
                            if (next.length > 1 && pathSelName) renameLayoutSelection(pathSelName);
                          }}>✕</button>
                </div>
              ))}
            </div>
            <input type="text" className="pm-input" style={{ height: 30, marginBottom: 8 }}
                   value={pathSelName} onChange={e => renameLayoutSelection(e.target.value)}
                   placeholder="Name…"/>
            <div className="la-merge">
              <button className="btn primary" style={{ flex: 1 }}
                      title="Create one composite strip from the selected paths"
                      onClick={() => addSelectedPathsAsStrips('merged')}>
                Merge strip
              </button>
              {pathSel.length >= 2 && (
                <>
                  <button className="btn"
                          title="Create separate LED strips from the selected paths"
                          onClick={() => addSelectedPathsAsStrips('separate')}>
                    Separate
                  </button>
                  <button className="btn"
                          title="Create separate LED strips and place them in one strip group"
                          onClick={() => addSelectedPathsAsStrips('grouped')}>
                    Strip group
                  </button>
                </>
              )}
            </div>
            {pathSel.length >= 2 && (
              <button className="btn ghost-sm" style={{ width: '100%', marginTop: 6, justifyContent: 'center' }}
                      title="Group the source artwork paths without creating LED strips"
                      onClick={createLayerGroup}>
                Layer group
              </button>
            )}
          </div>
        )}

        {/* ── Layer inspector (mockup .inspector) ── */}
        {selLayer && (() => {
          const isOmni = existingStrip?.emit === 'omni';
          const ledVal = editCounts[selLayer.layerId] ?? getLedCount(selLayer);
          const pitch = (selLayer.svgLength > 0 && ledVal > 1)
            ? ((selLayer.svgLength / pxPerMm) / ledVal).toFixed(1) : '—';
          return (
          <>
          <div className="panel-divider"/>
          <div className="inspector">
            <div className="insp-head">
              <span className="sw" style={{ background: selLayer._color }}/>
              <span className="nm">{selLayer.name}</span>
              <span className="tag">Inspector</span>
            </div>
            <div className="insp-body">
              <div className="field">
                <span className="k">Length</span>
                <span className="v"><span className="inspector-value">{selLayer.svgLength > 0 ? Math.round(selLayer.svgLength / pxPerMm) : '—'}<span className="u">mm</span></span></span>
              </div>
              {selLayer.subPaths?.length > 1 && (
                <div className="field">
                  <span className="k">Sub-paths</span>
                  <span className="v"><span className="inspector-value">{selLayer.subPaths.length}</span></span>
                </div>
              )}
              <div className="field">
                <span className="k">Density</span>
                <span className="v">
                  <div className="mini-seg">
                    {DENSITY_OPTIONS.map(d => (
                      <button key={d} className={density === d ? 'on' : ''} onClick={() => handleDensityChange(d)}>{d}</button>
                    ))}
                  </div>
                </span>
              </div>
              <div className="field-sep"/>

              {/* LED count — slider + number (live resample) */}
              <div className="la-ledrow">
                <span className="k">LED count</span>
                <div className="la-ledctrl">
                  {editCounts[selLayer.layerId] != null && (
                    <button style={{ color: 'var(--text-faint)', padding: '0 3px' }} title="Reset to calculated"
                            onClick={() => setEditCounts(c => { const next = { ...c }; delete next[selLayer.layerId]; return next; })}>↺</button>
                  )}
                  <input className="lw" type="range" min={LED_COUNT_SLIDER_MIN} max={LED_COUNT_SLIDER_MAX} step="1"
                         value={ledCountToSliderValue(ledVal)}
                         aria-label="Layer LED count slider"
                         onChange={e => {
                           const val = sliderValueToLedCount(e.target.value);
                           setEditCounts(c => ({ ...c, [selLayer.layerId]: val }));
                           if (existingStrip) resampleStrip(existingStrip.id, val);
                         }}/>
                  <input className="num-input" type="number" min="1" max={LED_COUNT_MAX}
                         value={ledVal}
                         aria-label="Layer LED count"
                         inputMode="numeric"
                         onFocus={e => e.target.select()}
                         onChange={e => {
                           const val = clampLedCount(e.target.value);
                           setEditCounts(c => ({ ...c, [selLayer.layerId]: val }));
                           if (existingStrip) resampleStrip(existingStrip.id, val);
                         }}
                         onBlur={() => { if (existingStrip) resampleStrip(existingStrip.id, getLedCount(selLayer)); }}
                         onKeyDown={e => {
                           if (e.key === 'Enter') {
                             if (existingStrip) resampleStrip(existingStrip.id, getLedCount(selLayer));
                             else addStrip();
                           }
                         }}
                         style={{ borderColor: editCounts[selLayer.layerId] != null ? 'var(--accent)' : undefined }}/>
                </div>
              </div>
              <div className="field">
                <span className="k">Pitch</span>
                <span className="v"><span className="inspector-value">{pitch}<span className="u">mm/LED</span></span></span>
              </div>
              <div className="field-sep"/>

              {/* Emit — Omni / Directed */}
              <div className="field" style={{ opacity: existingStrip ? 1 : 0.5 }}>
                <span className="k">Emit</span>
                <span className="v">
                  <div className="mini-seg">
                    <button className={isOmni ? 'on' : ''} disabled={!existingStrip}
                            title={existingStrip ? 'Omnidirectional glow' : 'Add strip first'}
                            onClick={() => { if (existingStrip) updateStrip(existingStrip.id, { emit: 'omni', angle: 0 }); }}>Omni</button>
                    <button className={existingStrip && !isOmni ? 'on' : ''} disabled={!existingStrip}
                            title={existingStrip ? 'Directed emission' : 'Add strip first'}
                            onClick={() => {
                              if (!existingStrip) return;
                              setDirectedGlow(true); enableLightPreview();
                              updateStrip(existingStrip.id, { emit: 'dir' });
                            }}>Directed</button>
                  </div>
                </span>
              </div>

              {/* Compass — directed angle dial */}
              <EmitCompass
                angle={existingStrip?.angle || 0}
                omni={isOmni || !existingStrip}
                setAngle={a => {
                  if (!existingStrip) return;
                  setDirectedGlow(true); enableLightPreview();
                  updateStrip(existingStrip.id, { angle: a });
                }}/>

              <div className="field-sep"/>

              {/* Color tag */}
              <div className="field">
                <span className="k">Color tag</span>
                <span className="v">
                  <div className="la-tags">
                    {STRIP_COLORS.slice(0, 5).map(c => (
                      <button key={c} className={`la-tag${selLayer._color === c ? ' on' : ''}`}
                              style={{ background: c }}
                              title="Set layer color"
                              onClick={() => {
                                setLayers(prev => prev.map(l => l.layerId === selLayer.layerId ? { ...l, _color: c } : l));
                                if (existingStrip) updateStrip(existingStrip.id, { color: c });
                              }}/>
                    ))}
                  </div>
                </span>
              </div>

              {/* Brightness */}
              {existingStrip && (
                <div className="slider-row" style={{ marginTop: 6 }}>
                  <div className="lab">
                    <span className="k">Brightness</span>
                    <span className="v">{Math.round((existingStrip.brightness ?? 1) * 100)}%</span>
                  </div>
                  <input className="lw" type="range" min="0" max="100"
                         value={Math.round((existingStrip.brightness ?? 1) * 100)}
                         aria-label="Strip brightness"
                         onChange={e => updateStrip(existingStrip.id, { brightness: parseInt(e.target.value, 10) / 100 })}/>
                </div>
              )}

              {/* Add / Update CTA */}
              {existingStrip
                ? <button className="insp-cta" style={{ color: 'var(--ok)', borderColor: 'color-mix(in oklch, var(--ok) 40%, var(--border))' }}
                          onClick={addStrip} title="Re-sample this strip with current settings">{TbIcon.check}Strip added · update</button>
                : <button className="insp-cta" onClick={addStrip}>{TbIcon.strip}Add as strip</button>}

              {existingStrip && (
                <div className="la-insp-actions">
                  <button className="btn" onClick={() => reverseStrip(existingStrip.id)} title="Flip pixel 0 from start to end">↔ Reverse</button>
                  <button className="btn danger" onClick={() => removeStrip(existingStrip.id)}>Remove</button>
                </div>
              )}
            </div>
          </div>
          </>
          );
        })()}

        {/* ── Strips list ── */}
        {strips.length > 0 && (
	          <>
	            <div className="panel-divider"/>
	            <div className="panel-head">
	              <span className="ttl">LED strips</span>
	              <span className="meta">
	                {selectedStrips.length > 1 ? `${selectedStrips.length} sel · ` : ''}
	                {strips.length} · {totalLeds.toLocaleString()} LEDs · wiring order
	              </span>
	            </div>
	            {selectedStrips.length > 1 && (
	              <div className="la-batch">
	                <div className="la-batch-head">
	                  <span>{selectedStrips.length} strips selected</span>
	                  <button title="Clear strip selection" onClick={clearLayoutSelection}>✕</button>
	                </div>
	                <div className="la-batch-list">
	                  {selectedStrips.map((s, i) => (
	                    <span key={s.id} className="la-batch-chip" title={s.name}>
	                      <span className="layer-swatch" style={{ background: s.color, width: 8, height: 8 }}/>
	                      {i + 1}. {s.name}
	                    </span>
	                  ))}
	                </div>
	                <div className="la-batch-actions">
	                  <input
	                    type="text"
	                    value={stripSelectionName}
	                    onChange={e => renameLayoutSelection(e.target.value)}
	                    placeholder="Group or merged strip name..."
	                  />
	                  <button className="btn" title="Organize selected strips as one expandable group (G)" onClick={groupSelectedStrips}>
	                    <GroupIcon/> Group
	                  </button>
	                  <button className="btn primary" title="Paste selected strips into one composite strip (M)" onClick={mergeSelectedStrips}>
	                    Merge
	                  </button>
	                </div>
	              </div>
	            )}
	            <div ref={stripListRef} className="layers" style={{ flex: '0 0 auto', minHeight: 0, paddingBottom: 4 }}>
	              {/* List order = chain order; the row badge is the strip's chain position. */}
	              {orderedStrips.map((s, i) => {
	                const isSel = s.id === selStripId;
	                const isBatchSel = selectedStripIds.includes(s.id);
	                const isOpen = !!expandedStrips[s.id];
	                return (
	                  <div key={s.id} data-strip-id={s.id}>
	                  <div
	                       className={`la-strip-row${isSel ? ' sel' : ''}`}
	                       draggable
	                       onDragStart={e => {
	                         if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
	                         const ids = selectedStripIds.includes(s.id) ? selectedStripIds : [s.id];
	                         e.dataTransfer.effectAllowed = 'move';
	                         e.dataTransfer.setData('application/x-lightweaver-strip', JSON.stringify(ids));
	                         e.dataTransfer.setData('text/plain', ids.join(','));
	                         // Do NOT setState here — re-rendering the row during dragstart
	                         // cancels the native HTML5 drag. The ids ride in dataTransfer.
	                       }}
	                       onDragOver={e => {
	                         if (!Array.from(e.dataTransfer.types).includes('application/x-lightweaver-strip')) return;
	                         e.preventDefault();
	                         setStripGroupDragOver(`strip:${s.id}`);
	                       }}
	                       onDragLeave={() => setStripGroupDragOver(null)}
	                       onDrop={e => {
	                         const draggedStripIds = readDraggedStripIds(e);
	                         if (!draggedStripIds.length) return;
	                         e.preventDefault();
	                         e.stopPropagation();
	                         reorderStripRows(draggedStripIds, s.id);
	                         setStripGroupDragOver(null);
	                       }}
	                       onDragEnd={() => setStripGroupDragOver(null)}
	                       style={{ opacity: hidden[s.id] ? 0.4 : 1,
	                                outline: stripGroupDragOver === `strip:${s.id}` ? '1px solid var(--accent)' : undefined,
	                                outlineOffset: -1 }}
	                       onClick={e => {
	                         if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleStripSel(s.id); return; }
	                         selectStrip(s.id);
	                         setExpandedStrips(ex => ({ ...ex, [s.id]: !ex[s.id] }));
	                       }}>
	                      <span data-drag-handle="true" className="la-wire-n" title="Drag to reorder" style={{ flexShrink: 0, cursor: 'grab', color: isBatchSel ? 'var(--accent)' : undefined }}>{String(i + 1).padStart(2, '0')}</span>
                      <span className="layer-swatch" style={{ borderRadius: '50%', background: s.color,
                                     boxShadow: isSel ? `0 0 8px ${s.color}` : undefined }}/>
                      <InlineRename value={s.name} onCommit={n => renameStrip(s.id, n)}
                                    className="layer-name" style={{ cursor: 'pointer', flex: 1, minWidth: 0 }}/>
                      {s.reversed && <span className="la-strip-rev">REV</span>}
                      <span className="layer-len">{s.pixelCount} px</span>
                    </div>
                    {isOpen && (
                      <div className="la-strip-detail" onClick={e => e.stopPropagation()}>
	                        <div className="hint">Drag on canvas to move · click, then arrow keys to nudge (Shift = ×10).</div>
                        {/* LED count */}
                        <div className="row">
                          <span className="k">LEDs</span>
                          <input className="lw" type="range" min={LED_COUNT_SLIDER_MIN} max={LED_COUNT_SLIDER_MAX} step="1"
                                 value={ledCountToSliderValue(s.pixelCount)}
                                 aria-label="Strip LED count slider"
                                 onChange={e => resampleStrip(s.id, sliderValueToLedCount(e.target.value))}/>
                          <input type="number" min="1" max={LED_COUNT_MAX} step="1"
                                 value={s.pixelCount}
                                 aria-label="Strip LED count"
                                 inputMode="numeric"
                                 style={{ width: 72 }}
                                 onFocus={e => e.target.select()}
                                 onChange={e => resampleStrip(s.id, clampLedCount(e.target.value))}
                                 onBlur={e => resampleStrip(s.id, clampLedCount(e.target.value))}
                                 onKeyDown={e => { if (e.key === 'Enter') resampleStrip(s.id, clampLedCount(e.target.value)); }}/>
                          <button className="btn" style={{ padding: '0 6px' }}
                                  title="I physically counted this strip's LEDs — set this count as ground truth and calibrate the overall scale to match."
                                  onClick={() => calibrateScaleFromStrip(s.id, s.pixelCount)}>Set real count</button>
                        </div>
                        {usbLedConnected && (
                          <div className="hint" style={{ color: s.pixelCount > usbLedMaxPixels ? 'var(--accent)' : 'var(--text-faint)' }}>
                            USB direct cap {usbLedMaxPixels} LEDs.
                          </div>
                        )}
                        {/* Strip actions */}
                        <div className="actions">
                          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                                  onClick={() => reverseStrip(s.id)}>
                            ↔ Reverse
                          </button>
                          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                                  onClick={() => setHidden(h => ({ ...h, [s.id]: !h[s.id] }))}>
                            {hidden[s.id] ? 'Show' : 'Hide'}
                          </button>
                          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                                  onClick={() => duplicateStrip(s.id)}>
                            Duplicate
                          </button>
                          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                                  onClick={() => removeStrip(s.id)}>
                            Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
	              })}
	            </div>
              {defaultCircleLayoutActive && (
                <div
                  data-testid="default-circle-layout-panel"
                  style={{ margin: '2px 12px 8px', fontSize: 'var(--fs-xs)', color: 'var(--text-faint)', lineHeight: 1.45 }}
                >
                  <strong style={{ fontWeight: 500, color: 'var(--text-3)', letterSpacing: 0 }}>Default two-circle hardware</strong>
                  {' '}— starter layout; import an SVG or open a project to replace it.
                </div>
              )}
	          </>
        )}

        {strips.length > 0 && (() => {
          const wireStrips = strips.filter(st => !hidden[st.id]);
          return (
          <>
            <div className="panel-divider"/>
            {/* Live wire editor — chop / link / route order (function preserved) */}
            <details className="la-wire-editor">
              <summary>
                <span className="ttl">Advanced</span>
                <span className="meta">split a strip into runs</span>
              </summary>
              <PatchBoardScreen
                embedded
                wireOverlayMode={wireOverlayMode}
                selectedWireCut={selectedWireCut}
                onNudgeSelectedCut={nudgeSelectedWireCut}
                onDeleteSelectedCut={deleteSelectedWireCut}
                onClearSelectedCut={() => setSelectedWireCut(null)}
              />
            </details>
          </>
          );
        })()}

        {/* ── Empty state ── */}
        {!svgText && !error && !defaultCircleLayoutActive && (
          <div className="la-empty">
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="6" y="4" width="32" height="36" rx="3"/>
              <path d="M14 14h16M14 22h16M14 30h10"/>
              <path d="M28 28l8 8M32 28h4v4" strokeLinecap="round"/>
            </svg>
            <div style={{ fontSize: 13, color: 'var(--text-hi)' }}>Import an SVG to map LED strips</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              Works with Illustrator CC, Inkscape,<br/>and any SVG with layer groups.<br/>Drag and drop onto the canvas.
            </div>
            <button className="cta" onClick={() => fileRef.current?.click()}>
              {TbIcon.import}Import SVG
            </button>
          </div>
        )}
      </aside>
      </div>{/* .la */}
    </div>
  );
}
