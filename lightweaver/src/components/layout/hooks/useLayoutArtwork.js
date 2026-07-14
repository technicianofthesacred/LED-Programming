import { useState, useMemo, useCallback } from 'react';
import { samplePath as libSamplePath } from '../../../lib/mapper.js';
import {
  stripSourceKey,
  nextStripId,
  layerArtworkMarkup,
} from '../../../lib/layoutGeometry.js';
import { isClosedPathData } from '../../../lib/pathClosure.js';

// Artwork side: layers, layer/strip groups, layer order, path selection,
// add-as-strip flows, and rename/hide/delete for artwork.
// `ctx` is the shared layout bundle; `getLedCount` comes from useLayoutSize.
export function useLayoutArtwork(ctx, { getLedCount }) {
  const {
    strips, setStrips,
    editCounts, setEditCounts,
    hidden, setHidden,
    layers, setLayers,
    svgText, viewBox, density, pxPerMm,
    layerGroups, setLayerGroups,
    layerOrder, setLayerOrder,
    pushLayoutHistory,
    selection, selectStrip, selectStrips, selectPaths, togglePathSel, clearLayoutSelection,
    pathSel, pathSelName,
    selLayer,
    nextColor, makeStrip, scrollToStrip, stripGroupMember,
  } = ctx;

  // Layer panel expand + drag state (ephemeral view state — stays local)
  const [expandedLayers, setExpandedLayers] = useState({});
  const [layerDragging, setLayerDragging] = useState(null);
  const [layerDragOver, setLayerDragOver] = useState(null);
  const [stripGroupDragOver, setStripGroupDragOver] = useState(null);

  // ── Inline SVG artwork ─────────────────────────────────────────────────────
  const artworkHTML = useMemo(() => {
    if (!svgText || !layers.length) return null;
    return layers.map(layerArtworkMarkup).join('');
  }, [svgText, layers]);

  const readDraggedStripIds = (e) => {
    try {
      const raw = e.dataTransfer.getData('application/x-lightweaver-strip');
      const ids = JSON.parse(raw || '[]');
      return Array.isArray(ids) ? ids.filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  const readDraggedPathEntries = (e) => {
    try {
      const raw = e.dataTransfer.getData('application/x-lightweaver-path');
      const entries = JSON.parse(raw || '[]');
      return Array.isArray(entries) ? entries.filter(entry => entry?.pathId && entry?.pathData) : [];
    } catch {
      return [];
    }
  };

  const createLayerGroupFromEntries = useCallback((entries, nameOverride = '') => {
    const unique = [];
    const seen = new Set();
    for (const entry of entries) {
      if (!entry?.pathId || seen.has(entry.pathId)) continue;
      seen.add(entry.pathId);
      unique.push(entry);
    }
    if (unique.length < 2) return;
    const groupId = `grp-${Date.now()}`;
    const baseName = unique[0].name?.split('·')[0]?.trim();
    const name = nameOverride.trim() || baseName || `Group ${layerGroups.length + 1}`;
    const newGroup = { groupId, name, _hidden: false, _expanded: true, members: unique.map(p => ({ ...p })) };
    pushLayoutHistory();
    setLayerGroups(prev => [...prev, newGroup]);
    setLayerOrder(prev => [{ type: 'group', id: groupId }, ...prev]);
    selectPaths(unique);
  }, [layerGroups.length, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectPaths]);

  const addPathsToGroup = useCallback((groupId, entries) => {
    const group = layerGroups.find(g => g.groupId === groupId);
    if (!group || group.type === 'strip') return;
    const incoming = entries.filter(entry => entry?.pathId && entry?.pathData);
    if (!incoming.length) return;
    pushLayoutHistory();
    setLayerGroups(prev => prev.map(g => {
      if (g.groupId !== groupId) return g;
      const existingIds = new Set(g.members.map(m => m.pathId));
      const nextMembers = [...g.members];
      incoming.forEach(entry => {
        if (!existingIds.has(entry.pathId)) nextMembers.push({ ...entry });
      });
      return { ...g, _expanded: true, members: nextMembers };
    }));
    selectPaths(incoming);
  }, [layerGroups, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectPaths]);

  const togglePathSelection = useCallback((entry, additive = false) => {
    // Path selection replaces any strip/layer selection (single selection kind).
    if (additive) togglePathSel(entry);
    else selectPaths([entry]);
  }, [togglePathSel, selectPaths]);

  // ── Add-as-strip flows ─────────────────────────────────────────────────────

  const addStrip = () => {
    if (!selLayer) return;
    // Re-sampling an existing whole-layer strip keeps its id (so patches, wiring
    // and selection survive the update); a brand-new strip gets a fresh id.
    const existing = strips.find(s => stripSourceKey(s) === selLayer.layerId);
    const id = existing ? existing.id : nextStripId(strips);
    const newStrip = makeStrip(selLayer, getLedCount(selLayer), id);
    const newStrips = [...strips.filter(s => s.id !== id), newStrip];
    pushLayoutHistory();
    setStrips(newStrips);
    selectStrip(newStrip.id);
    scrollToStrip(newStrip.id);
  };

  const addSubPathStrip = (sp, layer) => {
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', sp.pathData);
    const count = Math.max(1, Math.round((sp.svgLength / pxPerMm) * density / 1000));
    const pixels = libSamplePath(pathEl, count);
    const existing = strips.find(s => stripSourceKey(s) === sp.pathId);
    const id = existing ? existing.id : nextStripId(strips);
    const newStrip = {
      id,
      sourceLayerId: layer.layerId,
      sourcePathId: sp.pathId,
      name: `${layer.name} · ${sp.name}`,
      pathData: sp.pathData,
      pixelCount: count,
      pixels,
      color: layer._color,
      x: 0, y: 0,
      emit: 'dir',
      angle: 0,
      reversed: false,
      speed: 1.0,
      brightness: 1.0,
      hueShift: 0,
      patternId: null,
    };
    const newStrips = [...strips.filter(s => s.id !== id), newStrip];
    pushLayoutHistory();
    setStrips(newStrips);
    selectStrip(newStrip.id);
    scrollToStrip(newStrip.id);
  };

  const addSelectedPathsAsStrips = useCallback((mode = 'merged') => {
    if (!pathSel.length) return;

    if (mode === 'merged') {
      const combinedPathData = pathSel.map(p => p.pathData).join(' ');
      const totalLen = pathSel.reduce((s, p) => s + p.svgLength, 0);
      const count = Math.max(1, Math.round((totalLen / pxPerMm) * density / 1000));
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', combinedPathData);
      const pixels = libSamplePath(pathEl, count);
      const name = pathSelName.trim() || `Strip ${strips.length + 1}`;
      const newStrip = {
        id: nextStripId(strips), name,
        // Merged from several paths: no single artwork source.
        sourceLayerId: null, sourcePathId: null,
        pathData: combinedPathData, pixelCount: count, pixels,
        closed: pathSel.length === 1 && isClosedPathData(pathSel[0].pathData, pathSel[0].closed),
        x: 0, y: 0,
        color: nextColor(), emit: 'dir', angle: 0, reversed: false,
        speed: 1.0, brightness: 1.0, hueShift: 0, patternId: null,
      };
      const newStrips = [...strips, newStrip];
      pushLayoutHistory();
      setStrips(newStrips);
      selectStrip(newStrip.id);
      scrollToStrip(newStrip.id);
      return;
    }

    let running = strips;
    const created = pathSel.map((p) => {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', p.pathData);
      const count = Math.max(1, Math.round((p.svgLength / pxPerMm) * density / 1000));
      const pixels = libSamplePath(pathEl, count);
      const layerColor = layers.find(l => l.layerId === p.layerId)?._color;
      const strip = {
        id: nextStripId(running),
        sourceLayerId: p.layerId ?? null,
        sourcePathId: p.pathId ?? null,
        name: p.name,
        pathData: p.pathData,
        closed: isClosedPathData(p.pathData, p.closed),
        pixelCount: count,
        pixels,
        x: 0, y: 0,
        color: layerColor || nextColor(),
        emit: 'dir', angle: 0, reversed: false,
        speed: 1.0, brightness: 1.0, hueShift: 0, patternId: null,
      };
      running = [...running, strip];
      return strip;
    });
    const newStrips = [...strips, ...created];
    pushLayoutHistory();
    setStrips(newStrips);
    selectStrips(created.map(s => s.id));

    if (mode === 'grouped' && created.length > 1) {
      const groupId = `strip-grp-${Date.now()}`;
      const name = pathSelName.trim() || `Strip Group ${layerGroups.length + 1}`;
      const newGroup = {
        groupId,
        type: 'strip',
        name,
        _hidden: false,
        _expanded: true,
        members: created.map(stripGroupMember),
      };
      setLayerGroups(prev => [...prev, newGroup]);
      setLayerOrder(prev => [{ type: 'group', id: groupId }, ...prev]);
    }

    scrollToStrip(created[0]?.id);
  }, [pathSel, pathSelName, strips, layers, editCounts, hidden, svgText, viewBox, density, pxPerMm, layerGroups.length, pushLayoutHistory, selectStrip, selectStrips]);

  const addAllStrips = useCallback(() => {
    if (strips.length > 0 &&
        typeof window !== 'undefined' &&
        !window.confirm(`Replace all ${strips.length} drawn strip(s) with auto-generated strips from every layer? This cannot be undone except via Undo.`)) {
      return;
    }
    const newStrips = [];
    for (const l of layers.filter(l => l.pathData)) {
      newStrips.push(makeStrip(l, getLedCount(l), nextStripId(newStrips)));
    }
    pushLayoutHistory();
    setStrips(newStrips);
    if (newStrips.length > 0) selectStrip(newStrips[0].id);
    scrollToStrip(newStrips[0]?.id);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrip]);

  // ── Rename helpers ─────────────────────────────────────────────────────────

  const renameLayer = (layerId, name) =>
    setLayers(prev => prev.map(l => l.layerId === layerId ? { ...l, name } : l));

  const renameSubPath = (layerId, pathId, name) =>
    setLayers(prev => prev.map(l => l.layerId !== layerId ? l : {
      ...l, subPaths: l.subPaths.map(sp => sp.pathId === pathId ? { ...sp, name } : sp),
    }));

  const renameGroup = (groupId, name) =>
    setLayerGroups(prev => prev.map(g => g.groupId === groupId ? { ...g, name } : g));

  // ── Delete layer ───────────────────────────────────────────────────────────

  const deleteLayer = useCallback((layerId) => {
    const layer = layers.find(item => item.layerId === layerId);
    const relatedPathIds = new Set([
      layerId,
      ...(layer?.subPaths || []).map(path => path.pathId),
    ]);
    pushLayoutHistory();
    const nextLayers = layers.filter(l => l.layerId !== layerId);
    const removedStrips = strips.filter(s => relatedPathIds.has(stripSourceKey(s)));
    const removedStripIds = new Set(removedStrips.map(s => s.id));
    const nextStrips = strips.filter(s => !removedStripIds.has(s.id));
    const nextEditCounts = { ...editCounts };
    const nextHidden = { ...hidden };
    relatedPathIds.forEach(id => {
      delete nextEditCounts[id];
      delete nextHidden[id];
    });
    // Drop the deleted strips' own hidden flags so a reused strip-<n> id can't
    // inherit a stale "hidden" state.
    removedStripIds.forEach(id => { delete nextHidden[id]; });
    setLayers(nextLayers);
    setLayerOrder(prev => prev.filter(x => x.id !== layerId));
    setLayerGroups(prev => prev.map(g => ({ ...g, members: g.members.filter(m => m.layerId !== layerId) }))
                               .filter(g => g.members.length > 0));
    setStrips(nextStrips);
    setEditCounts(nextEditCounts);
    setHidden(nextHidden);
    // Removed strips are pruned from the selection by the strips-change effect;
    // an explicitly selected (deleted) layer clears here.
    if (selection.kind === 'layer' && selection.ids.includes(layerId)) clearLayoutSelection();
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, selection, clearLayoutSelection, pushLayoutHistory]);

  const deleteSelectedVectorPaths = useCallback(() => {
    if (!pathSel.length) return;

    const selectedPathIds = new Set(pathSel.map(path => path.pathId));
    const selectedLayerIds = new Set(pathSel.map(path => path.layerId));
    const selectedPathData = new Set(pathSel.map(path => path.pathData));
    const deletedLayerIds = new Set();

    const nextLayers = [];
    for (const layer of layers) {
      if (!selectedLayerIds.has(layer.layerId) && !selectedPathIds.has(layer.layerId)) {
        nextLayers.push(layer);
        continue;
      }

      const wholeLayerSelected = selectedPathIds.has(layer.layerId) || !(layer.subPaths?.length);
      if (wholeLayerSelected) {
        deletedLayerIds.add(layer.layerId);
        continue;
      }

      const nextSubPaths = layer.subPaths.filter(path => !selectedPathIds.has(path.pathId));
      if (!nextSubPaths.length) {
        deletedLayerIds.add(layer.layerId);
        continue;
      }

      nextLayers.push({
        ...layer,
        subPaths: nextSubPaths,
        pathData: nextSubPaths.map(path => path.pathData).join(' '),
        svgLength: nextSubPaths.reduce((sum, path) => sum + (path.svgLength || 0), 0),
      });
    }

    const removedIds = new Set([...selectedPathIds, ...deletedLayerIds]);
    const removedStrips = strips.filter(strip =>
      removedIds.has(stripSourceKey(strip)) ||
      selectedPathData.has(strip.pathData));
    const removedStripIds = new Set(removedStrips.map(s => s.id));
    const nextStrips = strips.filter(strip => !removedStripIds.has(strip.id));
    const nextEditCounts = { ...editCounts };
    const nextHidden = { ...hidden };
    removedIds.forEach(id => {
      delete nextEditCounts[id];
      delete nextHidden[id];
    });
    // Drop the deleted strips' own hidden flags so a reused strip-<n> id can't
    // inherit a stale "hidden" state.
    removedStripIds.forEach(id => { delete nextHidden[id]; });

    const nextLayerGroups = layerGroups
      .map(group => ({
        ...group,
        members: group.members.filter(member =>
          // member.pathId carries the strip's source key (or a path id for path
          // members), so this prunes both eras identically as the artwork is cut.
          !removedIds.has(member.pathId) &&
          !deletedLayerIds.has(member.layerId)),
      }))
      .filter(group => group.members.length > 0);
    const liveGroupIds = new Set(nextLayerGroups.map(group => group.groupId));
    const liveLayerIds = new Set(nextLayers.map(layer => layer.layerId));
    const nextLayerOrder = layerOrder.filter(item =>
      item.type === 'group'
        ? liveGroupIds.has(item.id)
        : liveLayerIds.has(item.id));

    pushLayoutHistory();
    setLayers(nextLayers);
    setStrips(nextStrips);
    setEditCounts(nextEditCounts);
    setHidden(nextHidden);
    setLayerGroups(nextLayerGroups);
    setLayerOrder(nextLayerOrder);
    // The current selection is the just-deleted paths — clear it.
    clearLayoutSelection();
  }, [pathSel, layers, strips, editCounts, hidden, svgText, viewBox, density, layerGroups, layerOrder, clearLayoutSelection, pushLayoutHistory]);

  // ── Layer group management ─────────────────────────────────────────────────

  const createLayerGroup = useCallback(() => {
    createLayerGroupFromEntries(pathSel);
    clearLayoutSelection();
  }, [pathSel, createLayerGroupFromEntries, clearLayoutSelection]);

  const deleteLayerGroup = useCallback((groupId) => {
    setLayerGroups(prev => prev.filter(g => g.groupId !== groupId));
    setLayerOrder(prev => prev.filter(x => x.id !== groupId));
  }, []);

  const toggleGroupExpanded = (groupId) =>
    setLayerGroups(prev => prev.map(g => g.groupId === groupId ? { ...g, _expanded: !g._expanded } : g));

  const toggleGroupHidden = useCallback((groupId) => {
    const group = layerGroups.find(g => g.groupId === groupId);
    if (!group) return;
    const nextHidden = !group._hidden;
    setLayerGroups(prev => prev.map(g => g.groupId === groupId ? { ...g, _hidden: nextHidden } : g));
    setHidden(prev => {
      const next = { ...prev };
      group.members.forEach(m => { next[m.stripId || m.pathId] = nextHidden; });
      return next;
    });
  }, [layerGroups]);

  // ── Layer order (drag-and-drop) ────────────────────────────────────────────

  const reorderLayerOrder = useCallback((fromId, toId) => {
    if (fromId === toId) return;
    setLayerOrder(prev => {
      const fi = prev.findIndex(x => x.id === fromId);
      const ti = prev.findIndex(x => x.id === toId);
      if (fi === -1 || ti === -1) return prev;
      const next = [...prev];
      const [removed] = next.splice(fi, 1);
      next.splice(ti, 0, removed);
      return next;
    });
  }, []);

  return {
    artworkHTML,
    expandedLayers, setExpandedLayers,
    layerDragging, setLayerDragging,
    layerDragOver, setLayerDragOver,
    stripGroupDragOver, setStripGroupDragOver,
    readDraggedStripIds,
    readDraggedPathEntries,
    createLayerGroupFromEntries,
    addPathsToGroup,
    togglePathSelection,
    addStrip,
    addSubPathStrip,
    addSelectedPathsAsStrips,
    addAllStrips,
    renameLayer,
    renameSubPath,
    renameGroup,
    deleteLayer,
    deleteSelectedVectorPaths,
    createLayerGroup,
    deleteLayerGroup,
    toggleGroupExpanded,
    toggleGroupHidden,
    reorderLayerOrder,
  };
}
