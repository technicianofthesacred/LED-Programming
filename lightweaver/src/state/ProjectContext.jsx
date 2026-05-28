import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
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
import { normalizePatchBoard } from '../lib/patchBoard.js';
import { resolveRotaryInputAction, selectFreshUsbRotaryEvents } from '../lib/usbRotaryInput.js';

const LS_AUTOSAVE_KEY = 'lw_autosave_v3';
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

  // ── Layout ──────────────────────────────────────────────────────────────
  const [strips,    setStrips]    = useState([]);
  const [viewBox,   setViewBox]   = useState('0 0 640 400');
  const [svgText,   setSvgText]   = useState(null);
  const [hidden,    setHidden]    = useState({});
  const [layoutLayers,      setLayoutLayers]      = useState(defaults.layout.layers);
  const [layoutDensity,     setLayoutDensity]     = useState(defaults.layout.density);
  const [layoutPxPerMm,     setLayoutPxPerMm]     = useState(defaults.layout.pxPerMm);
  const [layoutEditCounts,  setLayoutEditCounts]  = useState(defaults.layout.editCounts);
  const [layoutLayerGroups, setLayoutLayerGroups] = useState(defaults.layout.layerGroups);
  const [layoutLayerOrder,  setLayoutLayerOrder]  = useState(defaults.layout.layerOrder);
  const [patchBoard,        setPatchBoard]        = useState(() => normalizePatchBoard(defaults.layout.patchBoard, []));
  const [projectRevision,   setProjectRevision]   = useState(0);

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
  const [standaloneController, setStandaloneController] = useState(defaults.devices.standaloneController || defaultStandaloneController());

  // ── Audio bands (0–1, updated by useAudio hook) ──────────────────────────
  const [audioBands, setAudioBands] = useState({ bass: 0, mid: 0, hi: 0, energy: 0 });

  // ── WLED ──────────────────────────────────────────────────────────────────
  const {
    ip: wledIp,
    setIp: setWledIp,
    connected: wledConnected,
    transport: wledTransport,
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

  const applyProject = useCallback((rawProject) => {
    const data = migrateProject(rawProject);
    if (!data) return false;
    const { layout, pattern, show, live, devices } = data;
    const restoredStrips = restoreStripPixels(layout.strips || []);
    setProjectName(data.name || defaults.name);
    setStrips(restoredStrips);
    setViewBox(layout.viewBox || defaults.layout.viewBox);
    setSvgText(layout.svgText ?? null);
    setHidden(layout.hidden || {});
    setLayoutLayers(layout.layers || []);
    setLayoutDensity(layout.density || defaults.layout.density);
    setLayoutPxPerMm(layout.pxPerMm || defaults.layout.pxPerMm);
    setLayoutEditCounts(layout.editCounts || {});
    setLayoutLayerGroups(layout.layerGroups || []);
    setLayoutLayerOrder(layout.layerOrder || []);
    setPatchBoard(normalizePatchBoard(layout.patchBoard, restoredStrips));
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
    setStandaloneController(defaultStandaloneController(devices.standaloneController));
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
      const saved = localStorage.getItem(LS_AUTOSAVE_KEY) || localStorage.getItem(LS_AUTOSAVE_LEGACY_KEY);
      const layoutSaved = localStorage.getItem(LS_LAYOUT_LEGACY_KEY);
      const project = resolveStartupProject({
        savedProject: saved ? JSON.parse(saved) : null,
        legacyLayoutProject: layoutSaved ? JSON.parse(layoutSaved) : null,
      });
      applyProject(project);
    } catch {}
  }, [applyProject]);

  // ── Debounced auto-save ───────────────────────────────────────────────────
  const saveTimerRef = useRef(null);
  const serializeProject = useCallback(() => ({
    version: PROJECT_VERSION,
    name: projectName,
    layout: {
      strips, viewBox, svgText, hidden,
      layers: layoutLayers,
      density: layoutDensity,
      pxPerMm: layoutPxPerMm,
      editCounts: layoutEditCounts,
      layerGroups: layoutLayerGroups,
      layerOrder: layoutLayerOrder,
      patchBoard: normalizePatchBoard(patchBoard, strips),
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
  }), [
    projectName, strips, viewBox, svgText, hidden, patchBoard,
    layoutLayers, layoutDensity, layoutPxPerMm, layoutEditCounts, layoutLayerGroups, layoutLayerOrder,
    activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
    masterHueShift, gammaEnabled, gammaValue, patternParams, bpm, symSettings,
    motionSmoothing,
    showClips, showTransitions, showCues, autoLanes, showDuration,
    liveRecording, liveQuantize, wledIp, wledSegmentMap, physicalControls, controllerProfiles, activeControllerId, standaloneController,
  ]);

  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(LS_AUTOSAVE_KEY, JSON.stringify(serializeProject()));
        setLastSaved(Date.now());
      } catch {}
    }, 500);
    return () => clearTimeout(saveTimerRef.current);
  }, [serializeProject]);

  const loadProject = useCallback((data) => {
    return applyProject(data);
  }, [applyProject]);

  const newProject = useCallback(() => {
    applyProject(createDefaultProject());
  }, [applyProject]);

  return (
    <ProjectContext.Provider value={{
      // Layout
      strips, setStrips,
      viewBox, setViewBox,
      svgText, setSvgText,
      hidden,  setHidden,
      layoutLayers,      setLayoutLayers,
      layoutDensity,     setLayoutDensity,
      layoutPxPerMm,     setLayoutPxPerMm,
      layoutEditCounts,  setLayoutEditCounts,
      layoutLayerGroups, setLayoutLayerGroups,
      layoutLayerOrder,  setLayoutLayerOrder,
      patchBoard,        setPatchBoard,
      projectRevision,
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
      loadProject,
      newProject,
      lastSaved,
    }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  return useContext(ProjectContext);
}
