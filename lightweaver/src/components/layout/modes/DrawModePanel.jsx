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
} from '../shared/InspectorPrimitives.jsx';
import { useMemo, useState } from 'react';
import { useProject } from '../../../state/ProjectContext.jsx';
import {
  STRIP_COLORS,
  DENSITY_OPTIONS,
  stripSourceKey,
  clampLedCount,
  svgPathLength,
} from '../../../lib/layoutGeometry.js';
import { STARTER_PRIMITIVES } from '../../../lib/layoutPrimitives.js';
import {
  LED_COUNT_MAX,
  LED_COUNT_SLIDER_MAX,
  LED_COUNT_SLIDER_MIN,
  ledCountToSliderValue,
  sliderValueToLedCount,
} from '../../../lib/controlScale.js';
import { PrimitiveStarter } from './PrimitiveStarter.jsx';
import { CARD_HARDWARE_CAPABILITIES } from '../../../lib/cardRuntimeContract.js';
import { activeBoardGpios } from '../../../lib/gpioAssignments.js';
import '../../../styles/lw-draw.css';

// Metres formatter for the physical readouts: 2 decimals under 10 m, 1 above.
function formatMetersValue(meters) {
  return meters >= 10 ? meters.toFixed(1) : meters.toFixed(2);
}

// Convert a strip's on-canvas path length to metres at the current scale.
function stripMeters(svgLength, pxPerMm) {
  const scale = Number.isFinite(pxPerMm) && pxPerMm > 0 ? pxPerMm : 3.7795;
  return svgLength / scale / 1000;
}

