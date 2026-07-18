// Pure reducer over the Layout screen's state slice.
//
// This module is intentionally UNWIRED in Phase 1 — nothing dispatches through
// it yet. It exists so that Phase 1 step 6 (ProjectContext useReducer) and step 7
// (LayoutScreen dispatching) become mechanical: every mutation LayoutScreen does
// today has a matching action here, expressed as a pure state → state transform.
//
// Purity contract: the reducer never touches the DOM. Anything that requires
// geometry sampling (LED pixel positions) is supplied by the caller as a payload
// — strips arrive with their `pixels` already sampled, density/scale/calibrate
// arrive with the recounted strips, etc. Snapshots drop `pixels` and rebuild them
// on apply via an injected `rebuild` function (the real app passes its
// DOM-backed sampler; tests pass a stub).

import { createDefaultPatchBoard, normalizePatchBoard } from '../lib/patchBoard.js';
import { stripSourceKey } from '../lib/layoutGeometry.js';

// The layout state slice. `selection` is the single selection model that replaces
// the scattered selLayerId / selStripId / selectedStripIds / pathSel booleans.
//   selection = { kind: 'none'|'strip'|'layer'|'path', ids: [], entries: [], name: '' }
// (`entries` carries the bulky path objects for path selections and is dropped
// from snapshots.)

const DEFAULT_VIEWBOX = '0 0 640 400';
const DEFAULT_PX_PER_MM = 3.7795;
const DEFAULT_DENSITY = 60;

export const LAYOUT_HISTORY_LIMIT = 50;

function emptySelection() {
  return { kind: 'none', ids: [], entries: [], name: '' };
}

