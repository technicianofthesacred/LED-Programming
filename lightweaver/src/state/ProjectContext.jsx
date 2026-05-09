import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { useWled } from '../hooks/useWled.js';
import { samplePath } from '../lib/mapper.js';
import {
  DEFAULT_AUTO_LANES,
  DEFAULT_CLIPS,
  DEFAULT_CUES,
  DEFAULT_TRANSITIONS,
} from './ProjectDefaults.js';
import {
  createDefaultProject,
  DEFAULT_SYM_SETTINGS,
  migrateProject,
  PROJECT_VERSION,
} from '../lib/projectModel.js';

const LS_AUTOSAVE_KEY = 'lw_autosave_v3';
const LS_AUTOSAVE_LEGACY_KEY = 'lw_autosave_v1';
const LS_LAYOUT_LEGACY_KEY = 'lw-layout-autosave';

const ProjectContext = createContext(null);

function restoreStripPixels(strips = []) {
  if (typeof document === 'undefined') return strips;
  return strips.map(strip => {
    if (strip.pixels?.length || !strip.pathData) return strip;
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', strip.pathData);
    let pixels = samplePath(pathEl, strip.pixelCount || 1);
    if (strip.reversed) pixels = pixels.slice().reverse();
    return { ...strip, pixels };
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
  const track0Clips = clips.filter(c => c.track === 0);
  const active = track0Clips.find(c => playhead >= c.start && playhead <= c.end) || null;
  const trans  = transitions.find(t => playhead >= t.start && playhead <= t.end) || null;

  const blend = trans ? Math.max(0, Math.min(1, (playhead - trans.start) / (trans.end - trans.start))) : 0;
  const nextClip = trans ? clips.find(c => c.id === trans.clipB) : null;

  return {
    patternId:      active?.patternId || null,
    blendPatternId: nextClip?.patternId || null,
    blendAmount:    blend,
    transType:      trans?.type || null,
    transCurve:     trans?.curve || 'linear',
  };
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
  const [liveQuantize,  setLiveQuantize]  = useState('beat'); // 'free' | 'beat' | 'bar'

  // ── Symmetry settings ────────────────────────────────────────────────────
  const [symSettings, setSymSettings] = useState({
    ...DEFAULT_SYM_SETTINGS,
  });

  // ── Audio bands (0–1, updated by useAudio hook) ──────────────────────────
  const [audioBands, setAudioBands] = useState({ bass: 0, mid: 0, hi: 0, energy: 0 });

  // ── WLED ──────────────────────────────────────────────────────────────────
  const { ip: wledIp, setIp: setWledIp, connected: wledConnected, connect: wledConnect, disconnect: wledDisconnect, push: wledPush } = useWled();

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

  // ── Auto-save state ───────────────────────────────────────────────────────
  const [lastSaved, setLastSaved] = useState(null);

  const applyProject = useCallback((rawProject) => {
    const data = migrateProject(rawProject);
    if (!data) return false;
    const { layout, pattern, show, live } = data;
    setProjectName(data.name || defaults.name);
    setStrips(restoreStripPixels(layout.strips || []));
    setViewBox(layout.viewBox || defaults.layout.viewBox);
    setSvgText(layout.svgText ?? null);
    setHidden(layout.hidden || {});
    setLayoutLayers(layout.layers || []);
    setLayoutDensity(layout.density || defaults.layout.density);
    setLayoutPxPerMm(layout.pxPerMm || defaults.layout.pxPerMm);
    setLayoutEditCounts(layout.editCounts || {});
    setLayoutLayerGroups(layout.layerGroups || []);
    setLayoutLayerOrder(layout.layerOrder || []);
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
    setShowClipsRaw(show.clips || defaults.show.clips);
    setShowTransitionsRaw(show.transitions || defaults.show.transitions);
    setShowCues(show.cues || defaults.show.cues);
    setAutoLanes(show.autoLanes || defaults.show.autoLanes);
    setShowDuration(show.duration || defaults.show.duration);
    setLiveRecording(!!live.recording);
    setLiveQuantize(live.quantize || defaults.live.quantize);
    setSymSettings({ ...DEFAULT_SYM_SETTINGS, ...(pattern.symSettings || {}) });
    historyRef.current = { past: [], future: [] };
    setProjectRevision(v => v + 1);
    return true;
  }, []);

  // ── Auto-load from localStorage on mount ─────────────────────────────────
  const didLoadRef = useRef(false);
  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    try {
      const saved = localStorage.getItem(LS_AUTOSAVE_KEY) || localStorage.getItem(LS_AUTOSAVE_LEGACY_KEY);
      const layoutSaved = localStorage.getItem(LS_LAYOUT_LEGACY_KEY);
      const project = saved ? migrateProject(JSON.parse(saved)) : createDefaultProject();
      const layout = layoutSaved ? migrateProject(JSON.parse(layoutSaved)) : null;
      if (layout) project.layout = { ...project.layout, ...layout.layout };
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
    },
    pattern: {
      activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
      masterHueShift, gammaEnabled, gammaValue, patternParams, bpm, symSettings,
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
    },
  }), [
    projectName, strips, viewBox, svgText, hidden,
    layoutLayers, layoutDensity, layoutPxPerMm, layoutEditCounts, layoutLayerGroups, layoutLayerOrder,
    activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
    masterHueShift, gammaEnabled, gammaValue, patternParams, bpm, symSettings,
    showClips, showTransitions, showCues, autoLanes, showDuration,
    liveRecording, liveQuantize, wledIp,
  ]);

  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(LS_AUTOSAVE_KEY, JSON.stringify(serializeProject()));
        setLastSaved(Date.now());
      } catch {}
    }, 2000);
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
      // Timeline undo/redo
      undoTimeline,    redoTimeline,
      // Symmetry
      symSettings,     setSymSettings,
      // Audio
      audioBands,      setAudioBands,
      // WLED
      wledIp,          setWledIp,
      wledConnected,   wledConnect,
      wledDisconnect,  wledPush,
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
