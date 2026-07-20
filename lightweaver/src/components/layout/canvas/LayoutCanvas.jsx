import {
  rgbCss,
  pointsAttr,
  parsedVb,
} from '../../../lib/layoutGeometry.js';
import {
  activeLedCoreAlpha,
  ledCssColor,
  restingLedAlpha,
} from '../../../lib/previewVisuals.js';
import { LightCone, OmniHalo } from '../shared/InspectorPrimitives.jsx';
import { WiringCordOverlay } from '../wire/WiringCordOverlay.jsx';

// ── LayoutCanvas ────────────────────────────────────────────────────────────
// Verbatim lift of the LayoutScreen <svg> stage subtree (defs, artwork, heat,
// layer glow, hit paths, path-select highlight, light cones/halos, strip rails,
// wire canvas segments/route jumps/cut notches, LED dots, arrows, selection
// frame, connectors, draw ghost, empty state) plus its .lw-viewport / .stage
// wrappers, drop overlay, rubber-band, and the canvas-coupled .la-overlay corner
// readouts. Pure JSX + prop plumbing — no logic. All memos/handlers stay in the
// layout hooks and arrive as props. Refs (svgRef/artworkRef/vpRef/spaceRef/
// stripDragSuppressClickRef) cross the boundary as props and keep working.