// Compact glyphs for the "+ Add strip" shape tiles (icon leads, small label
// under it). Stroke inherits the button's text color.
const shapeGlyph = (children) => (
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 16 16" fill="none"
       stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const SHAPE_ICONS = {
  line: shapeGlyph(<line x1="2" y1="14" x2="14" y2="2"/>),
  circle: shapeGlyph(<circle cx="8" cy="8" r="6"/>),
  square: shapeGlyph(<rect x="2.5" y="2.5" width="11" height="11" rx="1"/>),
  free: shapeGlyph(<path d="M2 12 C 4.5 3, 8 14, 11 6 S 13.5 4.5, 14 4"/>),
  import: shapeGlyph(<>
    <path d="M3 2.5 h6.5 L13 6 v7.5 H3 Z"/>
    <path d="M9.5 2.5 V6 H13"/>
    <path d="M8 8 v3.5 M6.5 10 L8 11.5 L9.5 10"/>
  </>),
};

// ── Draw-mode side panel ─────────────────────────────────────────────────────
// Verbatim lift of LayoutScreen's Draw branch: error banner, draw-mode hint,
// pending-draw naming panel, artwork layers list, path-selection panel, layer
// inspector, LED strips list, the "Advanced" wire editor, and the empty state.
// Receives the full useLayoutState() bundle as a single `state` prop (the panel
// references nearly the entire bundle, so grouped props would be noise). No
// handler is renamed and no logic is restructured — this is a pure move.

export function DrawModePanel({ state }) {
  const {
    strips, layers, hidden, setHidden,
    svgText, pxPerMm, density,
    editCounts, setEditCounts, layerGroups, layerOrder, setLayers,
    selectStrip, selectLayer, selectPaths, toggleStripSel,
    clearLayoutSelection, renameLayoutSelection,
    selLayer, existingStrip,
    selStripId, selLayerId, selectedStripIds,
    pathSel, pathSelName, stripSelectionName,
    orderedStrips, selectedStrips,
    totalLeds, starterLayoutActive, usbLedMaxPixels,
    expandedStrips, setExpandedStrips,
    stripListRef,
    // size
    getLedCount, resampleStrip, setStripCount, stripDensity, setStripPhysical,
    // strips
    updateStrip, removeStrip, reverseStrip, renameStrip, duplicateStrip,
    addPrimitiveStrip, scaleStrip,
    addStripsToGroup, groupSelectedStrips, mergeSelectedStrips,
    usbLedConnected,
    // artwork
    expandedLayers, setExpandedLayers,
    layerDragging, setLayerDragging,
    layerDragOver, setLayerDragOver,
    stripGroupDragOver, setStripGroupDragOver,
    readDraggedStripIds, readDraggedPathEntries,
    createLayerGroupFromEntries, addPathsToGroup, togglePathSelection,
    addStrip, addSubPathStrip, addSelectedPathsAsStrips,
    renameLayer, renameSubPath, renameGroup,
    deleteLayer, createLayerGroup, deleteLayerGroup,
    toggleGroupExpanded, toggleGroupHidden, reorderLayerOrder, setLayerGroups,
    // canvas + preview
    setDirectedGlow, enableLightPreview,
    setDrawMode, setWaypoints, setGhostPt,
    drawMode, waypoints,
    pendingDraw, pendingDrawName, setPendingDrawName,
    pendingDrawCount, setPendingDrawCount, pendingDrawNameRef,
    confirmDraw, cancelDraw, completeDraw, drawStats,
    setHoveredLayerId, setHoveredSubPathId,
    // import
    error, setError, fileRef,
    createStarterPrimitive, clearStarterLayout,
  } = state;
  const { wiring, updateWiring, standaloneController } = useProject();

  // "+ Add strip" shape chooser — icon tiles (Line / Circle / Square / Free
  // draw / Import vector) plus one LEDs input. The count is the strip the
  // user is physically adding, and the shape arrives sized to hold it at the
  // strip's fixed density. Ephemeral view state.
  const [addChooserOpen, setAddChooserOpen] = useState(false);
  const [addLedCount, setAddLedCount] = useState(60);
  const [addDensity, setAddDensity] = useState(density);
  const [addLengthM, setAddLengthM] = useState(1);
  const [addLengthDraft, setAddLengthDraft] = useState('1.00');
  const [gpioError, setGpioError] = useState('');
  const [droppedStripIds, setDroppedStripIds] = useState([]);

  const setLinkedAddCount = rawValue => {
    const count = clampLedCount(rawValue);
    const nextLength = count / addDensity;
    setAddLedCount(count);
    setAddLengthM(nextLength);
    setAddLengthDraft(formatMetersValue(nextLength));
  };
  const setLinkedAddDensity = nextDensity => {
    const nextLength = clampLedCount(addLedCount) / nextDensity;
    setAddDensity(nextDensity);
    setAddLengthM(nextLength);
    setAddLengthDraft(formatMetersValue(nextLength));
  };
  const commitAddLength = () => {
    const nextLength = Number(addLengthDraft);
    if (!Number.isFinite(nextLength) || nextLength <= 0) {
      setAddLengthDraft(formatMetersValue(addLengthM));
      return;
    }
    setAddLengthM(nextLength);
    setAddLedCount(clampLedCount(Math.round(nextLength * addDensity)));
    setAddLengthDraft(formatMetersValue(nextLength));
  };

  const pickAddShape = (key) => {
    setAddChooserOpen(false);
    if (key === 'import') {
      // Reuse the existing SVG import flow (same hidden input as Import SVG).
      fileRef.current?.click();
      return;
    }
    if (key === 'free') {
      // Same entry as the toolbar pencil / starter Free draw: arm draw mode
      // with a clean waypoint slate. Free draw ignores the count input — the
      // path is drawn first, then measured.
      setWaypoints([]);
      setGhostPt(null);
      setDrawMode(true);
      return;
    }
    addPrimitiveStrip(key, clampLedCount(addLedCount), addDensity, addLengthM);
  };

  const addShapeTiles = [
    ...STARTER_PRIMITIVES,
    { key: 'import', label: 'Import vector' },
  ];

  const stripById = useMemo(() => new Map(strips.map(strip => [strip.id, strip])), [strips]);
  const stripRuns = useMemo(() => new Map(
    wiring.runs
      .filter(run => run.type === 'strip' && stripById.has(run.source?.stripId))
      .map(run => [run.source.stripId, run]),
  ), [wiring.runs, stripById]);
  const outputForStrip = stripId => wiring.outputs.find(output => output.runIds.includes(stripRuns.get(stripId)?.id)) || wiring.outputs[0];

  // The Draw list is the physical wiring overview. Each GPIO gets a compact
  // group and the rows inside it are the data order from the card outward.
  const gpioGroups = useMemo(() => {
    const assigned = new Set();
    const groups = wiring.outputs.map(output => {
      const groupStrips = output.runIds
        .map(runId => wiring.runs.find(run => run.id === runId))
        .filter(run => run?.type === 'strip')
        .map(run => stripById.get(run.source.stripId))
        .filter(Boolean);
      groupStrips.forEach(strip => assigned.add(strip.id));
      return { output, strips: groupStrips };
    });
    const unassigned = orderedStrips.filter(strip => !assigned.has(strip.id));
    if (unassigned.length && groups[0]) groups[0] = { ...groups[0], strips: [...groups[0].strips, ...unassigned] };
    return groups.filter(group => group.strips.length);
  }, [orderedStrips, stripById, wiring]);

  const makeRunForStrip = strip => ({
    id: `run-${strip.id}`,
    type: 'strip',
    source: { stripId: strip.id, from: 0, to: Math.max(0, strip.pixelCount - 1) },
    directionPolicy: 'flexible',
    physicalDirection: 'source-forward',
    seamLed: null,
    verified: false,
  });

  const ensureRunsForAllStrips = draft => {
    const known = new Set(draft.runs.filter(run => run.type === 'strip').map(run => run.source?.stripId));
    const primary = draft.outputs[0];
    const stripsById = new Map(strips.map(strip => [strip.id, strip]));
    draft.runs.forEach(run => {
      if (run.type !== 'strip') return;
      const strip = stripsById.get(run.source?.stripId);
      if (!strip) return;
      const lastLed = Math.max(0, strip.pixelCount - 1);
      // The default, whole-strip run must track manual LED-count corrections.
      // Advanced split runs keep their range, but are clamped if it now falls
      // beyond the shortened strip.
      if (run.id === `run-${strip.id}`) {
        run.source = { ...run.source, from: 0, to: lastLed };
        return;
      }
      const from = Math.min(lastLed, Math.max(0, Number(run.source?.from) || 0));
      const to = Math.min(lastLed, Math.max(from, Number(run.source?.to) || from));
      run.source = { ...run.source, from, to };
    });
    strips.forEach(strip => {
      if (known.has(strip.id)) return;
      const run = makeRunForStrip(strip);
      draft.runs.push(run);
      primary.runIds.push(run.id);
    });
  };

  const nextOutputId = outputs => {
    let number = 1;
    while (outputs.some(output => output.id === `out${number}`)) number += 1;
    return `out${number}`;
  };

  const assignStripGpio = (stripId, pin) => {
    const selectedPin = Number(pin);
    const result = updateWiring(draft => {
      // A direct Draw-mode assignment is an intentional edit to the physical
      // plan. Reopen the plan first, so selecting a GPIO always applies and
      // invalidates the previous bench verification in the same undo step.
      if (draft.locked) {
        draft.locked = false;
        draft.verified = false;
        draft.runs.forEach(item => { item.verified = false; });
      }
      ensureRunsForAllStrips(draft);
      const run = draft.runs.find(item => item.type === 'strip' && item.source?.stripId === stripId);
      const source = draft.outputs.find(output => output.runIds.includes(run?.id));
      const target = draft.outputs.find(output => output.pin === selectedPin);
      if (!run || !source || source === target) return;

      if (target) {
        source.runIds = source.runIds.filter(runId => runId !== run.id);
        target.runIds.push(run.id);
        if (!source.runIds.length && draft.outputs.length > 1) draft.outputs = draft.outputs.filter(output => output.id !== source.id);
        return;
      }

      if (source.runIds.length === 1) {
        source.pin = selectedPin;
        return;
      }
      if (draft.outputs.length >= CARD_HARDWARE_CAPABILITIES.maxOutputs) throw new Error(`This card supports up to ${CARD_HARDWARE_CAPABILITIES.maxOutputs} GPIO outputs.`);
      source.runIds = source.runIds.filter(runId => runId !== run.id);
      draft.outputs.push({ id: nextOutputId(draft.outputs), name: `Output ${draft.outputs.length + 1}`, pin: selectedPin, runIds: [run.id] });
    }, { changeKind: 'gpio' });
    if (result.ok) {
      setGpioError('');
    } else {
      setGpioError(wiring.locked
        ? 'Unlock wiring in Wire before changing GPIO.'
        : result.errors?.[0]?.message || 'That GPIO assignment could not be changed.');
    }
  };

  const moveStripsInGpioOrder = (draggedStripIds, targetStripId, placement = 'before') => {
    const ids = (draggedStripIds || []).filter(id => id && id !== targetStripId);
    if (!ids.length) return;
    updateWiring(draft => {
      ensureRunsForAllStrips(draft);
      const runsByStrip = new Map(draft.runs.filter(run => run.type === 'strip').map(run => [run.source.stripId, run]));
      const targetRun = runsByStrip.get(targetStripId);
      const targetOutput = draft.outputs.find(output => output.runIds.includes(targetRun?.id));
      const movedRuns = ids.map(id => runsByStrip.get(id)).filter(Boolean);
      if (!targetOutput || !movedRuns.length) return;
      draft.outputs.forEach(output => { output.runIds = output.runIds.filter(runId => !movedRuns.some(run => run.id === runId)); });
      const targetIndex = targetOutput.runIds.indexOf(targetRun.id);
      const insertAt = targetIndex < 0
        ? targetOutput.runIds.length
        : targetIndex + (placement === 'after' ? 1 : 0);
      targetOutput.runIds.splice(insertAt, 0, ...movedRuns.map(run => run.id));
      draft.outputs = draft.outputs.filter(output => output.runIds.length || output.id === targetOutput.id);
    }, { changeKind: 'route' });
  };

  const gpioChoicesForStrip = stripId => {
    const output = outputForStrip(stripId);
    const controlPins = new Set(activeBoardGpios([], standaloneController?.controls).map(item => item.pin));
    const canCreateOutput = output?.runIds.length <= 1 || wiring.outputs.length < CARD_HARDWARE_CAPABILITIES.maxOutputs;
    return CARD_HARDWARE_CAPABILITIES.supportedOutputPins.map(pin => ({
      pin,
      disabled: controlPins.has(pin) || (pin !== output?.pin && !wiring.outputs.some(item => item.pin === pin) && !canCreateOutput),
    }));
  };

  return (
    <>

        {starterLayoutActive && !drawMode && !pendingDraw && (
          <PrimitiveStarter
            currentPixelCount={totalLeds || 37}
            defaultDensity={density}
            onImport={() => fileRef.current?.click()}
            onCreate={createStarterPrimitive}
            onFreeDraw={() => {
              clearStarterLayout();
              setWaypoints([]);
              setGhostPt(null);
              setDrawMode(true);
            }}/>
        )}

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
            {waypoints.length >= 1 && drawStats && (
              <span className="lw-draw-live" data-testid="draw-live-readout">
                {waypoints.length} point{waypoints.length !== 1 ? 's' : ''}
                {' · '}{formatMetersValue(drawStats.meters)} m · {drawStats.leds} LED{drawStats.leds !== 1 ? 's' : ''} so far
              </span>
            )}
            <span className="lw-draw-keys">
              Click to add points · Double-click or Enter to finish · Esc to cancel
            </span>
            {waypoints.length >= 2 && (
              <button
                className="btn primary"
                style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                onClick={() => completeDraw()}>
                Finish path
              </button>
            )}
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
                <span style={{ color: 'var(--text-mid)', width: 72, flexShrink: 0 }}>LEDs</span>
                <div className="lw-led-nudge">
                  <button type="button" className="btn" aria-label="One LED fewer" title="Nudge the count down 1"
                          onClick={() => setPendingDrawCount(clampLedCount(pendingDrawCount - 1))}>−</button>
                  <input type="number" min="1" max={LED_COUNT_MAX}
                         value={pendingDrawCount}
                         aria-label="New strip LED count"
                         inputMode="numeric"
                         onFocus={e => e.target.select()}
                         onChange={e => setPendingDrawCount(clampLedCount(e.target.value))}/>
                  <button type="button" className="btn" aria-label="One LED more" title="Nudge the count up 1"
                          onClick={() => setPendingDrawCount(clampLedCount(pendingDrawCount + 1))}>+</button>
                </div>
              </div>
              <span className="lw-draw-keys">
                Count comes from your path length at this strip's density — nudge to match the real strip.
              </span>
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
                              <span className="len">{(m.pixelCount || 0).toLocaleString()} LEDs</span>
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
              {/* Density lives in Size mode only now (docs/layout-redesign-plan.md
                  step 10 — the toolbar + inspector duplicates were removed). */}

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

              {/* Emit — one widget for BOTH mode + angle (step 10): the compass
                  center hub toggles Omni⇄Directed; the dial sets the angle. The
                  old separate Omni/Directed mini-seg was folded into the hub. */}
              <EmitCompass
                angle={existingStrip?.angle || 0}
                omni={isOmni || !existingStrip}
                onToggleEmit={existingStrip ? () => {
                  if (isOmni) {
                    setDirectedGlow(true); enableLightPreview();
                    updateStrip(existingStrip.id, { emit: 'dir' });
                  } else {
                    updateStrip(existingStrip.id, { emit: 'omni', angle: 0 });
                  }
                } : undefined}
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
        {strips.length > 0 && !starterLayoutActive && (
          <>
            <div className="panel-divider"/>
            {/* Always-visible add path (bench test: users never found Duplicate
                or the pencil after the first strip). */}
            <button type="button" className="btn la-add-strip" data-testid="layout-add-strip"
                    aria-expanded={addChooserOpen}
                    onClick={() => setAddChooserOpen(open => !open)}>
              + Add strip
            </button>
            {addChooserOpen && (
              <div className="la-add-strip-chooser lw-shape-chooser" data-testid="layout-add-strip-chooser"
                   role="group" aria-label="New strip shape">
                <div className="lw-shape-tiles">
                  {addShapeTiles.map(tile => (
                    <button key={tile.key} type="button" className="btn lw-shape-tile"
                            aria-label={tile.label}
                            title={tile.key === 'free' ? 'Draw any path — its length sets the LEDs'
                              : tile.key === 'import' ? 'Import an SVG of your artwork'
                              : `Add a ${tile.label.toLowerCase()} sized for the LEDs below`}
                            onClick={() => pickAddShape(tile.key)}>
                      {SHAPE_ICONS[tile.key]}
                      <span className="lw-shape-tile-label" aria-hidden="true">{tile.label}</span>
                    </button>
                  ))}
                </div>
                <div className="lw-shape-count">
                  <span className="lw-shape-count-label">LEDs</span>
                  <input type="number" min="1" max={LED_COUNT_MAX} step="1"
                         value={addLedCount}
                         aria-label="New strip LEDs"
                         inputMode="numeric"
                         onFocus={e => e.target.select()}
                         onChange={e => setLinkedAddCount(e.target.value)}/>
                  <span className="lw-shape-count-label">Size</span>
                  <input type="number" min="0.001" step="0.001"
                         value={addLengthDraft}
                         aria-label="New strip size in metres"
                         inputMode="decimal"
                         onFocus={e => e.target.select()}
                         onChange={e => setAddLengthDraft(e.target.value)}
                         onBlur={commitAddLength}
                         onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
                  <span className="lw-shape-count-unit">m</span>
                </div>
                <div className="lw-shape-density" data-testid="add-strip-density-control"
                     role="group" aria-label="New strip density">
                  <span>Density</span>
                  {DENSITY_OPTIONS.map(option => (
                    <button key={option} type="button"
                            className={`btn${addDensity === option ? ' is-selected' : ''}`}
                            aria-label={`${option} LEDs/m`}
                            aria-pressed={addDensity === option}
                            onClick={() => setLinkedAddDensity(option)}>{option}/m</button>
                  ))}
                </div>
              </div>
            )}
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
                  <button className="btn primary" title="Combine selected strips into one composite strip (M)" onClick={mergeSelectedStrips}>
                    Combine into one strip
                  </button>
                </div>
              </div>
            )}
            <div ref={stripListRef} className="layers" style={{ flex: '0 0 auto', minHeight: 0, paddingBottom: 4 }}>
              {/* GPIO groups are physical data chains, ordered from the card outward. */}
              {gpioGroups.map(({ output, strips: groupedStrips }) => (
                <section key={output.id} className="la-gpio-group" data-testid={`gpio-group-${output.pin}`}>
                  <div className="la-gpio-group-head">
                    <span>GPIO {output.pin}</span>
                    <span>first → last</span>
                  </div>
                  {groupedStrips.map((s, i) => {
                const isSel = s.id === selStripId;
                const isBatchSel = selectedStripIds.includes(s.id);
                const isOpen = !!expandedStrips[s.id];
                const selectedDensity = stripDensity(s.id);
                const densityChoices = DENSITY_OPTIONS.includes(selectedDensity)
                  ? DENSITY_OPTIONS
                  : [...DENSITY_OPTIONS, selectedDensity].sort((a, b) => a - b);
                return (
                  <div key={s.id} data-strip-id={s.id}>
                  <div
                       className={`la-strip-row${isSel ? ' sel' : ''}${droppedStripIds.includes(s.id) ? ' is-dropped' : ''}${stripGroupDragOver === `strip:${s.id}` ? ' is-drop-target' : ''}`}
                       draggable
                       onDragStart={e => {
                         const ids = selectedStripIds.includes(s.id) ? selectedStripIds : [s.id];
                         e.dataTransfer.effectAllowed = 'move';
                         e.dataTransfer.setData('application/x-lightweaver-strip', JSON.stringify(ids));
                         e.dataTransfer.setData('text/plain', ids.join(','));
                         // Preserve the native drag session, so this uses a direct class
                         // rather than React state for the lift feedback.
                         e.currentTarget.classList.add('is-dragging');
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
                         const bounds = e.currentTarget.getBoundingClientRect();
                         const placement = e.clientY > bounds.top + bounds.height / 2 ? 'after' : 'before';
                         moveStripsInGpioOrder(draggedStripIds, s.id, placement);
                         setDroppedStripIds(draggedStripIds);
                         window.setTimeout(() => setDroppedStripIds([]), 220);
                         setStripGroupDragOver(null);
                       }}
                       onDragEnd={e => {
                         e.currentTarget.classList.remove('is-dragging');
                         setStripGroupDragOver(null);
                       }}
                       style={{ opacity: hidden[s.id] ? 0.4 : 1,
                                outline: stripGroupDragOver === `strip:${s.id}` ? '1px solid var(--accent)' : undefined,
                                outlineOffset: -1 }}
                       onClick={e => {
                         if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleStripSel(s.id); return; }
                         selectStrip(s.id);
                         setExpandedStrips(ex => ({ ...ex, [s.id]: !ex[s.id] }));
                       }}>
                      <span className="la-wire-n" title="Click and drag to change wiring order" style={{ flexShrink: 0, cursor: 'grab', color: isBatchSel ? 'var(--accent)' : undefined }}>
                        {String(i + 1).padStart(2, '0')}<DragHandleIcon/>
                      </span>
                      <span className="layer-swatch" style={{ borderRadius: '50%', background: s.color,
                                     boxShadow: isSel ? `0 0 8px ${s.color}` : undefined }}/>
                      <InlineRename value={s.name} onCommit={n => renameStrip(s.id, n)}
                                    className="layer-name" style={{ cursor: 'pointer', flex: 1, minWidth: 0 }}/>
                      {s.reversed && <span className="la-strip-rev">REV</span>}
                      <span className="layer-len">{s.pixelCount} LEDs</span>
                    </div>
                    {isOpen && (
                      <div className="la-strip-detail" onClick={e => e.stopPropagation()}>
                        <div className="actions" aria-label="Strip actions">
                          <div className="la-strip-actions-left">
                            <button className="btn" aria-label="Reverse strip" title="Reverse pixel order"
                                    onClick={() => reverseStrip(s.id)}>↔</button>
                            <button className="btn" aria-label={hidden[s.id] ? 'Show strip' : 'Hide strip'}
                                    title={hidden[s.id] ? 'Show strip' : 'Hide strip'}
                                    onClick={() => setHidden(h => ({ ...h, [s.id]: !h[s.id] }))}>
                              {hidden[s.id] ? <EyeOffIcon/> : <EyeIcon/>}
                            </button>
                          </div>
                          <div className="la-strip-actions-right">
                            <button className="btn" aria-label="Duplicate strip" title="Duplicate strip"
                                    onClick={() => duplicateStrip(s.id)}>
                              <svg aria-hidden="true" viewBox="0 0 16 16"><rect x="5" y="2" width="8" height="9" rx="1"/><path d="M3 5v8a1 1 0 0 0 1 1h6"/></svg>
                            </button>
                            <button className="btn danger" aria-label="Remove strip" title="Remove strip"
                                    onClick={() => removeStrip(s.id)}>×</button>
                          </div>
                        </div>
                        {/* Size is physical truth and recounts LEDs; LED count is
                            a direct cut-strip correction that keeps size. */}
                        <div className="row la-strip-physical-row">
                          <div className="la-strip-physical-field">
                            <span className="k">LEDs</span>
                            <div className="la-led-count-field" role="group" aria-label="LED count tuning">
                              <button type="button" className="btn" aria-label="One LED fewer" title="Subtract one LED without changing size"
                                      onClick={() => setStripCount(s.id, clampLedCount(s.pixelCount - 1))}>−</button>
                              <input type="number" min="1" max={LED_COUNT_MAX} step="1"
                                     value={s.pixelCount}
                                     aria-label="Strip LED count"
                                     inputMode="numeric"
                                     onFocus={e => e.target.select()}
                                     onClick={e => e.target.select()}
                                     onChange={e => setStripCount(s.id, clampLedCount(e.target.value))}
                                     onBlur={e => setStripCount(s.id, clampLedCount(e.target.value))}
                                     onKeyDown={e => { if (e.key === 'Enter') setStripCount(s.id, clampLedCount(e.target.value)); }}/>
                              <button type="button" className="btn" aria-label="One LED more" title="Add one LED without changing size"
                                      onClick={() => setStripCount(s.id, clampLedCount(s.pixelCount + 1))}>+</button>
                            </div>
                          </div>
                          <div className="la-strip-physical-field">
                            <span className="k">Size</span>
                            <div className="la-size-ctrl">
                              <button type="button" className="btn" aria-label="Make strip smaller"
                                      title="Shrink 10%"
                                      onClick={() => scaleStrip(s.id, 0.9)}>−</button>
                              <label className="la-size-readout" data-testid="strip-size-readout">
                                <input type="number" min="0.001" step="0.001"
                                       key={`${s.id}:${s.svgLength}:${pxPerMm}`}
                                       defaultValue={formatMetersValue(stripMeters(
                                         (Number.isFinite(s.svgLength) && s.svgLength > 0)
                                           ? s.svgLength
                                           : svgPathLength(s.pathData),
                                         pxPerMm))}
                                       aria-label="Strip length in metres"
                                       inputMode="decimal"
                                       onFocus={e => e.target.select()}
                                       onBlur={e => {
                                         const value = Number(e.target.value);
                                         if (Number.isFinite(value) && value > 0) setStripPhysical(s.id, { lengthM: value });
                                       }}
                                       onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
                                <span>m</span>
                              </label>
                              <button type="button" className="btn" aria-label="Make strip bigger"
                                      title="Grow 10%"
                                      onClick={() => scaleStrip(s.id, 1 / 0.9)}>+</button>
                            </div>
                          </div>
                        </div>
                        <div className="row la-strip-output-row">
                          <div className="la-gpio-wrap">
                            <select className="la-gpio-select" aria-label="GPIO output"
                                    value={outputForStrip(s.id)?.pin ?? 16}
                                    onChange={event => assignStripGpio(s.id, Number(event.target.value))}>
                              {gpioChoicesForStrip(s.id).map(({ pin, disabled }) => (
                                <option key={pin} value={pin} disabled={disabled}>GPIO {pin}</option>
                              ))}
                            </select>
                          </div>
                          <div className="la-strip-density" data-testid="strip-density-control"
                               role="group" aria-label={`${s.name} reel density`}>
                            {densityChoices.map(d => (
                              <button key={d} type="button"
                                      className={`btn${selectedDensity === d ? ' is-selected' : ''}`}
                                      aria-label={`${d} LEDs/m`}
                                      aria-pressed={selectedDensity === d}
                                      title={`${d} LEDs per metre`}
                                      onClick={() => setStripPhysical(s.id, { ledsPerM: d })}>
                                {d}/m
                              </button>
                            ))}
                          </div>
                        </div>
                        {gpioError && <div className="la-gpio-error" role="alert">{gpioError}</div>}
                        {usbLedConnected && (
                          <div className="hint" style={{ color: s.pixelCount > usbLedMaxPixels ? 'var(--accent)' : 'var(--text-faint)' }}>
                            USB direct cap {usbLedMaxPixels} LEDs.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
                  })}
                </section>
              ))}
            </div>
          </>
        )}

        {/* ── Empty state ── */}
        {!svgText && !error && !starterLayoutActive && strips.length === 0 && (
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
      </>
  );
}
