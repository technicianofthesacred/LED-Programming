import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { useWled } from '../hooks/useWled.js';
import { PALETTE_DEFAULT } from '../data.js';

const LS_AUTOSAVE_KEY = 'lw_autosave_v1';

const ProjectContext = createContext(null);

// ── Default show data ─────────────────────────────────────────────────────
export const DEFAULT_CLIPS = [
  { id: 'c1', track: 0, patternId: 'calm',    start: 0,   end: 95,  label: 'Calm open' },
  { id: 'c2', track: 0, patternId: 'aurora',   start: 90,  end: 240, label: 'Aurora drift' },
  { id: 'c3', track: 0, patternId: 'bloom',    start: 235, end: 360, label: 'Bloom build' },
  { id: 'c4', track: 0, patternId: 'ember',    start: 355, end: 480, label: 'Ember pulse' },
  { id: 'c5', track: 0, patternId: 'wave',     start: 475, end: 600, label: 'Wave out' },
  { id: 'c6', track: 1, patternId: 'drift',    start: 120, end: 260, label: 'Outer drift', group: 'Outer ring' },
  { id: 'c7', track: 1, patternId: 'scanner',  start: 260, end: 420, label: 'Outer scan',  group: 'Outer ring' },
];

export const DEFAULT_TRANSITIONS = [
  { id: 't1', clipA: 'c1', clipB: 'c2', start: 90,  end: 95,  type: 'crossfade', curve: 'ease-in-out' },
  { id: 't2', clipA: 'c2', clipB: 'c3', start: 235, end: 240, type: 'fade-black', curve: 'linear' },
  { id: 't3', clipA: 'c3', clipB: 'c4', start: 355, end: 360, type: 'dissolve',  curve: 'ease-in-out' },
  { id: 't4', clipA: 'c4', clipB: 'c5', start: 475, end: 480, type: 'crossfade', curve: 'ease-in-out' },
];

export const DEFAULT_CUES = [
  { t: 0,   name: 'Start',     kbd: 'Q1' },
  { t: 95,  name: 'Drop 1',    kbd: 'Q2' },
  { t: 240, name: 'Bloom',     kbd: 'Q3' },
  { t: 360, name: 'Climax',    kbd: 'Q4' },
  { t: 480, name: 'Wind down', kbd: 'Q5' },
  { t: 600, name: 'End',       kbd: 'Q6' },
];