export function LayoutCanvas({
  refs,
  strips, layers, hidden,
  viewBox, computedViewBox, vbScale, svgText, artworkHTML, totalLeds,
  selection,
  lightPreview,
  wire,
  draw,
  interaction,
  interactionHandlers,
}) {
  const { svgRef, artworkRef, vpRef, spaceRef, stripDragSuppressClickRef } = refs;
  const { selStripId, selLayer, pathSel, selectedPathDecorations = [], existingStrip } = selection;
  const {
    effectiveShowLight, effectiveGlowMode, glowStdDev, directedGlow,
    showHeat, showLeds, layoutPatternFrame, stripSamples, stripArrows,
  } = lightPreview;
  const {
    wireOverlayMode, visibleWirePathCanvasSegments, wireRouteJumps, wireCutMarkers,
    wiring, compiledWiring, selectedWiringRunId, onSeamMove,
    firstLedPicker, onFirstLedPick,
  } = wire;
  const selectedPhysicalRun = wiring?.runs?.find(run => run.id === selectedWiringRunId);
  const selectedPhysicalStrip = strips.find(strip => strip.id === selectedPhysicalRun?.source?.stripId);
  const selectedSeamLed = selectedPhysicalRun?.seamLed
    ?? (selectedPhysicalRun?.physicalDirection === 'source-reverse'
      ? selectedPhysicalRun?.source?.to
      : selectedPhysicalRun?.source?.from);
  const selectedSeamPoint = selectedPhysicalStrip?.pixels?.[selectedSeamLed];
  const { mode, drawMode, waypoints, ghostPt, ghostD } = draw;
  const {
    isEditingGesture, isPanning, rubberBand, movingStripIds,
    dragOver, cursorSvgPt, zoom, hoveredSubPathId,
  } = interaction;
  const {
    handleSvgClick, handleSvgDblClick, handleSvgMouseMove, handleSvgMouseDown,
    handleSvgMouseUp, handleSvgMouseLeave, handleContextMenu, handleWheel,
    handleDragOver, handleDragLeave, handleDrop,
    startStripMove, chopStripAtEvent, toggleStripSel, selectStrip,
    togglePathSelection, setHoveredLayerId, setHoveredSubPathId,
  } = interactionHandlers;
  const handleCanvasPointerDown = event => {
    if (!firstLedPicker) {
      handleSvgMouseDown(event);
      return;
    }
    const svg = svgRef.current;
    const strip = strips.find(item => item.id === firstLedPicker.stripId);
    const matrix = svg?.getScreenCTM()?.inverse();
    if (!strip?.pixels?.length || !matrix) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    let nearest = null;
    strip.pixels.forEach((pixel, index) => {
      const distance = Math.hypot(point.x - pixel.x, point.y - pixel.y);
      if (distance <= vbScale * 20 && (!nearest || distance < nearest.distance)) {
        nearest = { index, distance };
      }
    });
    if (!nearest) return;
    event.preventDefault();
    event.stopPropagation();
    onFirstLedPick(strip.id, nearest.index);
  };
  return (
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
              cursor: firstLedPicker ? 'crosshair' : drawMode ? 'crosshair' : rubberBand ? 'crosshair' : isPanning ? 'grabbing' : spaceRef.current ? 'grab' : 'default',
            }}
            onClick={handleSvgClick}
            onDoubleClick={handleSvgDblClick}
            onPointerMove={handleSvgMouseMove}
            onPointerDown={firstLedPicker ? undefined : handleCanvasPointerDown}
            onPointerDownCapture={firstLedPicker ? handleCanvasPointerDown : undefined}
            onPointerUp={handleSvgMouseUp}
            onPointerLeave={handleSvgMouseLeave}
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

            {mode === 'wire' && compiledWiring && (
              <WiringCordOverlay compiled={compiledWiring} selectedRunId={selectedWiringRunId}/>
            )}

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

            {/* ── Hit paths — individual path selection (Draw mode only; Size/Wire
                   ignore artwork paths per the canvas behavior matrix) ── */}
            {mode === 'draw' && !drawMode && layers.map(l => {
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
                        tabIndex="0"
                        role="button"
                        aria-label={`Select artwork vector ${entry.name}`}
                        fill="none" stroke="#fff" strokeOpacity="0.001"
                        strokeWidth="16" strokeLinecap="round" pointerEvents="stroke"
                        style={{ cursor: 'pointer' }}
                        onPointerDown={e => e.stopPropagation()}
                        onMouseEnter={() => { setHoveredLayerId(l.layerId); setHoveredSubPathId(t.pathId); }}
                        onMouseLeave={() => { setHoveredLayerId(null); setHoveredSubPathId(null); }}
                        onKeyDown={e => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          e.stopPropagation();
                          togglePathSelection(entry, e.shiftKey || e.metaKey || e.ctrlKey);
                        }}
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
            {selectedPathDecorations.map(p => {
              const midPt = p.midpoint;
              return (
                <g key={'sel-' + p.pathId} style={{ pointerEvents: 'none' }}>
                  <path d={p.pathData} stroke="oklch(0.615 0.112 57)" strokeWidth="8" fill="none" opacity={0.16} strokeLinecap="round"/>
                  <path className="lw-selected-path-march" d={p.pathData} stroke="oklch(0.615 0.112 57)" strokeWidth="2.5" fill="none" opacity={0.95}
                        strokeDasharray="10 5" strokeLinecap="round"
                        style={{ animation: 'lw-march 0.5s linear infinite' }}/>
                  <circle cx={midPt.x} cy={midPt.y} r={vbScale * 9} fill="oklch(0.615 0.112 57)" opacity={0.95}/>
                  <text x={midPt.x} y={midPt.y + vbScale * 4} textAnchor="middle" fill="oklch(0.190 0.018 52)" fontSize={vbScale * 9}
                        fontWeight="bold" style={{ userSelect: 'none' }}>{p.order}</text>
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
                        tabIndex="0"
                        role="button"
                        aria-label={`Select ${s.name} strip`}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            selectStrip(s.id);
                          }
                        }}
                        fill="none"
                        stroke="white"
                        strokeOpacity="0.001"
                        strokeWidth="18"
                        strokeLinecap="round"
                        pointerEvents="visibleStroke"
                        style={{ cursor: isMoving ? 'grabbing' : 'grab' }}
                        onPointerDown={e => {
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

            {mode === 'wire' && !isEditingGesture && visibleWirePathCanvasSegments.length > 0 && (
              <g className="lw-wire-canvas-segments" style={{ pointerEvents: 'none' }}>
                {visibleWirePathCanvasSegments.map(segment => (
                  <g key={segment.id}>
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

            {mode === 'wire' && !isEditingGesture && wireRouteJumps.length > 0 && (
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

            {mode === 'wire' && !isEditingGesture && wireCutMarkers.length > 0 && (
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

            {mode === 'wire' && selectedSeamPoint && (selectedPhysicalStrip?.closed || selectedPhysicalStrip?.isClosed || selectedPhysicalRun?.seamLed != null) && (
              <g
                data-testid="connector-seam-handle"
                role="slider"
                aria-label="Connector seam handle"
                aria-valuenow={selectedSeamLed}
                aria-disabled={wiring.locked || selectedPhysicalRun.verified || selectedPhysicalRun.directionPolicy === 'fixed'}
                tabIndex={0}
                className="lw-seam-handle"
                pointerEvents="all"
                transform={`translate(${selectedSeamPoint.x} ${selectedSeamPoint.y})`}
                onPointerDown={event => {
                  if (wiring.locked || selectedPhysicalRun.verified || selectedPhysicalRun.directionPolicy === 'fixed') return;
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                }}
                onPointerUp={event => {
                  if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  onSeamMove(selectedPhysicalRun.id, event);
                }}
              >
                <circle r={vbScale * 9}/>
                <circle r={vbScale * 3}/>
              </g>
            )}

            {/* ── LED dots — dim hardware at rest, bright only when pattern is lit ── */}
            {(showLeds || firstLedPicker) && !isEditingGesture && strips.filter(s => !hidden[s.id]).map(s => (
              effectiveGlowMode === 'dots' ? (
                <g key={s.id + '-dots'} style={{ pointerEvents: firstLedPicker?.stripId === s.id ? 'all' : 'none' }}>
                  {s.pixels.map((px, i) => {
                    const ledFrame = layoutPatternFrame.get(s.id)?.leds?.[i];
                    const selected = s.id === selStripId;
                    // Warm identity color at rest; pattern-driven tint only when lit.
                    const ledColor = effectiveShowLight ? ledCssColor(ledFrame, s.color || 'oklch(58% 0.04 70)') : (s.color || 'oklch(58% 0.04 70)');
                    // Keep unlit LEDs clearly visible so the strip's pixels are countable at rest.
                    const shellOpacity = Math.max(selected ? 0.85 : 0.62, restingLedAlpha(ledFrame, { selected }));
                    const coreOpacity = activeLedCoreAlpha(ledFrame, { selected });
                    return (
                    <g key={i} data-testid={`strip-led-${s.id}-${i}`}
                       style={{ cursor: firstLedPicker?.stripId === s.id ? 'crosshair' : undefined }}
                       onPointerDown={event => {
                         if (firstLedPicker?.stripId !== s.id) return;
                         event.preventDefault();
                         event.stopPropagation();
                         onFirstLedPick(s.id, i);
                       }}>
                      <circle cx={px.x} cy={px.y}
                              r={s.id === selStripId ? vbScale * 5.2 : vbScale * 3.8}
                              fill={ledColor} opacity={shellOpacity}/>
                      {coreOpacity > 0 && (
                        <circle cx={px.x} cy={px.y}
                                r={selected ? vbScale * 2.9 : vbScale * 2.25}
                                fill={ledColor} opacity={coreOpacity}/>
                      )}
                      {firstLedPicker?.stripId === s.id && <circle cx={px.x} cy={px.y} r={vbScale * 20}
                                                                  fill="transparent" pointerEvents="all"/>}
                    </g>
                    );
                  })}
                </g>
              ) : (
                <g key={s.id + '-dots'} filter="url(#lw-led-bloom)" style={{ pointerEvents: firstLedPicker?.stripId === s.id ? 'all' : 'none' }}>
                  {s.pixels.map((px, i) => {
                    const ledFrame = layoutPatternFrame.get(s.id)?.leds?.[i];
                    const selected = s.id === selStripId;
                    // Warm identity color at rest; pattern-driven tint only when lit.
                    const ledColor = effectiveShowLight ? ledCssColor(ledFrame, s.color || 'oklch(58% 0.04 70)') : (s.color || 'oklch(58% 0.04 70)');
                    const coreOpacity = activeLedCoreAlpha(ledFrame, { selected });
                    const restOpacity = Math.max(selected ? 0.72 : 0.5, restingLedAlpha(ledFrame, { selected }));
                    return (
                    <g key={i} data-testid={`strip-led-${s.id}-${i}`}
                       style={{ cursor: firstLedPicker?.stripId === s.id ? 'crosshair' : undefined }}
                       onPointerDown={event => {
                         if (firstLedPicker?.stripId !== s.id) return;
                         event.preventDefault();
                         event.stopPropagation();
                         onFirstLedPick(s.id, i);
                       }}>
                      <circle cx={px.x} cy={px.y}
                              r={s.id === selStripId ? vbScale * 2.8 : vbScale * 2.2}
                              fill={ledColor}
                              opacity={Math.max(coreOpacity * (effectiveGlowMode === 'outward' ? 0.58 : 0.74), restOpacity)}/>
                      {firstLedPicker?.stripId === s.id && <circle cx={px.x} cy={px.y} r={vbScale * 20}
                                                                  fill="transparent" pointerEvents="all"/>}
                    </g>
                    );
                  })}
                </g>
              )
            ))}

            {mode === 'draw' && selectedSeamPoint && (
              <g data-testid="first-led-marker" transform={`translate(${selectedSeamPoint.x} ${selectedSeamPoint.y})`} style={{ pointerEvents: 'none' }}>
                <circle r={vbScale * 10} fill="var(--bg-canvas)" stroke="var(--accent)" strokeWidth={vbScale * 2}/>
                <text textAnchor="middle" dominantBaseline="central" fill="var(--accent)" fontSize={vbScale * 11} fontWeight="700">1</text>
              </g>
            )}

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
            {mode === 'wire' && !isEditingGesture && strips.filter(s => !hidden[s.id]).map(s => {
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
      </main>
  );
}
