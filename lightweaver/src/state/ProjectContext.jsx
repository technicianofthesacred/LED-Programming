import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, useReducer } from 'react';
import { useWled } from '../hooks/useWled.js';
import { useUsbLed } from '../hooks/useUsbLed.js';
import { samplePath } from '../lib/mapper.js';
import { normalizeStripPixelCount, shouldRebuildStripPixels } from '../lib/stripPixels.js';
import {
  DEFAULT_AUTO_LANES,
  DEFAULT_CLIPS,
  DEFAULT_CUES,
  DEFAULT_TRANSITIONS,
} from './ProjectDefaults.js';
import {
  createDefaultProject,
  DEFAULT_SYM_SETTINGS,
  defaultStandaloneController,
  migrateProject,
  PROJECT_VERSION,
  resolveStartupProject,
} from '../lib/projectModel.js';
import { recordLivePattern as buildLiveRecording } from '../lib/liveRecorder.js';
import { easeCrossfade } from '../lib/motionSmoothing.js';
import { PATTERNS } from '../lib/patterns-library.js';
import { createDefaultPatchBoard, normalizePatchBoard } from '../lib/patchBoard.js';
import { compileWiring } from '../lib/wiringCompiler.js';
import { invalidateWiringVerification, makeDefaultWiring, migrateWiring, physicalChangeKindForCompatField, standaloneControllerPhysicalChangeKind, updateWiring as mutateWiring } from '../lib/wiringModel.js';
import {
  createLayoutState,
  createLayoutHistory,
  layoutReducer,
  layoutActions,
  makeLayoutSnapshot,
  applyLayoutSnapshot,
  LAYOUT_HISTORY_LIMIT,
} from './layoutReducer.js';
import { resolveRotaryInputAction, selectFreshUsbRotaryEvents } from '../lib/usbRotaryInput.js';
import {
  readStorageJsonWithBackup,
  writeStorageJsonWithBackup,
} from '../lib/projectStorage.js';
import {
  createProjectLifecycle,
  hasUnsavedChanges,
  lifecycleLabel,
  markEdited,
  markInstalled,
  markPersisted,
  replaceProjectSafely,
} from '../lib/projectLifecycle.js';

const LS_AUTOSAVE_KEY = 'lw_autosave_v3';
const LS_AUTOSAVE_BACKUP_KEY = 'lw_autosave_v3_backup';
const LS_AUTOSAVE_LEGACY_KEY = 'lw_autosave_v1';
const LS_LAYOUT_LEGACY_KEY = 'lw-layout-autosave';

const ProjectContext = createContext(null);

function restoreStripPixels(strips = []) {
  if (typeof document === 'undefined') return strips;
  return strips.map(strip => {
    if (!shouldRebuildStripPixels(strip)) return strip;
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', strip.pathData);
    let pixels = samplePath(pathEl, normalizeStripPixelCount(strip));
    if (strip.reversed) pixels = pixels.slice().reverse();
    const dx = strip.x || 0;
    const dy = strip.y || 0;
    if (dx || dy) pixels = pixels.map(pixel => ({ ...pixel, x: pixel.x + dx, y: pixel.y + dy }));
    return { ...strip, pixelCount: normalizeStripPixelCount(strip), pixels };
  });
}

// ── Layout slice reducer (state consolidation) ────────────────────────────
// The layout slice lives in a useReducer so undo/redo is a single snapshot
// stack shared across strip + patch-board edits. `_history` rides on the same
// state object; makeLayoutSnapshot ignores it (it picks named fields) and the
// undo/redo/reset handlers overwrite it explicitly.

// Rebuild a single strip's pixels when applying a snapshot (DOM-backed sampler).
function rebuildSnapshotStrip(strip) {
  const [rebuilt] = restoreStripPixels([strip]);
  return rebuilt;
}

function pushSnapshotStack(stack, snapshot) {
  const next = [...stack, snapshot];
  return next.length > LAYOUT_HISTORY_LIMIT ? next.slice(next.length - LAYOUT_HISTORY_LIMIT) : next;
}

function makeInitialLayoutState(layout) {
  return {
    ...createLayoutState({
      strips: layout.strips,
      starterPending: layout.starterPending,
      layers: layout.layers,
      layerGroups: layout.layerGroups,
      layerOrder: layout.layerOrder,
      editCounts: layout.editCounts,
      hidden: layout.hidden || {},
      svgText: layout.svgText ?? null,
      viewBox: layout.viewBox || '0 0 640 400',
      density: layout.density,
      pxPerMm: layout.pxPerMm,
      patchBoard: normalizePatchBoard(layout.patchBoard, layout.strips),
    }),
    wiring: migrateWiring(layout.wiring, layout.strips, layout.patchBoard),
    _history: createLayoutHistory(),
  };
}