// Highest `strip-<n>` number already in use, +1.
function seqFromStrips(strips = []) {
  let max = 0;
  for (const strip of strips) {
    const match = /^strip-(\d+)$/.exec(strip?.id || '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function createLayoutState(init = {}) {
  const strips = Array.isArray(init.strips) ? [...init.strips] : [];
  return {
    strips,
    starterPending: init.starterPending === true,
    layers: init.layers || [],
    layerGroups: init.layerGroups || [],
    layerOrder: init.layerOrder || [],
    editCounts: init.editCounts || {},
    stripCountOverrides: init.stripCountOverrides || {},
    hidden: init.hidden || {},
    svgText: init.svgText ?? null,
    viewBox: init.viewBox || DEFAULT_VIEWBOX,
    density: Number.isFinite(init.density) ? init.density : DEFAULT_DENSITY,
    pxPerMm: Number.isFinite(init.pxPerMm) ? init.pxPerMm : DEFAULT_PX_PER_MM,
    patchBoard: init.patchBoard || createDefaultPatchBoard(strips),
    nextStripSeq: Number.isFinite(init.nextStripSeq) ? init.nextStripSeq : seqFromStrips(strips),
    selection: init.selection || emptySelection(),
  };
}

// ── Action types ────────────────────────────────────────────────────────────

export const LayoutActions = Object.freeze({
  // Strips
  ADD_STRIP: 'layout/addStrip',
  ADD_STRIPS: 'layout/addStrips',
  REMOVE_STRIP: 'layout/removeStrip',
  REMOVE_STRIPS: 'layout/removeStrips',
  REVERSE_STRIP: 'layout/reverseStrip',
  DUPLICATE_STRIP: 'layout/duplicateStrip',
  MERGE_STRIPS: 'layout/mergeStrips',
  GROUP_STRIPS: 'layout/groupStrips',
  UPDATE_STRIP: 'layout/updateStrip',
  SET_STRIP_OFFSET: 'layout/setStripOffset',
  SET_STRIP_COUNT_OVERRIDES: 'layout/setStripCountOverrides',
  // Layers
  SET_ARTWORK: 'layout/setArtwork',
  DELETE_LAYER: 'layout/deleteLayer',
  RENAME_LAYER: 'layout/renameLayer',
  REORDER_LAYER_ORDER: 'layout/reorderLayerOrder',
  DELETE_LAYER_GROUP: 'layout/deleteLayerGroup',
  // Derivation chain
  SET_DENSITY: 'layout/setDensity',
  SET_SCALE: 'layout/setScale',
  CALIBRATE: 'layout/calibrate',
  // Patch board
  SET_PATCH_BOARD: 'layout/setPatchBoard',
  // Selection
  SELECT_STRIP: 'layout/selectStrip',
  SELECT_STRIPS: 'layout/selectStrips',
  TOGGLE_STRIP: 'layout/toggleStrip',
  SELECT_LAYER: 'layout/selectLayer',
  SELECT_PATHS: 'layout/selectPaths',
  TOGGLE_PATH: 'layout/togglePath',
  CLEAR_SELECTION: 'layout/clearSelection',
  RENAME_SELECTION: 'layout/renameSelection',
});

// Selection-only actions never create an undo entry (parity with today, where
// selecting never pushed history).
const SELECTION_ACTIONS = new Set([
  LayoutActions.SELECT_STRIP,
  LayoutActions.SELECT_STRIPS,
  LayoutActions.TOGGLE_STRIP,
  LayoutActions.SELECT_LAYER,
  LayoutActions.SELECT_PATHS,
  LayoutActions.TOGGLE_PATH,
  LayoutActions.CLEAR_SELECTION,
  LayoutActions.RENAME_SELECTION,
]);

export function isUndoableLayoutAction(action) {
  return !SELECTION_ACTIONS.has(action?.type);
}

// ── Action creators ───────────────────────────────────────────────────────

export const layoutActions = {
  addStrip: strip => ({ type: LayoutActions.ADD_STRIP, strip }),
  addStrips: (strips, group = null) => ({ type: LayoutActions.ADD_STRIPS, strips, group }),
  removeStrip: id => ({ type: LayoutActions.REMOVE_STRIP, id }),
  removeStrips: ids => ({ type: LayoutActions.REMOVE_STRIPS, ids }),
  reverseStrip: id => ({ type: LayoutActions.REVERSE_STRIP, id }),
  duplicateStrip: id => ({ type: LayoutActions.DUPLICATE_STRIP, id }),
  mergeStrips: (ids, merged) => ({ type: LayoutActions.MERGE_STRIPS, ids, merged }),
  groupStrips: (ids, groupId, name = '') => ({ type: LayoutActions.GROUP_STRIPS, ids, groupId, name }),
  updateStrip: (id, patch) => ({ type: LayoutActions.UPDATE_STRIP, id, patch }),
  setStripOffset: (id, x, y, pixels = null) => ({ type: LayoutActions.SET_STRIP_OFFSET, id, x, y, pixels }),
  setStripCountOverrides: overrides => ({ type: LayoutActions.SET_STRIP_COUNT_OVERRIDES, overrides }),
  setArtwork: payload => ({ type: LayoutActions.SET_ARTWORK, ...payload }),
  deleteLayer: layerId => ({ type: LayoutActions.DELETE_LAYER, layerId }),
  renameLayer: (layerId, name) => ({ type: LayoutActions.RENAME_LAYER, layerId, name }),
  reorderLayerOrder: (fromId, toId) => ({ type: LayoutActions.REORDER_LAYER_ORDER, fromId, toId }),
  deleteLayerGroup: groupId => ({ type: LayoutActions.DELETE_LAYER_GROUP, groupId }),
  setDensity: (density, strips) => ({ type: LayoutActions.SET_DENSITY, density, strips }),
  setScale: (pxPerMm, strips) => ({ type: LayoutActions.SET_SCALE, pxPerMm, strips }),
  calibrate: (pxPerMm, strips) => ({ type: LayoutActions.CALIBRATE, pxPerMm, strips }),
  setPatchBoard: patchBoard => ({ type: LayoutActions.SET_PATCH_BOARD, patchBoard }),
  selectStrip: id => ({ type: LayoutActions.SELECT_STRIP, id }),
  selectStrips: ids => ({ type: LayoutActions.SELECT_STRIPS, ids }),
  toggleStrip: id => ({ type: LayoutActions.TOGGLE_STRIP, id }),
  selectLayer: layerId => ({ type: LayoutActions.SELECT_LAYER, layerId }),
  selectPaths: entries => ({ type: LayoutActions.SELECT_PATHS, entries }),
  togglePath: entry => ({ type: LayoutActions.TOGGLE_PATH, entry }),
  clearSelection: () => ({ type: LayoutActions.CLEAR_SELECTION }),
  renameSelection: name => ({ type: LayoutActions.RENAME_SELECTION, name }),
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const stripSelection = ids => ({ kind: 'strip', ids: [...ids], entries: [], name: '' });

// Keep the patch board's strip patches in sync with the live strips (mirrors the
// ensureStripPatches path that runs on every project load).
const resyncBoard = (patchBoard, strips) => normalizePatchBoard(patchBoard, strips);

// Drop a set of strip ids from the strip-keyed maps + group members + selection,
// so no stale/reusable id keeps a hidden flag or group membership.
function pruneRemovedStrips(state, removedIds, extra = {}) {
  const removed = new Set(removedIds);
  const strips = state.strips.filter(s => !removed.has(s.id));
  const hidden = { ...state.hidden };
  const editCounts = { ...state.editCounts };
  const stripCountOverrides = { ...state.stripCountOverrides };
  for (const id of removed) {
    delete hidden[id];
    delete editCounts[id];
    delete stripCountOverrides[id];
  }
  const layerGroups = state.layerGroups
    .map(g => ({ ...g, members: g.members.filter(m => !removed.has(m.stripId)) }))
    .filter(g => g.members.length > 0);
  const liveGroupIds = new Set(layerGroups.map(g => g.groupId));
  const layerOrder = state.layerOrder.filter(item =>
    item.type === 'group' ? liveGroupIds.has(item.id) : true);
  const selection = state.selection.kind === 'strip'
    ? (() => {
        const ids = state.selection.ids.filter(id => !removed.has(id));
        return ids.length ? { ...state.selection, ids } : emptySelection();
      })()
    : state.selection;
  return {
    ...state,
    strips,
    hidden,
    editCounts,
    stripCountOverrides,
    layerGroups,
    layerOrder,
    patchBoard: resyncBoard(state.patchBoard, strips),
    selection,
    ...extra,
  };
}

function stripGroupMember(strip) {
  return {
    type: 'strip',
    stripId: strip.id,
    pathId: stripSourceKey(strip),
    layerId: stripSourceKey(strip),
    pathData: strip.pathData,
    name: strip.name,
    svgLength: strip.svgLength || 0,
    pixelCount: strip.pixelCount,
    color: strip.color,
  };
}

// ── Reducer ─────────────────────────────────────────────────────────────────

export function layoutReducer(state, action) {
  switch (action.type) {
    case LayoutActions.ADD_STRIP: {
      const id = `strip-${state.nextStripSeq}`;
      const strip = { ...action.strip, id };
      // Replace any existing strip that shares this artwork source (re-sample).
      const strips = [...state.strips, strip];
      return {
        ...state,
        strips,
        nextStripSeq: state.nextStripSeq + 1,
        patchBoard: resyncBoard(state.patchBoard, strips),
        selection: stripSelection([id]),
      };
    }

    case LayoutActions.ADD_STRIPS: {
      let seq = state.nextStripSeq;
      const created = (action.strips || []).map(s => ({ ...s, id: `strip-${seq++}` }));
      const strips = [...state.strips, ...created];
      let layerGroups = state.layerGroups;
      let layerOrder = state.layerOrder;
      if (action.group && created.length > 1) {
        const group = {
          groupId: action.group.groupId,
          type: 'strip',
          name: action.group.name || `Strip Group ${state.layerGroups.length + 1}`,
          _hidden: false,
          _expanded: true,
          members: created.map(stripGroupMember),
        };
        layerGroups = [...state.layerGroups, group];
        layerOrder = [{ type: 'group', id: group.groupId }, ...state.layerOrder];
      }
      return {
        ...state,
        strips,
        layerGroups,
        layerOrder,
        nextStripSeq: seq,
        patchBoard: resyncBoard(state.patchBoard, strips),
        selection: stripSelection(created.map(s => s.id)),
      };
    }

    case LayoutActions.REMOVE_STRIP:
      return pruneRemovedStrips(state, [action.id]);

    case LayoutActions.REMOVE_STRIPS:
      return pruneRemovedStrips(state, action.ids || []);

    case LayoutActions.REVERSE_STRIP: {
      const strips = state.strips.map(s => s.id !== action.id ? s : {
        ...s,
        reversed: !s.reversed,
        pixels: (s.pixels || []).slice().reverse(),
      });
      return { ...state, strips };
    }

    case LayoutActions.DUPLICATE_STRIP: {
      const source = state.strips.find(s => s.id === action.id);
      if (!source) return state;
      const id = `strip-${state.nextStripSeq}`;
      const dup = {
        ...source,
        id,
        name: `${source.name} copy`,
        sourceLayerId: null,
        sourcePathId: null,
        pixels: (source.pixels || []).slice(),
      };
      const strips = state.strips.flatMap(s => s.id === action.id ? [s, dup] : [s]);
      return {
        ...state,
        strips,
        nextStripSeq: state.nextStripSeq + 1,
        patchBoard: resyncBoard(state.patchBoard, strips),
        selection: stripSelection([id]),
      };
    }

    case LayoutActions.MERGE_STRIPS: {
      const picked = new Set(action.ids || []);
      const members = state.strips.filter(s => picked.has(s.id));
      if (members.length < 2) return state;
      const id = `strip-${state.nextStripSeq}`;
      const merged = { ...action.merged, id, sourceLayerId: null, sourcePathId: null };
      const insertAt = state.strips.findIndex(s => picked.has(s.id));
      const remaining = state.strips.filter(s => !picked.has(s.id));
      const strips = [...remaining];
      strips.splice(Math.max(0, insertAt), 0, merged);
      return {
        ...pruneRemovedStrips({ ...state, nextStripSeq: state.nextStripSeq + 1 }, [...picked], {}),
        strips,
        patchBoard: resyncBoard(state.patchBoard, strips),
        selection: stripSelection([id]),
      };
    }

    case LayoutActions.GROUP_STRIPS: {
      const ids = [...new Set(action.ids || [])];
      const picked = state.strips.filter(s => ids.includes(s.id));
      if (picked.length < 2) return state;
      const pickedIds = new Set(picked.map(s => s.id));
      const group = {
        groupId: action.groupId,
        type: 'strip',
        name: action.name || `Strip Group ${state.layerGroups.length + 1}`,
        _hidden: false,
        _expanded: true,
        members: picked.map(stripGroupMember),
      };
      const layerGroups = [
        ...state.layerGroups
          .map(g => ({ ...g, members: g.members.filter(m => !pickedIds.has(m.stripId)) }))
          .filter(g => g.members.length > 0),
        group,
      ];
      const layerOrder = [
        { type: 'group', id: group.groupId },
        ...state.layerOrder.filter(item => item.id !== group.groupId),
      ];
      return { ...state, layerGroups, layerOrder, selection: stripSelection(picked.map(s => s.id)) };
    }

    case LayoutActions.UPDATE_STRIP: {
      const strips = state.strips.map(s => s.id === action.id ? { ...s, ...action.patch } : s);
      return { ...state, strips };
    }

    case LayoutActions.SET_STRIP_OFFSET: {
      const strips = state.strips.map(s => {
        if (s.id !== action.id) return s;
        const next = { ...s, x: action.x, y: action.y };
        if (action.pixels) next.pixels = action.pixels;
        return next;
      });
      return { ...state, strips };
    }

    case LayoutActions.SET_STRIP_COUNT_OVERRIDES:
      return { ...state, stripCountOverrides: { ...action.overrides } };

    case LayoutActions.SET_ARTWORK:
      return {
        ...state,
        svgText: action.svgText ?? null,
        viewBox: action.viewBox || DEFAULT_VIEWBOX,
        layers: action.layers || [],
        layerOrder: action.layerOrder || (action.layers || []).map(l => ({ type: 'layer', id: l.layerId })),
        pxPerMm: Number.isFinite(action.pxPerMm) ? action.pxPerMm : state.pxPerMm,
      };

    case LayoutActions.DELETE_LAYER: {
      const layer = state.layers.find(l => l.layerId === action.layerId);
      const relatedPathIds = new Set([
        action.layerId,
        ...(layer?.subPaths || []).map(p => p.pathId),
      ]);
      const removedIds = state.strips
        .filter(s => relatedPathIds.has(stripSourceKey(s)))
        .map(s => s.id);
      const layers = state.layers.filter(l => l.layerId !== action.layerId);
      const layerGroups = state.layerGroups
        .map(g => ({ ...g, members: g.members.filter(m => m.layerId !== action.layerId) }))
        .filter(g => g.members.length > 0);
      const layerOrder = state.layerOrder.filter(x => x.id !== action.layerId);
      const editCounts = { ...state.editCounts };
      const hidden = { ...state.hidden };
      relatedPathIds.forEach(id => { delete editCounts[id]; delete hidden[id]; });
      const base = { ...state, layers, layerGroups, layerOrder, editCounts, hidden };
      const selection = state.selection.kind === 'layer' && state.selection.ids.includes(action.layerId)
        ? emptySelection()
        : base.selection;
      return pruneRemovedStrips({ ...base, selection }, removedIds);
    }

    case LayoutActions.RENAME_LAYER: {
      const layers = state.layers.map(l => l.layerId === action.layerId ? { ...l, name: action.name } : l);
      return { ...state, layers };
    }

    case LayoutActions.REORDER_LAYER_ORDER: {
      if (action.fromId === action.toId) return state;
      const fi = state.layerOrder.findIndex(x => x.id === action.fromId);
      const ti = state.layerOrder.findIndex(x => x.id === action.toId);
      if (fi === -1 || ti === -1) return state;
      const layerOrder = [...state.layerOrder];
      const [removed] = layerOrder.splice(fi, 1);
      layerOrder.splice(ti, 0, removed);
      return { ...state, layerOrder };
    }

    case LayoutActions.DELETE_LAYER_GROUP: {
      const layerGroups = state.layerGroups.filter(g => g.groupId !== action.groupId);
      const layerOrder = state.layerOrder.filter(x => x.id !== action.groupId);
      return { ...state, layerGroups, layerOrder };
    }

    case LayoutActions.SET_DENSITY: {
      const strips = action.strips || state.strips;
      return {
        ...state,
        density: action.density,
        strips,
        editCounts: {},
        patchBoard: resyncBoard(state.patchBoard, strips),
      };
    }

    case LayoutActions.SET_SCALE:
    case LayoutActions.CALIBRATE: {
      const strips = action.strips || state.strips;
      return {
        ...state,
        pxPerMm: action.pxPerMm,
        strips,
        editCounts: {},
        patchBoard: resyncBoard(state.patchBoard, strips),
      };
    }

    case LayoutActions.SET_PATCH_BOARD:
      return { ...state, patchBoard: action.patchBoard };

    // ── Selection ───────────────────────────────────────────────────────────

    case LayoutActions.SELECT_STRIP:
      return { ...state, selection: stripSelection([action.id]) };

    case LayoutActions.SELECT_STRIPS: {
      const ids = [...new Set((action.ids || []).filter(Boolean))];
      return { ...state, selection: ids.length ? stripSelection(ids) : emptySelection() };
    }

    case LayoutActions.TOGGLE_STRIP: {
      const base = state.selection.kind === 'strip' ? state.selection.ids : [];
      const ids = base.includes(action.id)
        ? base.filter(x => x !== action.id)
        : [...base, action.id];
      return { ...state, selection: ids.length ? stripSelection(ids) : emptySelection() };
    }

    case LayoutActions.SELECT_LAYER:
      return { ...state, selection: { kind: 'layer', ids: [action.layerId], entries: [], name: '' } };

    case LayoutActions.SELECT_PATHS: {
      const entries = (action.entries || []).filter(e => e?.pathId);
      return {
        ...state,
        selection: {
          kind: entries.length ? 'path' : 'none',
          ids: entries.map(e => e.pathId),
          entries,
          name: entries.length === 1 ? (entries[0].name || '') : '',
        },
      };
    }

    case LayoutActions.TOGGLE_PATH: {
      const entry = action.entry;
      if (!entry?.pathId) return state;
      const base = state.selection.kind === 'path' ? state.selection.entries : [];
      const has = base.some(e => e.pathId === entry.pathId);
      const entries = has ? base.filter(e => e.pathId !== entry.pathId) : [...base, entry];
      return {
        ...state,
        selection: {
          kind: entries.length ? 'path' : 'none',
          ids: entries.map(e => e.pathId),
          entries,
          name: entries.length === 1 ? (entries[0].name || '') : '',
        },
      };
    }

    case LayoutActions.CLEAR_SELECTION:
      return { ...state, selection: emptySelection() };

    case LayoutActions.RENAME_SELECTION:
      return { ...state, selection: { ...state.selection, name: action.name } };

    default:
      return state;
  }
}

// ── Snapshots + history ─────────────────────────────────────────────────────

// A snapshot is the persisted+undoable slice with strip `pixels` dropped (rebuilt
// on apply) and the bulky path-selection `entries` dropped.
export function makeLayoutSnapshot(state) {
  return {
    strips: state.strips.map(({ pixels, ...rest }) => rest),
    starterPending: state.starterPending === true,
    layers: state.layers,
    layerGroups: state.layerGroups,
    layerOrder: state.layerOrder,
    editCounts: state.editCounts,
    stripCountOverrides: state.stripCountOverrides,
    hidden: state.hidden,
    svgText: state.svgText,
    viewBox: state.viewBox,
    density: state.density,
    pxPerMm: state.pxPerMm,
    patchBoard: state.patchBoard,
    nextStripSeq: state.nextStripSeq,
    selection: { kind: state.selection.kind, ids: [...state.selection.ids], name: state.selection.name },
  };
}

// Rebuild strip pixels when applying a snapshot. The real app injects its
// DOM-backed sampler; the default leaves strips untouched (used only when a
// caller has no sampler, e.g. tests that assert structural round-trips).
const identityRebuild = strip => strip;

export function applyLayoutSnapshot(state, snap, rebuild = identityRebuild) {
  return {
    ...state,
    strips: snap.strips.map(s => rebuild(s)),
    starterPending: snap.starterPending === true,
    layers: snap.layers,
    layerGroups: snap.layerGroups,
    layerOrder: snap.layerOrder,
    editCounts: snap.editCounts,
    stripCountOverrides: snap.stripCountOverrides,
    hidden: snap.hidden,
    svgText: snap.svgText,
    viewBox: snap.viewBox,
    density: snap.density,
    pxPerMm: snap.pxPerMm,
    patchBoard: snap.patchBoard,
    nextStripSeq: snap.nextStripSeq,
    selection: { kind: snap.selection.kind, ids: [...snap.selection.ids], entries: [], name: snap.selection.name },
  };
}

export function createLayoutHistory() {
  return { past: [], future: [] };
}

function bounded(stack) {
  return stack.length > LAYOUT_HISTORY_LIMIT ? stack.slice(stack.length - LAYOUT_HISTORY_LIMIT) : stack;
}

// Apply an action, recording the pre-action snapshot for undo when the action is
// state-mutating (selection-only actions do not create undo entries).
export function commitLayout(history, state, action, rebuild = identityRebuild) {
  const next = layoutReducer(state, action);
  if (next === state || !isUndoableLayoutAction(action)) {
    return { history, state: next };
  }
  return {
    history: { past: bounded([...history.past, makeLayoutSnapshot(state)]), future: [] },
    state: next,
  };
}

export function undoLayout(history, state, rebuild = identityRebuild) {
  if (!history.past.length) return { history, state };
  const past = history.past.slice();
  const snap = past.pop();
  const future = bounded([...history.future, makeLayoutSnapshot(state)]);
  return { history: { past, future }, state: applyLayoutSnapshot(state, snap, rebuild) };
}

export function redoLayout(history, state, rebuild = identityRebuild) {
  if (!history.future.length) return { history, state };
  const future = history.future.slice();
  const snap = future.pop();
  const past = bounded([...history.past, makeLayoutSnapshot(state)]);
  return { history: { past, future }, state: applyLayoutSnapshot(state, snap, rebuild) };
}