export const DEFAULT_AUTO_LANES = [
  { id: 'a1', label: 'Hue shift', color: '#c84a8a', param: 'hueShift',  keys: [[0,0.1],[60,0.2],[140,0.5],[240,0.75],[360,0.4],[480,0.9],[600,0.1]] },
  { id: 'a2', label: 'Speed',     color: '#5fb8d9', param: 'speed',     keys: [[0,0.3],[120,0.35],[240,0.5],[360,0.8],[480,0.9],[540,0.5],[600,0.25]] },
  { id: 'a3', label: 'Brightness',color: '#e89a3a', param: 'brightness', keys: [[0,0.2],[95,0.6],[240,0.75],[360,0.95],[480,0.85],[600,0.25]] },
];

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
  // ── Layout ──────────────────────────────────────────────────────────────
  const [strips,    setStrips]    = useState([]);
  const [viewBox,   setViewBox]   = useState('0 0 640 400');
  const [svgText,   setSvgText]   = useState(null);
  const [hidden,    setHidden]    = useState({});

  // ── Pattern ──────────────────────────────────────────────────────────────
  const [activePatternId,  setActivePatternId]  = useState('aurora');
  const [palette,          setPalette]          = useState(PALETTE_DEFAULT);
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
    enabled: false,
    type: 'none',   // 'none' | 'mirror-h' | 'mirror-v' | 'mirror-hv' | 'radial' | 'kaleido'
    count: 8,       // for radial
    slices: 6,      // for kaleido
    phase: 0,       // rotation offset in turns (0-1)
    twist: 0,       // twist speed Hz for radial
    seam: 0.1,      // seam blend width for mirror
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

  // ── Auto-load from localStorage on mount ─────────────────────────────────
  const didLoadRef = useRef(false);
  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    try {
      const saved = localStorage.getItem(LS_AUTOSAVE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data && data.version === 1) {
          if (data.name)               setProjectName(data.name);
          if (data.strips?.length > 0) setStrips(data.strips);
          if (data.viewBox)            setViewBox(data.viewBox);
          if (data.svgText !== undefined) setSvgText(data.svgText);
          if (data.hidden)             setHidden(data.hidden);
          if (data.activePatternId)    setActivePatternId(data.activePatternId);
          if (data.masterSpeed         != null) setMasterSpeed(data.masterSpeed);
          if (data.masterBrightness    != null) setMasterBrightness(data.masterBrightness);
          if (data.masterSaturation    != null) setMasterSaturation(data.masterSaturation);
          if (data.gammaEnabled        != null) setGammaEnabled(data.gammaEnabled);
          if (data.gammaValue          != null) setGammaValue(data.gammaValue);
          if (data.patternParams)      setPatternParams(data.patternParams);
          if (data.bpm)                setBpm(data.bpm);
          if (data.showClips?.length > 0) setShowClips(data.showClips);
          if (data.showTransitions)    setShowTransitions(data.showTransitions);
          if (data.showCues)           setShowCues(data.showCues);
          if (data.autoLanes)          setAutoLanes(data.autoLanes);
          if (data.showDuration)       setShowDuration(data.showDuration);
          if (data.symSettings)        setSymSettings(data.symSettings);
          if (data.palette?.length > 0) setPalette(data.palette);
        }
      }
    } catch {}
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Debounced auto-save ───────────────────────────────────────────────────
  const saveTimerRef = useRef(null);
  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        const snap = {
          version: 1,
          name: projectName, strips, viewBox, svgText, hidden,
          activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
          gammaEnabled, gammaValue, patternParams, bpm,
          showClips, showTransitions, showCues, autoLanes, showDuration,
          symSettings,
        };
        localStorage.setItem(LS_AUTOSAVE_KEY, JSON.stringify(snap));
        setLastSaved(Date.now());
      } catch {}
    }, 2000);
    return () => clearTimeout(saveTimerRef.current);
  }, [
    projectName, strips, viewBox, svgText, hidden,
    activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
    gammaEnabled, gammaValue, patternParams, bpm,
    showClips, showTransitions, showCues, autoLanes, showDuration, symSettings,
  ]);

  // ── Project save ──────────────────────────────────────────────────────────
  const serializeProject = useCallback(() => ({
    version: 1,
    name: projectName,
    strips, viewBox, svgText, hidden,
    activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
    gammaEnabled, gammaValue, patternParams, bpm,
    showClips, showTransitions, showCues, autoLanes, showDuration,
    symSettings,
  }), [
    projectName, strips, viewBox, svgText, hidden,
    activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
    gammaEnabled, gammaValue, patternParams, bpm,
    showClips, showTransitions, showCues, autoLanes, showDuration, symSettings,
  ]);

  const loadProject = useCallback((data) => {
    if (!data || data.version !== 1) return false;
    if (data.name)               setProjectName(data.name);
    if (data.strips)             setStrips(data.strips);
    if (data.viewBox)            setViewBox(data.viewBox);
    if (data.svgText !== undefined) setSvgText(data.svgText);
    if (data.hidden)             setHidden(data.hidden);
    if (data.activePatternId)    setActivePatternId(data.activePatternId);
    if (data.masterSpeed         != null) setMasterSpeed(data.masterSpeed);
    if (data.masterBrightness    != null) setMasterBrightness(data.masterBrightness);
    if (data.masterSaturation    != null) setMasterSaturation(data.masterSaturation);
    if (data.gammaEnabled        != null) setGammaEnabled(data.gammaEnabled);
    if (data.gammaValue          != null) setGammaValue(data.gammaValue);
    if (data.patternParams)      setPatternParams(data.patternParams);
    if (data.bpm)                setBpm(data.bpm);
    if (data.showClips)          setShowClips(data.showClips);
    if (data.showTransitions)    setShowTransitions(data.showTransitions);
    if (data.showCues)           setShowCues(data.showCues);
    if (data.autoLanes)          setAutoLanes(data.autoLanes);
    if (data.showDuration)       setShowDuration(data.showDuration);
    if (data.symSettings)        setSymSettings(data.symSettings);
    if (data.palette?.length > 0) setPalette(data.palette);
    return true;
  }, []);

  const newProject = useCallback(() => {
    setProjectName('Untitled Project');
    setStrips([]); setViewBox('0 0 640 400'); setSvgText(null); setHidden({});
    setActivePatternId('aurora'); setPalette(PALETTE_DEFAULT);
    setMasterSpeed(1); setMasterBrightness(1); setMasterSaturation(1);
    setGammaEnabled(false); setGammaValue(2.2); setPatternParams({}); setBpm(120);
    setShowClipsRaw(DEFAULT_CLIPS); setShowTransitionsRaw(DEFAULT_TRANSITIONS);
    setShowCues(DEFAULT_CUES); setAutoLanes(DEFAULT_AUTO_LANES); setShowDuration(600);
    setSymSettings({ enabled: false, type: 'none', count: 8, slices: 6, phase: 0, twist: 0, seam: 0.1 });
    historyRef.current = { past: [], future: [] };
  }, []);

  return (
    <ProjectContext.Provider value={{
      // Layout
      strips, setStrips,
      viewBox, setViewBox,
      svgText, setSvgText,
      hidden,  setHidden,
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