function layoutRootReducer(state, action) {
  const physicalChangeKinds = {
    'layout/addStrip': 'geometry',
    'layout/addStrips': 'geometry',
    'layout/removeStrip': 'geometry',
    'layout/removeStrips': 'geometry',
    'layout/reverseStrip': 'direction',
    'layout/duplicateStrip': 'geometry',
    'layout/mergeStrips': 'route',
    'layout/updateStrip': 'geometry',
    'layout/setStripOffset': 'geometry',
    'layout/setStripCountOverrides': 'led-count',
    'layout/setArtwork': 'geometry',
    'layout/deleteLayer': 'geometry',
    'layout/setDensity': 'led-count',
    'layout/setScale': 'geometry',
    'layout/calibrate': 'geometry',
    'layout/updatePatchBoard': 'route',
    'layout/replaceGeometry': 'geometry',
  };
  const physicalChangeKind = action.changeKind ||
    (action.type === 'compat/set' ? physicalChangeKindForCompatField(action.field) : physicalChangeKinds[action.type]);
  const boundary = invalidateWiringVerification(state.wiring, { kind: physicalChangeKind, runIds: action.runIds });
  if (!boundary.ok) return state;
  const finishMutation = next => {
    const withWiring = boundary.wiring !== state.wiring ? { ...next, wiring: boundary.wiring } : next;
    return physicalChangeKind ? { ...withWiring, starterPending: false } : withWiring;
  };
  switch (action.type) {
    // Compat setter — mirrors a single useState field; never records history.
    case 'compat/set': {
      const current = state[action.field];
      const value = typeof action.value === 'function' ? action.value(current) : action.value;
      if (value === current) return state;
      return finishMutation({ ...state, [action.field]: value });
    }
    // Snapshot current state as one undo entry (called before a mutation).
    case 'layout/pushHistory':
      return {
        ...state,
        _history: { past: pushSnapshotStack(state._history.past, { ...makeLayoutSnapshot(state), wiring: state.wiring }), future: [] },
      };
    // Patch-board edit (mutating callback over a normalized board copy).
    case 'layout/updatePatchBoard': {
      const board = normalizePatchBoard(state.patchBoard, state.strips);
      action.mutate(board);
      return finishMutation({ ...state, patchBoard: normalizePatchBoard(board, state.strips) });
    }
    case 'layout/setWiring':
      return { ...state, wiring: action.wiring };
    case 'layout/replaceGeometry': {
      const snapshot = { ...makeLayoutSnapshot(state), wiring: state.wiring };
      return {
        ...state,
        strips: action.strips,
        starterPending: false,
        hidden: {},
        editCounts: {},
        stripCountOverrides: {},
        layerGroups: [],
        layerOrder: [],
        patchBoard: action.patchBoard,
        wiring: action.wiring,
        selection: { kind: 'none', ids: [], entries: [], name: '' },
        nextStripSeq: action.nextStripSeq,
        _history: {
          past: pushSnapshotStack(state._history.past, snapshot),
          future: [],
        },
      };
    }
    case 'layout/undo': {
      if (!state._history.past.length) return state;
      const past = state._history.past.slice();
      const snap = past.pop();
      const future = pushSnapshotStack(state._history.future, { ...makeLayoutSnapshot(state), wiring: state.wiring });
      const applied = applyLayoutSnapshot(state, snap, rebuildSnapshotStrip);
      return { ...applied, wiring: snap.wiring || state.wiring, _history: { past, future } };
    }
    case 'layout/redo': {
      if (!state._history.future.length) return state;
      const future = state._history.future.slice();
      const snap = future.pop();
      const past = pushSnapshotStack(state._history.past, { ...makeLayoutSnapshot(state), wiring: state.wiring });
      const applied = applyLayoutSnapshot(state, snap, rebuildSnapshotStrip);
      return { ...applied, wiring: snap.wiring || state.wiring, _history: { past, future } };
    }
    // Load a project: reset the slice AND clear history (not undoable back).
    case 'layout/reset':
      return { ...createLayoutState(action.init), wiring: action.init.wiring, _history: createLayoutHistory() };
    // Selection + any structured layout action flow through the pure reducer
    // (selection actions never create undo entries).
    default:
      return finishMutation(layoutReducer(state, action));
  }
}

// ── Interpolate automation lane value at a given time ─────────────────────
export function sampleLane(lane, t) {
  const keys = lane.keys;
  if (!keys || keys.length === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      const f = (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * f;
    }
  }
  return 0;
}

// ── Resolve active pattern + blend from playhead ──────────────────────────
export function resolveTimelinePlayback(playhead, clips, transitions) {
  const track0Clips = clips.filter(c => (c.track ?? 0) === 0 && (!c.target || c.target === 'all'));
  const active = track0Clips.find(c => playhead >= c.start && playhead <= c.end) || null;
  const trans  = transitions.find(t => playhead >= t.start && playhead <= t.end) || null;

  const rawBlend = trans && trans.end > trans.start
    ? Math.max(0, Math.min(1, (playhead - trans.start) / (trans.end - trans.start)))
    : 0;
  const blend = trans ? easeCrossfade(rawBlend, trans.curve || 'linear') : 0;
  const nextClip = trans ? clips.find(c => c.id === trans.clipB && (!c.target || c.target === 'all')) : null;

  return {
    patternId:      active?.patternId || null,
    blendPatternId: nextClip?.patternId || null,
    blendAmount:    blend,
    transType:      trans?.type || null,
    transCurve:     trans?.curve || 'linear',
  };
}

export function resolveTimelineTargets(playhead, clips, strips = []) {
  const active = clips
    .filter(c => playhead >= c.start && playhead <= c.end)
    .sort((a, b) => (a.track ?? 0) - (b.track ?? 0) || a.start - b.start);
  const globalClip = active.find(c => (c.track ?? 0) === 0 || c.target === 'all') || null;
  const byStripId = {};
  for (const clip of active) {
    if (!clip.target || clip.target === 'all') continue;
    if (clip.target === 'strip-group' && clip.group) {
      for (const strip of strips) {
        if (strip.group === clip.group || strip.layerName === clip.group || strip.name === clip.group) {
          byStripId[strip.id] = clip.patternId;
        }
      }
      continue;
    }
    byStripId[clip.target] = clip.patternId;
  }
  return { globalClip, byStripId };
}

