import { useCallback } from 'react';
import {
  nextStripId,
  sampleStripPixels,
  translatePathData,
  svgPathLength,
  parsedVb,
} from '../../../lib/layoutGeometry.js';
import {
  createPrimitiveStripDefinition,
  DEFAULT_STARTER_PIXEL_COUNT,
} from '../../../lib/layoutPrimitives.js';
import { scaleStripGeometry } from '../../../lib/stripScale.js';
import { moveStripRowsInChain } from '../../../lib/patchBoard.js';

// scaleStrip clamps: never shrink a strip's path below this length (px)…
const MIN_STRIP_SVG_LENGTH = 20;
// …and never grow it beyond this multiple of the artwork's larger dimension.
const MAX_STRIP_LENGTH_ARTWORK_FACTOR = 4;

// Strip entity CRUD + batch ops (group / merge / duplicate / reorder).
// Reads the shared layout bundle assembled by useLayoutState.
export function useLayoutStrips(ctx) {
  const {
    strips, setStrips,
    editCounts, setEditCounts,
    hidden, setHidden,
    layers, svgText, viewBox, density,
    layerGroups, setLayerGroups, setLayerOrder,
    pushLayoutHistory,
    selectStrip, selectStrips, clearLayoutSelection,
    updatePatchBoard,
    selectedStripIds, orderedStrips, stripSelectionName,
    nextColor, scrollToStrip, stripGroupMember,
    rebuildStrip,
  } = ctx;

  const updateStrip = useCallback((id, patch) => {
    setStrips(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
  }, [setStrips]);

  const updateStripWithHistory = useCallback((id, patch) => {
    pushLayoutHistory();
    setStrips(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
  }, [setStrips, pushLayoutHistory]);

  const setStripOffset = useCallback((id, nextX, nextY, withHistory = false) => {
    if (withHistory) pushLayoutHistory();
    setStrips(prev => prev.map(s => {
      if (s.id !== id) return s;
      return {
        ...s,
        x: nextX,
        y: nextY,
        pixels: sampleStripPixels(s.pathData, s.pixelCount, s.reversed, nextX, nextY),
      };
    }));
  }, [setStrips, pushLayoutHistory]);

  const removeStrip = useCallback((id) => {
    const newStrips = strips.filter(s => s.id !== id);
    const newEditCounts = { ...editCounts };
    delete newEditCounts[id];
    // Drop the strip's own hidden flag so a reused strip-<n> id can't inherit a
    // stale "hidden" state.
    const newHidden = { ...hidden };
    delete newHidden[id];
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => (m.stripId || m.pathId) === id))
      .map(g => g.groupId));
    pushLayoutHistory();
    setStrips(newStrips);
    setLayerGroups(prev => prev
      .map(g => ({ ...g, members: g.members.filter(m => (m.stripId || m.pathId) !== id) }))
      .filter(g => g.members.length > 0));
    setLayerOrder(prev => prev.filter(item => !emptiedGroupIds.has(item.id)));
    setEditCounts(newEditCounts);
    setHidden(newHidden);
    // Selection pruning happens in the strips-change effect in the composer.
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, layerGroups, pushLayoutHistory]);

  const reverseStrip = (id) => {
    const newStrips = strips.map(s => {
      if (s.id !== id) return s;
      const reversed = !s.reversed;
      const pixels = s.pixels.slice().reverse();
      return { ...s, reversed, pixels };
    });
    pushLayoutHistory();
    setStrips(newStrips);
  };

  const renameStrip = (id, name) => updateStrip(id, { name });

  const duplicateStrip = useCallback((id) => {
    const s = strips.find(st => st.id === id);
    if (!s) return;
    const newId = nextStripId(strips);
    // A duplicate is a free copy: it does not own the original's artwork source,
    // so it never counts as the whole-layer strip for that layer.
    const newStrip = {
      ...s, id: newId, name: `${s.name} copy`,
      sourceLayerId: null, sourcePathId: null,
      pixels: s.pixels.slice(),
    };
    const newStrips = strips.flatMap(st => st.id === id ? [st, newStrip] : [st]);
    pushLayoutHistory();
    setStrips(newStrips);
    selectStrip(newId);
    scrollToStrip(newId);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrip]);

  // "+ Add strip" — append a fresh Line / Circle / Square primitive to the
  // existing layout (the starter picker only exists before the first strip).
  // Each new strip is nudged +24px per existing strip so it never lands exactly
  // on top of another one.
  const addPrimitiveStrip = useCallback((type) => {
    const id = nextStripId(strips);
    const offset = 24 * strips.length;
    const definition = createPrimitiveStripDefinition({
      type,
      viewBox,
      pixelCount: DEFAULT_STARTER_PIXEL_COUNT,
      id,
      color: nextColor(),
    });
    // "Circle", "Circle 2", "Circle 3"… so rows stay tellable-apart.
    const sameShape = strips.filter(s =>
      s.name === definition.name || s.name?.startsWith(`${definition.name} `)).length;
    const strip = rebuildStrip({
      ...definition,
      name: sameShape ? `${definition.name} ${sameShape + 1}` : definition.name,
      x: offset,
      y: offset,
    });
    pushLayoutHistory();
    setStrips(prev => [...prev, strip]);
    selectStrip(id);
    scrollToStrip(id);
  }, [strips, viewBox, rebuildStrip, nextColor, pushLayoutHistory, setStrips, selectStrip, scrollToStrip]);

  // Uniform resize of a strip's geometry about its own center (Draw panel
  // − / + Size control). Same shape as reverseStrip: history push + setStrips,
  // so undo/redo and autosave pick it up through the normal strip-update path.
  const scaleStrip = useCallback((id, factor) => {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    const s = strips.find(st => st.id === id);
    if (!s) return;
    const currentLen = (Number.isFinite(s.svgLength) && s.svgLength > 0)
      ? s.svgLength
      : svgPathLength(s.pathData);
    if (!(currentLen > 0)) return;
    const vb = parsedVb(viewBox);
    const maxLen = MAX_STRIP_LENGTH_ARTWORK_FACTOR * Math.max(vb.w, vb.h);
    const nextLen = currentLen * factor;
    if (nextLen < MIN_STRIP_SVG_LENGTH || nextLen > maxLen) return;
    const scaled = scaleStripGeometry({ ...s, svgLength: currentLen }, factor);
    pushLayoutHistory();
    setStrips(prev => prev.map(st => st.id !== id ? st : {
      ...scaled,
      pixels: sampleStripPixels(scaled.pathData, scaled.pixelCount, scaled.reversed, scaled.x || 0, scaled.y || 0),
    }));
  }, [strips, viewBox, pushLayoutHistory, setStrips]);

  const createStripGroupFromIds = useCallback((stripIds, nameOverride = '') => {
    const uniqueIds = [...new Set(stripIds)].filter(Boolean);
    const picked = strips.filter(s => uniqueIds.includes(s.id));
    if (picked.length < 2) return;

    const pickedIds = new Set(picked.map(s => s.id));
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => pickedIds.has(m.stripId || m.pathId)))
      .map(g => g.groupId));
    const groupId = `strip-grp-${Date.now()}`;
    const name = nameOverride.trim() || stripSelectionName.trim() || `Strip Group ${layerGroups.length + 1}`;
    const newGroup = {
      groupId,
      type: 'strip',
      name,
      _hidden: false,
      _expanded: true,
      members: picked.map(stripGroupMember),
    };

    pushLayoutHistory();
    setLayerGroups(prev => [
      ...prev
        .map(g => ({ ...g, members: g.members.filter(m => !pickedIds.has(m.stripId || m.pathId)) }))
        .filter(g => g.members.length > 0),
      newGroup,
    ]);
    setLayerOrder(prev => [{ type: 'group', id: groupId }, ...prev.filter(item => item.id !== groupId && !emptiedGroupIds.has(item.id))]);
    selectStrips(picked.map(s => s.id));
  }, [strips, layerGroups, stripSelectionName, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrips]);

  const addStripsToGroup = useCallback((groupId, stripIds) => {
    const group = layerGroups.find(g => g.groupId === groupId);
    if (!group || group.type !== 'strip') return;
    const ids = [...new Set(stripIds)].filter(Boolean);
    const picked = strips.filter(s => ids.includes(s.id));
    if (!picked.length) return;
    const pickedIds = new Set(picked.map(s => s.id));

    pushLayoutHistory();
    setLayerGroups(prev => prev
      .map(g => {
        const existing = g.members.filter(m => !pickedIds.has(m.stripId || m.pathId));
        if (g.groupId !== groupId) return { ...g, members: existing };
        return {
          ...g,
          type: 'strip',
          _expanded: true,
          members: [...existing, ...picked.map(stripGroupMember)],
        };
      })
      .filter(g => g.members.length > 0));
    selectStrips(picked.map(s => s.id));
  }, [layerGroups, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrips]);

  const groupSelectedStrips = useCallback(() => {
    createStripGroupFromIds(selectedStripIds);
  }, [selectedStripIds, createStripGroupFromIds]);

  const mergeSelectedStrips = useCallback(() => {
    const selected = new Set(selectedStripIds);
    // Merge in displayed wire (chain) order — the list order the user sees.
    const picked = orderedStrips.filter(s => selected.has(s.id));
    if (picked.length < 2) return;

    const first = picked[0];
    const pickedIds = new Set(picked.map(s => s.id));
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => pickedIds.has(m.stripId || m.pathId)))
      .map(g => g.groupId));
    const mergedId = nextStripId(strips);
    const mergedName = stripSelectionName.trim() || `Merged Strip ${strips.length - picked.length + 1}`;
    const pixels = picked.flatMap(s => s.pixels?.length ? s.pixels : []);
    const mergedStrip = {
      ...first,
      id: mergedId,
      // Merged from several strips: no single artwork source.
      sourceLayerId: null, sourcePathId: null,
      name: mergedName,
      pathData: picked.map(s => translatePathData(s.pathData, s.x || 0, s.y || 0)).filter(Boolean).join(' '),
      pixelCount: picked.reduce((sum, s) => sum + (s.pixelCount || 0), 0),
      pixels,
      x: 0,
      y: 0,
      color: first.color || nextColor(),
      reversed: false,
      mergedFrom: picked.map(s => ({ id: s.id, name: s.name, pixelCount: s.pixelCount })),
    };
    const insertAt = strips.findIndex(s => pickedIds.has(s.id));
    const remaining = strips.filter(s => !pickedIds.has(s.id));
    const newStrips = [...remaining];
    newStrips.splice(Math.max(0, insertAt), 0, mergedStrip);

    pushLayoutHistory();
    setLayerGroups(prev => prev
      .map(g => ({ ...g, members: g.members.filter(m => !pickedIds.has(m.stripId || m.pathId)) }))
      .filter(g => g.members.length > 0));
    setLayerOrder(prev => prev.filter(item => !emptiedGroupIds.has(item.id)));
    setStrips(newStrips);
    setHidden(prev => {
      const next = { ...prev };
      pickedIds.forEach(id => { delete next[id]; });
      return next;
    });
    selectStrip(mergedId);
    scrollToStrip(mergedId);
  }, [selectedStripIds, strips, orderedStrips, stripSelectionName, layerGroups, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrip]);

  const removeSelectedStrips = useCallback(() => {
    const selected = new Set(selectedStripIds);
    if (selected.size < 2) return;
    const newStrips = strips.filter(s => !selected.has(s.id));
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => selected.has(m.stripId || m.pathId)))
      .map(g => g.groupId));
    pushLayoutHistory();
    setStrips(newStrips);
    setLayerGroups(prev => prev
      .map(g => ({ ...g, members: g.members.filter(m => !selected.has(m.stripId || m.pathId)) }))
      .filter(g => g.members.length > 0));
    setLayerOrder(prev => prev.filter(item => !emptiedGroupIds.has(item.id)));
    setHidden(prev => {
      const next = { ...prev };
      selected.forEach(id => { delete next[id]; });
      return next;
    });
    clearLayoutSelection();
  }, [selectedStripIds, strips, layers, editCounts, hidden, svgText, viewBox, density, layerGroups, pushLayoutHistory, clearLayoutSelection]);

  // Drag a strip row onto another to change the physical wire order. Only the
  // patch-board chain moves — the strips[] array order is never touched by
  // reordering. moveStripRowsInChain moves each dragged strip's patches as one
  // contiguous block (splits preserved, off rows pinned to their slots). One
  // gesture = one undo entry (updatePatchBoard pushes history exactly once).
  const reorderStripRows = useCallback((draggedIds, targetId) => {
    const ids = (draggedIds || []).filter(Boolean);
    if (!ids.length || ids.includes(targetId)) return;
    updatePatchBoard(board => {
      // moveStripRowsInChain returns a normalized copy; write its result back
      // onto the mutable board `updatePatchBoard` hands us.
      const moved = moveStripRowsInChain(board, ids, targetId);
      board.patches = moved.patches;
      board.chains = moved.chains;
      board.groups = moved.groups;
      board.physicalLocked = moved.physicalLocked;
    });
  }, [updatePatchBoard]);

  return {
    updateStrip,
    updateStripWithHistory,
    setStripOffset,
    removeStrip,
    reverseStrip,
    renameStrip,
    duplicateStrip,
    addPrimitiveStrip,
    scaleStrip,
    createStripGroupFromIds,
    addStripsToGroup,
    groupSelectedStrips,
    mergeSelectedStrips,
    removeSelectedStrips,
    reorderStripRows,
  };
}