export function ProjectProvider({ children }) {
  const defaults = createDefaultProject();
  const projectSnapshotContributorsRef = useRef(new Set());
  const replacementFocusRef = useRef(null);
  const replacementResolutionRef = useRef(null);
  const keepEditingRef = useRef(null);
  const replacementDialogRef = useRef(null);
  const replacementBackdropRef = useRef(null);
  const [pendingReplacement, setPendingReplacement] = useState(null);

  const dismissReplacement = useCallback((replace) => {
    const resolve = replacementResolutionRef.current;
    replacementResolutionRef.current = null;
    setPendingReplacement(null);
    resolve?.(replace === true);
    window.requestAnimationFrame(() => replacementFocusRef.current?.focus?.());
  }, []);

  const requestReplacementConfirmation = useCallback(({ currentName, incomingName }) => {
    replacementResolutionRef.current?.(false);
    replacementFocusRef.current = document.activeElement;
    setPendingReplacement({
      currentName: String(currentName || 'Untitled Project'),
      incomingName: String(incomingName || 'Untitled Project'),
    });
    return new Promise(resolve => { replacementResolutionRef.current = resolve; });
  }, []);

  useEffect(() => {
    if (!pendingReplacement) return undefined;
    keepEditingRef.current?.focus();
    const backdrop = replacementBackdropRef.current;
    const background = [...(backdrop?.parentElement?.children || [])]
      .filter(element => element !== backdrop)
      .map(element => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute('aria-hidden'),
      }));
    for (const { element } of background) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissReplacement(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...(replacementDialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || [])].filter(element => !element.hidden);
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !replacementDialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !replacementDialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      for (const { element, inert, ariaHidden } of background) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
    };
  }, [dismissReplacement, pendingReplacement]);

  useEffect(() => () => replacementResolutionRef.current?.(false), []);

  // ── Layout (single reducer over the whole slice; undo/redo is one shared
  //    snapshot stack across strip + patch-board edits) ────────────────────
  const [layout, dispatchLayout] = useReducer(layoutRootReducer, defaults.layout, makeInitialLayoutState);
  const [projectRevision,   setProjectRevision]   = useState(0);
  const [confirmedCardLook, setConfirmedCardLook] = useState(null);
  const [projectLifecycle, dispatchProjectLifecycle] = useReducer((state, action) => {
    if (action.type === 'edited') return markEdited(state);
    if (action.type === 'persisted') return markPersisted(state, action.destination);
    if (action.type === 'installed') return markInstalled(state, action.revision);
    if (action.type === 'replaced') return createProjectLifecycle();
    return state;
  }, undefined, createProjectLifecycle);
  const projectFingerprintRef = useRef('');
  const suppressNextLifecycleEditRef = useRef(true);

  // Live values read straight off the reducer state.
  const {
    strips,
    viewBox,
    svgText,
    hidden,
    layers: layoutLayers,
    density: layoutDensity,
    pxPerMm: layoutPxPerMm,
    editCounts: layoutEditCounts,
    stripCountOverrides: layoutStripCountOverrides,
    layerGroups: layoutLayerGroups,
    layerOrder: layoutLayerOrder,
    patchBoard,
    wiring,
    starterPending,
    selection,
  } = layout;

  // Compat setters — same signatures as the old useState setters (value or
  // updater fn) so every existing screen keeps compiling unchanged.
  const setLayoutField = useCallback((field, value) => dispatchLayout({ type: 'compat/set', field, value }), []);
  const setStrips            = useCallback(value => setLayoutField('strips', value), [setLayoutField]);
  const setViewBox           = useCallback(value => setLayoutField('viewBox', value), [setLayoutField]);
  const setSvgText           = useCallback(value => setLayoutField('svgText', value), [setLayoutField]);
  const setHidden            = useCallback(value => setLayoutField('hidden', value), [setLayoutField]);
  const setLayoutLayers      = useCallback(value => setLayoutField('layers', value), [setLayoutField]);
  const setLayoutDensity     = useCallback(value => setLayoutField('density', value), [setLayoutField]);
  const setLayoutPxPerMm     = useCallback(value => setLayoutField('pxPerMm', value), [setLayoutField]);
  const setLayoutEditCounts  = useCallback(value => setLayoutField('editCounts', value), [setLayoutField]);
  const setLayoutStripCountOverrides = useCallback(value => setLayoutField('stripCountOverrides', value), [setLayoutField]);
  const setLayoutLayerGroups = useCallback(value => setLayoutField('layerGroups', value), [setLayoutField]);
  const setLayoutLayerOrder  = useCallback(value => setLayoutField('layerOrder', value), [setLayoutField]);
  const setPatchBoard        = useCallback(value => setLayoutField('patchBoard', value), [setLayoutField]);

  // Undo history controls (single stack, shared by strip + patch-board edits).
  const pushLayoutHistory = useCallback(() => dispatchLayout({ type: 'layout/pushHistory' }), []);
  const undoLayout        = useCallback(() => dispatchLayout({ type: 'layout/undo' }), []);
  const redoLayout        = useCallback(() => dispatchLayout({ type: 'layout/redo' }), []);
  const layoutHistLen     = layout._history.past.length;
  const layoutFutLen      = layout._history.future.length;

  // Patch-board mutation that joins the undo stack (patch edits are undoable).
  const updatePatchBoard = useCallback((mutate) => {
    dispatchLayout({ type: 'layout/pushHistory' });
    dispatchLayout({ type: 'layout/updatePatchBoard', mutate });
  }, []);
  const updateWiring = useCallback((mutate, options = {}) => {
    const result = mutateWiring(wiring, mutate, { strips, ...options });
    if (!result.ok) return result;
    dispatchLayout({ type: 'layout/pushHistory' });
    dispatchLayout({ type: 'layout/setWiring', wiring: result.wiring });
    return result;
  }, [wiring, strips]);
  const replaceLayoutGeometry = useCallback((nextStrips) => {
    const normalized = Array.isArray(nextStrips) ? nextStrips : [];
    dispatchLayout({
      type: 'layout/replaceGeometry',
      strips: normalized,
      patchBoard: createDefaultPatchBoard(normalized),
      wiring: makeDefaultWiring(normalized),
      nextStripSeq: normalized.reduce((max, strip) => {
        const match = /^strip-(\d+)$/.exec(strip?.id || '');
        return match ? Math.max(max, Number(match[1]) + 1) : max;
      }, 1),
    });
  }, []);
  const compiledWiring = useMemo(() => compileWiring({ wiring, strips, groups: layoutLayerGroups }), [wiring, strips, layoutLayerGroups]);

  // Selection dispatchers (LayoutScreen's single selection model rides on these).
  const selectStrip       = useCallback(id => dispatchLayout(layoutActions.selectStrip(id)), []);
  const selectStrips      = useCallback(ids => dispatchLayout(layoutActions.selectStrips(ids)), []);
  const toggleStripSel    = useCallback(id => dispatchLayout(layoutActions.toggleStrip(id)), []);
  const selectLayer       = useCallback(layerId => dispatchLayout(layoutActions.selectLayer(layerId)), []);
  const selectPaths       = useCallback(entries => dispatchLayout(layoutActions.selectPaths(entries)), []);
  const togglePathSel     = useCallback(entry => dispatchLayout(layoutActions.togglePath(entry)), []);
  const clearLayoutSelection = useCallback(() => dispatchLayout(layoutActions.clearSelection()), []);
  const renameLayoutSelection = useCallback(name => dispatchLayout(layoutActions.renameSelection(name)), []);

  // ── Pattern ──────────────────────────────────────────────────────────────
  const [activePatternId,  setActivePatternId]  = useState('aurora');
  const [palette,          setPalette]          = useState(defaults.pattern.palette);
  const [masterSpeed,      setMasterSpeed]      = useState(1.0);
  const [masterBrightness, setMasterBrightness] = useState(1.0);
  const [masterSaturation, setMasterSaturation] = useState(1.0);
  const [gammaEnabled,     setGammaEnabled]     = useState(false);
  const [gammaValue,       setGammaValue]       = useState(2.2);
  const [masterHueShift,   setMasterHueShift]   = useState(0); // -0.5 to 0.5, added to all hues
  const [patternParams,    setPatternParams]     = useState({});
  const [bpm,              setBpm]              = useState(120);
  const [projectId,        setProjectId]        = useState(defaults.id);
  const [projectName,      setProjectName]      = useState('Untitled Project');
  const [motionSmoothing,  setMotionSmoothing]  = useState(defaults.pattern.motionSmoothing);

  // ── Timeline / show ──────────────────────────────────────────────────────
  const [showClips,        setShowClipsRaw]     = useState(DEFAULT_CLIPS);
  const [showTransitions,  setShowTransitionsRaw] = useState(DEFAULT_TRANSITIONS);
  const [showCues,         setShowCues]         = useState(DEFAULT_CUES);
  const [autoLanes,        setAutoLanes]        = useState(DEFAULT_AUTO_LANES);
  const [showDuration,     setShowDuration]     = useState(600);
  const [timelinePlaying,  setTimelinePlaying]  = useState(false);
  const [timelinePlayhead, setTimelinePlayhead] = useState(52);

  // ── Timeline undo/redo ────────────────────────────────────────────────────
  const historyRef = useRef({ past: [], future: [] });
  const skipHistoryRef = useRef(false);

  const pushHistory = useCallback((clips, trans) => {
    if (skipHistoryRef.current) return;
    historyRef.current.past.push({ clips, trans });
    if (historyRef.current.past.length > 40) historyRef.current.past.shift();
    historyRef.current.future = [];
  }, []);

  const setShowClips = useCallback((fn) => {
    setShowClipsRaw(prev => {
      const next = typeof fn === 'function' ? fn(prev) : fn;
      setShowTransitionsRaw(t => { pushHistory(prev, t); return t; });
      return next;
    });
  }, [pushHistory]);

  const setShowTransitions = useCallback((fn) => {
    setShowTransitionsRaw(prev => {
      const next = typeof fn === 'function' ? fn(prev) : fn;
      setShowClipsRaw(c => { pushHistory(c, prev); return c; });
      return next;
    });
  }, [pushHistory]);

  const undoTimeline = useCallback(() => {
    const entry = historyRef.current.past.pop();
    if (!entry) return;
    setShowClipsRaw(c => { historyRef.current.future.push({ clips: c, trans: entry.trans }); return c; });
    skipHistoryRef.current = true;
    setShowClipsRaw(entry.clips);
    setShowTransitionsRaw(entry.trans);
    setTimeout(() => { skipHistoryRef.current = false; }, 0);
  }, []);

  const redoTimeline = useCallback(() => {
    const entry = historyRef.current.future.pop();
    if (!entry) return;
    setShowClipsRaw(c => { historyRef.current.past.push({ clips: c, trans: entry.trans }); return c; });
    skipHistoryRef.current = true;
    setShowClipsRaw(entry.clips);
    setShowTransitionsRaw(entry.trans);
    setTimeout(() => { skipHistoryRef.current = false; }, 0);
  }, []);

  // ── Live recording ────────────────────────────────────────────────────────
  const [liveRecording, setLiveRecording] = useState(false);
  const [liveQuantize,  setLiveQuantize]  = useState('free'); // 'free' | 'beat' | 'bar'

  // ── Symmetry settings ────────────────────────────────────────────────────
  const [symSettings, setSymSettings] = useState({
    ...DEFAULT_SYM_SETTINGS,
  });

  // ── Device/project hardware config ───────────────────────────────────────
  const [wledSegmentMap, setWledSegmentMap] = useState(defaults.devices.segmentMap || {});
  const [physicalControls, setPhysicalControls] = useState(defaults.devices.physicalControls);
  const [controllerProfiles, setControllerProfiles] = useState(defaults.devices.controllerProfiles || []);
  const [activeControllerId, setActiveControllerId] = useState(defaults.devices.activeControllerId || '');
  const [standaloneController, setStandaloneControllerRaw] = useState(defaults.devices.standaloneController || defaultStandaloneController());
  const setStandaloneController = useCallback(value => {
    const next = typeof value === 'function' ? value(standaloneController) : value;
    const kind = standaloneControllerPhysicalChangeKind(standaloneController, next);
    const boundary = invalidateWiringVerification(wiring, { kind });
    if (!boundary.ok) return boundary;
    if (boundary.wiring !== wiring) dispatchLayout({ type: 'layout/setWiring', wiring: boundary.wiring });
    setStandaloneControllerRaw(next);
    return { ok: true, wiring: boundary.wiring, errors: [] };
  }, [standaloneController, wiring]);

  // ── Audio bands (0–1, updated by useAudio hook) ──────────────────────────
  const [audioBands, setAudioBands] = useState({ bass: 0, mid: 0, hi: 0, energy: 0 });

  // ── WLED ──────────────────────────────────────────────────────────────────
  const {
    ip: wledIp,
    setIp: setWledIp,
    connected: wledConnected,
    transport: wledTransport,
    error: wledError,
    connect: wledConnect,
    disconnect: wledDisconnect,
    push: wledPush,
    getInfo: wledGetInfo,
    getState: wledGetState,
  } = useWled();

  // ── Direct USB LED controller ────────────────────────────────────────────
  const {
    connected: usbLedConnected,
    connecting: usbLedConnecting,
    status: usbLedStatus,
    lastError: usbLedLastError,
    colorOrder: usbLedColorOrder,
    connect: usbLedConnect,
    disconnect: usbLedDisconnect,
    command: usbLedCommand,
    applyColorOrder: usbLedApplyColorOrder,
    calibrateColorOrder: usbLedCalibrateColorOrder,
    cycleColorOrder: usbLedCycleColorOrder,
    applyPixelCount: usbLedApplyPixelCount,
    push: usbLedPush,
    refreshStatus: usbLedRefreshStatus,
  } = useUsbLed();

  const pushOutputFrame = useCallback((pixels) => {
    wledPush(pixels);
    usbLedPush(pixels);
  }, [usbLedPush, wledPush]);

  const knownPatternIds = useMemo(() => new Set(PATTERNS.map(pattern => pattern.id)), []);
  const usbRotaryLastEventIdRef = useRef(0);
  const usbRotaryStartedAtRef = useRef(Date.now());

  useEffect(() => {
    const events = Array.isArray(usbLedStatus?.inputEvents) ? usbLedStatus.inputEvents : [];
    if (!events.length) return;
    const fresh = selectFreshUsbRotaryEvents(events, {
      lastEventId: usbRotaryLastEventIdRef.current,
      startedAt: usbRotaryStartedAtRef.current,
    });
    usbRotaryLastEventIdRef.current = fresh.lastEventId;
    if (!fresh.events.length) return;

    let brightnessCursor = masterBrightness;
    let patternCursor = activePatternId;
    for (const event of fresh.events) {
      const action = resolveRotaryInputAction({
        event,
        currentBrightness: brightnessCursor,
        currentPatternId: patternCursor,
        showClips,
        physicalControls,
        knownPatternIds,
        requireEnabled: false,
      });
      if (action?.type === 'brightness') {
        brightnessCursor = action.brightness;
        setMasterBrightness(action.brightness);
      } else if (action?.type === 'pattern') {
        patternCursor = action.patternId;
        setActivePatternId(action.patternId);
      }
    }
  }, [
    activePatternId,
    knownPatternIds,
    masterBrightness,
    physicalControls,
    setActivePatternId,
    setMasterBrightness,
    showClips,
    usbLedStatus?.inputEvents,
  ]);

  const lastUsbLedPixelCountRef = useRef(0);
  useEffect(() => {
    if (!usbLedConnected) return undefined;
    const totalPixels = strips.reduce((sum, strip) => (
      sum + (strip.pixels?.length || strip.pixelCount || 0)
    ), 0);
    if (totalPixels < 1) return undefined;
    const maxPixels = usbLedStatus?.maxPixels || 300;
    const controllerPixels = Math.max(1, Math.min(maxPixels, totalPixels));
    if (lastUsbLedPixelCountRef.current === controllerPixels) return undefined;

    const timer = setTimeout(() => {
      usbLedApplyPixelCount(controllerPixels)
        .then(() => { lastUsbLedPixelCountRef.current = controllerPixels; })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [strips, usbLedApplyPixelCount, usbLedConnected, usbLedStatus?.maxPixels]);

  // ── Live clip stamping ────────────────────────────────────────────────────
  const stampClip = useCallback((patternId, durationSecs = 10) => {
    let start = timelinePlayhead;
    if (liveQuantize === 'beat') {
      const beatSecs = 60 / bpm;
      start = Math.round(timelinePlayhead / beatSecs) * beatSecs;
    } else if (liveQuantize === 'bar') {
      const barSecs = (60 / bpm) * 4;
      start = Math.round(timelinePlayhead / barSecs) * barSecs;
    }
    const end = Math.min(showDuration, start + durationSecs);
    const id = 'live_' + Date.now();
    setShowClips(prev => [
      // Remove any existing recorded clip that overlaps
      ...prev.filter(c => !(c.track === 0 && c.recorded && c.start < end && c.end > start)),
      { id, track: 0, patternId, start, end, label: patternId, recorded: true },
    ]);
  }, [liveRecording, liveQuantize, bpm, timelinePlayhead, showDuration]);

  const recordLivePattern = useCallback((patternId, { crossfadeSecs = 3, at = timelinePlayhead } = {}) => {
    if (!patternId) return;
    const recorded = buildLiveRecording({
      clips: showClips,
      transitions: showTransitions,
      patternId,
      at,
      bpm,
      quantize: liveQuantize,
      crossfadeSecs,
      showDuration,
    });
    if (recorded.clips === showClips && recorded.transitions === showTransitions) return;
    pushHistory(showClips, showTransitions);
    setShowClipsRaw(recorded.clips);
    setShowTransitionsRaw(recorded.transitions);
  }, [bpm, liveQuantize, pushHistory, showClips, showDuration, showTransitions, timelinePlayhead]);

  // ── Auto-save state ───────────────────────────────────────────────────────
  const [lastSaved, setLastSaved] = useState(null);
  const registerProjectSnapshotContributor = useCallback((contributor) => {
    if (typeof contributor !== 'function') return () => {};
    projectSnapshotContributorsRef.current.add(contributor);
    return () => {
      projectSnapshotContributorsRef.current.delete(contributor);
    };
  }, []);

  const applyProject = useCallback((rawProject) => {
    const data = migrateProject(rawProject);
    if (!data) return false;
    const { layout, pattern, show, live, devices } = data;
    const shouldSeedDefaultLayout = !layout.svgText && !(layout.layers || []).length && !(layout.strips || []).length;
    const sourceStrips = shouldSeedDefaultLayout ? defaults.layout.strips : (layout.strips || []);
    const restoredStrips = restoreStripPixels(sourceStrips);
    setProjectId(data.id || defaults.id);
    setProjectName(data.name || defaults.name);
    // Reset the whole layout slice AND clear undo history — loading a project is
    // not undoable back into the previous project.
    dispatchLayout({
      type: 'layout/reset',
      init: {
        strips: restoredStrips,
        starterPending: layout.starterPending === true,
        viewBox: layout.viewBox || defaults.layout.viewBox,
        svgText: layout.svgText ?? null,
        hidden: layout.hidden || {},
        layers: layout.layers || [],
        density: layout.density || defaults.layout.density,
        pxPerMm: layout.pxPerMm || defaults.layout.pxPerMm,
        editCounts: layout.editCounts || {},
        stripCountOverrides: layout.stripCountOverrides || {},
        layerGroups: layout.layerGroups || [],
        layerOrder: layout.layerOrder || [],
        patchBoard: normalizePatchBoard(shouldSeedDefaultLayout ? defaults.layout.patchBoard : layout.patchBoard, restoredStrips),
        wiring: migrateWiring(layout.wiring, restoredStrips, layout.patchBoard),
      },
    });
    setActivePatternId(pattern.activePatternId || defaults.pattern.activePatternId);
    setPalette(pattern.palette?.length ? pattern.palette : defaults.pattern.palette);
    setMasterSpeed(pattern.masterSpeed ?? defaults.pattern.masterSpeed);
    setMasterBrightness(pattern.masterBrightness ?? defaults.pattern.masterBrightness);
    setMasterSaturation(pattern.masterSaturation ?? defaults.pattern.masterSaturation);
    setMasterHueShift(pattern.masterHueShift ?? defaults.pattern.masterHueShift);
    setGammaEnabled(pattern.gammaEnabled ?? defaults.pattern.gammaEnabled);
    setGammaValue(pattern.gammaValue ?? defaults.pattern.gammaValue);
    setPatternParams(pattern.patternParams || {});
    setBpm(pattern.bpm || defaults.pattern.bpm);
    setMotionSmoothing(pattern.motionSmoothing || defaults.pattern.motionSmoothing);
    setShowClipsRaw(show.clips || defaults.show.clips);
    setShowTransitionsRaw(show.transitions || defaults.show.transitions);
    setShowCues(show.cues || defaults.show.cues);
    setAutoLanes(show.autoLanes || defaults.show.autoLanes);
    setShowDuration(show.duration || defaults.show.duration);
    setLiveRecording(!!live.recording);
    setLiveQuantize(live.quantize || defaults.live.quantize);
    setSymSettings({ ...DEFAULT_SYM_SETTINGS, ...(pattern.symSettings || {}) });
    setWledSegmentMap(devices.segmentMap || {});
    setPhysicalControls(devices.physicalControls || defaults.devices.physicalControls);
    setControllerProfiles(devices.controllerProfiles || []);
    setActiveControllerId(devices.activeControllerId || '');
    setStandaloneControllerRaw(defaultStandaloneController(devices.standaloneController));
    setWledIp(devices.wledIp || '');
    historyRef.current = { past: [], future: [] };
    setProjectRevision(v => v + 1);
    return true;
  }, [setWledIp]);

  useEffect(() => {
    setPatchBoard(prev => normalizePatchBoard(prev, strips));
  }, [strips]);

  // ── Auto-load from localStorage on mount ─────────────────────────────────
  const didLoadRef = useRef(false);
  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    try {
      const savedProject = readStorageJsonWithBackup(LS_AUTOSAVE_KEY, LS_AUTOSAVE_BACKUP_KEY) ||
        readStorageJsonWithBackup(LS_AUTOSAVE_LEGACY_KEY, '');
      const legacyLayoutProject = readStorageJsonWithBackup(LS_LAYOUT_LEGACY_KEY, '');
      const project = resolveStartupProject({
        savedProject,
        legacyLayoutProject,
      });
      applyProject(project);
    } catch {}
  }, [applyProject]);

  // ── Debounced auto-save ───────────────────────────────────────────────────
  const saveTimerRef = useRef(null);
  const serializeProject = useCallback(() => {
    let project = {
      version: PROJECT_VERSION,
      id: projectId,
      name: projectName,
      layout: {
        strips, starterPending, viewBox, svgText, hidden,
        layers: layoutLayers,
        density: layoutDensity,
        pxPerMm: layoutPxPerMm,
        editCounts: layoutEditCounts,
        stripCountOverrides: layoutStripCountOverrides,
        layerGroups: layoutLayerGroups,
        layerOrder: layoutLayerOrder,
        patchBoard: normalizePatchBoard(patchBoard, strips),
        wiring,
      },
      pattern: {
        activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
        masterHueShift, gammaEnabled, gammaValue, patternParams, bpm, symSettings,
        motionSmoothing,
      },
      show: {
        clips: showClips,
        transitions: showTransitions,
        cues: showCues,
        autoLanes,
        duration: showDuration,
      },
      live: {
        recording: liveRecording,
        quantize: liveQuantize,
      },
      devices: {
        wledIp,
        segmentMap: wledSegmentMap,
        physicalControls,
        controllerProfiles,
        activeControllerId,
        standaloneController,
      },
    };

    for (const contributor of projectSnapshotContributorsRef.current) {
      try {
        const nextProject = contributor(project);
        if (nextProject && typeof nextProject === 'object') project = nextProject;
      } catch (error) {
        console.warn('Lightweaver project snapshot contributor failed', error);
      }
    }

    return project;
  }, [
    projectId, projectName, strips, starterPending, viewBox, svgText, hidden, patchBoard, wiring,
    layoutLayers, layoutDensity, layoutPxPerMm, layoutEditCounts, layoutStripCountOverrides, layoutLayerGroups, layoutLayerOrder,
    activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
    masterHueShift, gammaEnabled, gammaValue, patternParams, bpm, symSettings,
    motionSmoothing,
    showClips, showTransitions, showCues, autoLanes, showDuration,
    liveRecording, liveQuantize, wledIp, wledSegmentMap, physicalControls, controllerProfiles, activeControllerId, standaloneController,
  ]);

  useEffect(() => {
    const fingerprint = JSON.stringify(serializeProject());
    if (!projectFingerprintRef.current || suppressNextLifecycleEditRef.current) {
      projectFingerprintRef.current = fingerprint;
      suppressNextLifecycleEditRef.current = false;
      return;
    }
    if (projectFingerprintRef.current !== fingerprint) {
      projectFingerprintRef.current = fingerprint;
      dispatchProjectLifecycle({ type: 'edited' });
    }
  }, [serializeProject]);

  const flushProjectAutosave = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    try {
      const saved = writeStorageJsonWithBackup(LS_AUTOSAVE_KEY, LS_AUTOSAVE_BACKUP_KEY, serializeProject());
      if (saved) setLastSaved(Date.now());
      return saved;
    } catch {
      return false;
    }
  }, [serializeProject]);

  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushProjectAutosave, 500);
    return () => clearTimeout(saveTimerRef.current);
  }, [flushProjectAutosave]);

  const loadProject = useCallback((data) => {
    return applyProject(data);
  }, [applyProject]);

  const newProject = useCallback(() => {
    applyProject(createDefaultProject());
  }, [applyProject]);

  const replaceProject = useCallback(async (candidate, options = {}) => {
    return replaceProjectSafely({
      candidate,
      validate: value => migrateProject(value),
      dirty: hasUnsavedChanges(projectLifecycle),
      confirmDiscard: options.confirmDiscard || (validated => requestReplacementConfirmation({
        currentName: projectName,
        incomingName: validated?.name,
      })),
      apply: validated => {
        suppressNextLifecycleEditRef.current = true;
        applyProject(validated);
        dispatchProjectLifecycle({ type: 'replaced' });
      },
    });
  }, [applyProject, projectLifecycle, projectName, requestReplacementConfirmation]);

  const replaceWithNewProject = useCallback(options => replaceProject(createDefaultProject(), options), [replaceProject]);
  const markProjectPersisted = useCallback(destination => dispatchProjectLifecycle({ type: 'persisted', destination }), []);
  const markProjectEdited = useCallback(() => dispatchProjectLifecycle({ type: 'edited' }), []);
  const markProjectInstalled = useCallback(revision => dispatchProjectLifecycle({ type: 'installed', revision }), []);
  const markCardLookConfirmed = useCallback(look => {
    setConfirmedCardLook(look ? JSON.parse(JSON.stringify(look)) : null);
  }, []);

  return (
    <ProjectContext.Provider value={{
      // Layout
      strips, setStrips,
      starterPending,
      viewBox, setViewBox,
      svgText, setSvgText,
      hidden,  setHidden,
      layoutLayers,      setLayoutLayers,
      layoutDensity,     setLayoutDensity,
      layoutPxPerMm,     setLayoutPxPerMm,
      layoutEditCounts,  setLayoutEditCounts,
      layoutStripCountOverrides, setLayoutStripCountOverrides,
      layoutLayerGroups, setLayoutLayerGroups,
      layoutLayerOrder,  setLayoutLayerOrder,
      patchBoard,        setPatchBoard,
      updatePatchBoard,
      wiring, updateWiring, compiledWiring,
      replaceLayoutGeometry,
      // Layout undo/redo (single shared snapshot stack)
      pushLayoutHistory, undoLayout, redoLayout,
      layoutHistLen,     layoutFutLen,
      // Layout selection (reducer-owned; consumed from step 9 on)
      selection,
      selectStrip,       selectStrips,
      toggleStripSel,
      selectLayer,       selectPaths,
      togglePathSel,     clearLayoutSelection,
      renameLayoutSelection,
      projectRevision,
      projectLifecycle,
      projectLifecycleLabel: lifecycleLabel(projectLifecycle),
      projectHasUnsavedChanges: hasUnsavedChanges(projectLifecycle),
      confirmedCardLook,
      // Pattern
      activePatternId, setActivePatternId,
      palette,         setPalette,
      masterSpeed,     setMasterSpeed,
      masterBrightness, setMasterBrightness,
      masterSaturation, setMasterSaturation,
      gammaEnabled,    setGammaEnabled,
      gammaValue,      setGammaValue,
      masterHueShift,  setMasterHueShift,
      patternParams,   setPatternParams,
      bpm,             setBpm,
      projectId,
      projectName,     setProjectName,
      motionSmoothing, setMotionSmoothing,
      // Timeline
      showClips,       setShowClips,
      showTransitions, setShowTransitions,
      showCues,        setShowCues,
      autoLanes,       setAutoLanes,
      showDuration,    setShowDuration,
      timelinePlaying, setTimelinePlaying,
      timelinePlayhead, setTimelinePlayhead,
      // Live recording
      liveRecording,   setLiveRecording,
      liveQuantize,    setLiveQuantize,
      stampClip,
      recordLivePattern,
      // Timeline undo/redo
      undoTimeline,    redoTimeline,
      // Symmetry
      symSettings,     setSymSettings,
      // Audio
      audioBands,      setAudioBands,
      // WLED
      wledIp,          setWledIp,
      wledConnected,   wledTransport,
      wledError,
      wledConnect,     wledDisconnect,
      wledPush,        wledGetInfo,
      wledGetState,
      usbLedConnected, usbLedConnecting,
      usbLedStatus,    usbLedLastError,
      usbLedColorOrder,
      usbLedConnect,   usbLedDisconnect,
      usbLedCommand,   usbLedApplyColorOrder,
      usbLedCalibrateColorOrder,
      usbLedCycleColorOrder,
      usbLedApplyPixelCount,
      usbLedRefreshStatus,
      pushOutputFrame,
      wledSegmentMap,  setWledSegmentMap,
      physicalControls, setPhysicalControls,
      controllerProfiles, setControllerProfiles,
      activeControllerId, setActiveControllerId,
      standaloneController, setStandaloneController,
      // Project persistence
      serializeProject,
      flushProjectAutosave,
      loadProject: replaceProject,
      replaceProject,
      replaceWithNewProject,
      requestReplacementConfirmation,
      markProjectPersisted,
      markProjectEdited,
      markProjectInstalled,
      markCardLookConfirmed,
      registerProjectSnapshotContributor,
      newProject,
      lastSaved,
    }}>
      {children}
      {pendingReplacement &&
        <div ref={replacementBackdropRef} className="project-replacement-backdrop">
          <section
            ref={replacementDialogRef}
            className="project-replacement-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-replacement-title"
          >
            <h2 id="project-replacement-title">Replace current project?</h2>
            <p><strong>{pendingReplacement.currentName}</strong> has changes that are not saved in the browser or a file.</p>
            <p>Replace it with <strong>{pendingReplacement.incomingName}</strong>?</p>
            <div className="project-replacement-actions">
              <button ref={keepEditingRef} type="button" className="btn" onClick={() => dismissReplacement(false)}>Keep editing</button>
              <button type="button" className="btn primary" onClick={() => dismissReplacement(true)}>Replace project</button>
            </div>
          </section>
        </div>
      }
    </ProjectContext.Provider>
  );
}

export function useProject() {
  return useContext(ProjectContext);
}
