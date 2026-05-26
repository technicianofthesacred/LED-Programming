import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { PATTERNS } from '../lib/patterns-library.js';
import { LEDPreview } from './Preview.jsx';
import { makeBlackoutFrame } from '../lib/deviceController.js';
import { usePersistentPanelSize } from '../hooks/usePersistentPanelSize.js';
import { easeCrossfade, formatMotionSpeed, MOTION_SMOOTHING_MODES } from '../lib/motionSmoothing.js';
import { getPatternCompatibilityGate } from '../lib/patternCompatibility.js';

const LIVE_CATS = ['all', 'audio', 'fire', 'water', 'space', 'chill', 'geo', 'glitch', 'bpm'];
const LIVE_CATEGORY_RULES = {
  audio: ['bass-pulse','spectrum','vortex','comet','color-organ','lissajous','galaxy','volt','waterfall','mandala','snowfield','bass-bloom','spectrum-waterfall'],
  fire:  ['fire','ember','lava','candle','nova','solar','sunrise','sunrise-v2','thermal','lava-flow','particle-burst'],
  water: ['ocean','ripple','wave','fluid','tide','bubble','smoke','smoke-haze','oil-slick'],
  space: ['aurora','galaxy','hyperspace','nebula','plasma','warp','meteor','nova','northern','fractal','jellyfish','starfield','aurora-curtain','plasma-ball'],
  chill: ['calm','breathe','drift','zen','aurora','tide','watercolor','northern','smoke','smoke-haze','breathing-grid','aurora-curtain'],
  geo:   ['circuit','blocks','binary-pulse','pulse-ring','stained','mandala','dna','kaleido','pixelate','breathing-grid','kaleidoscope-v2','tie-dye'],
  glitch:['glitch','matrix','neon','strobe','lightning','morse','digitrain','thermal','digital-rain-v2','strobe-color','neon-sign'],
  bpm:   ['strobe-bpm','kick-flash','beat-grid','pulse-expand','confetti-bpm','heartbeat','strobe-color'],
};

function formatCrossfadeDuration(seconds) {
  const n = Math.max(0, Number.isFinite(+seconds) ? +seconds : 0);
  if (n >= 60) {
    const mins = Math.floor(n / 60);
    const secs = Math.round(n % 60);
    return secs ? `${mins}m ${secs}s` : `${mins}m`;
  }
  return `${n.toFixed(n % 1 ? 1 : 0)}s`;
}

function clampCrossfadeDuration(value) {
  return Math.max(0, Math.min(120, Number.isFinite(+value) ? +value : 0));
}

// ── Color map for pattern cards ────────────────────────────────────────────
const CARD_COLORS = {
  aurora: '#5fb8d9', breathe: '#06d6a0', ripple: '#4ac8c8',
  fire: '#e85a3a', plasma: '#9a4ac8', lava: '#d95a3a',
  ocean: '#3a8ab8', candle: '#e8a03a', rainbow: '#e84ac8',
  sparkle: '#d9d94a', twinkle: '#8ab8d9', meteor: '#8a8ae8',
  strobe: '#d9d9d9', inkdrop: '#4a3a8a', stained: '#8a4a3a',
  heartbeat: '#e83a4a', neon: '#4ae8c8', matrix: '#3ae84a',
  glitch: '#e84a8a', warp: '#8a8ad9', confetti: '#e8a8e8',
  blocks: '#a8e880', 'binary-pulse': '#80a8e8', 'pulse-ring': '#80e8c8',
  lightning: '#8080e8', chase: '#80c8e8', gradient: '#e8c880',
  scanner: '#d9a84a', calm: '#3a8a6a', bloom: '#c84a8a',
  ember: '#e89a3a', wave: '#3a6ac8', drift: '#8a4ac8',
  'debug-xy': '#808080',
  // audio-reactive
  'bass-pulse': '#ff4400', spectrum: '#44aaff', vortex: '#ff44ff',
  comet: '#8899ff', snowfield: '#aaddff', mandala: '#ffcc44',
  'color-organ': '#44ff88', lissajous: '#00ffaa', galaxy: '#8844cc',
  volt: '#4444ff', waterfall: '#2299cc',
  // new
  solar: '#ffcc00', prism: '#ff8800', dna: '#00ff88', fluid: '#0088ff',
  circuit: '#00aa44', nova: '#ff4488', tide: '#006688', hyperspace: '#8888ff',
  zen: '#334466', glitter: '#ff88ff', morse: '#4488ff', bubble: '#aaccff',
  // BPM-synced
  'strobe-bpm': '#ffffff', 'kick-flash': '#ff2200', 'beat-grid': '#4444aa',
  'pulse-expand': '#ff00ff', 'confetti-bpm': '#ffcc00',
  // more
  northern: '#00eeaa', kaleido: '#ff44aa', watercolor: '#ff9988', digitrain: '#00ff41',
  sunrise: '#ff8800', fractal: '#8844ff', thermal: '#ff4400', jellyfish: '#8800ff',
    pixelate: '#ffcc00', smoke: '#888899', 'smoke-haze': '#888899',
  // extra
  ribbons: '#ff88cc', tesseract: '#0088ff', zodiac: '#8800cc', constellation: '#aaccff',
  pendulum: '#ffaa00', iceberg: '#44aaff', soundwave: '#4488ff', mandelbrot: '#ff6600',
  cityscape: '#ffcc44', lotus: '#ff4488',
  // batch 4
  'lava-lamp': '#ff4400', 'aurora-borealis': '#00ccaa', 'circuit-board': '#00ff44',
  wormhole: '#6600cc', bioluminescence: '#00ffcc', prismatic: '#ffff00',
  'meteor-shower': '#aabbff', 'pixel-rain': '#00ff44', crystallize: '#88ccff',
  'hypnotic-spiral': '#ff4488',
  // batch 5
  'bass-bloom': '#ff4400', 'spectrum-waterfall': '#00aaff', 'strobe-color': '#ffffff',
  'neon-sign': '#ff44ff',
  // batch 6
  'oil-slick': '#ff0088', starfield: '#8888ff', 'lava-flow': '#ff3300',
  'aurora-curtain': '#00ffaa', 'digital-rain-v2': '#00ff44', 'tie-dye': '#ff00ff',
  'plasma-ball': '#8844ff', 'breathing-grid': '#4488ff', 'kaleidoscope-v2': '#ff44aa',
  'particle-burst': '#ff8800',
  // batch 7
  voronoi: '#ff4488', interference: '#00aaff', 'mirror-warp': '#aa44ff',
  'sand-dune': '#cc8822', 'retro-scan': '#00ff44', 'deep-sea': '#0055aa',
  'paint-drip': '#ff0055', 'snow-globe': '#88ccff', 'thermal-cam': '#ff4400',
  'lissajous-v2': '#ff00ff',
  // batch 8
  'watercolor-wash': '#ffaacc', 'pixel-sort': '#ff0088', 'prism-split': '#ffffff',
  'fiber-optic': '#aaaaff', 'mirror-tunnel': '#8844ff', 'bubble-wrap': '#88ccff',
  'lightning-storm': '#ffffff', 'neon-grid': '#00ffff', 'oil-painting': '#cc6622',
    'sunrise-horizon': '#ff8800', 'sunrise-v2': '#ff8800',
};

function PatternCard({ pattern, isActive, isNextUp, onFire, recording }) {
  const color = pattern.preview
    ? undefined
    : (CARD_COLORS[pattern.id] || '#556');
  const compatibility = getPatternCompatibilityGate(pattern);

  return (
    <button
      className={`lw-live-card ${isActive ? 'active' : ''} ${isNextUp ? 'next-up' : ''}`}
      onClick={() => onFire(pattern.id)}
      title={`${pattern.desc || pattern.name}\n${compatibility.label}: ${compatibility.reason}`}
      aria-label={`${isActive ? 'Live pattern' : isNextUp ? 'Queued pattern' : 'Fade to pattern'} ${pattern.name}`}
    >
      <div className="lw-live-card-bg" style={
        pattern.preview
          ? { background: pattern.preview }
          : { background: `linear-gradient(135deg, ${color}88, ${color}22)` }
      }/>
      <div className="lw-live-card-scrim"/>
      <div className="lw-live-card-affordance">{isActive ? 'LIVE' : isNextUp ? 'NEXT' : 'FADE'}</div>
      <div className="lw-live-card-body">
        <div className="lw-live-card-name">{pattern.name}</div>
        <div className="lw-live-card-meta">
          <span className="lw-live-card-action">
            {isActive ? 'playing now' : isNextUp ? 'queued' : recording ? 'record fade' : 'fade'}
          </span>
          <span className={`lw-runtime-chip is-${compatibility.severity}`}>
            {compatibility.chip}
          </span>
        </div>
      </div>
      {isActive && <div className="lw-live-card-pulse"/>}
    </button>
  );
}

function BeatIndicator({ bpm, t }) {
  const beat = (t * bpm / 60) % 1;
  const bars = 16;
  const beatNow = Math.floor((t * bpm / 60) % bars);

  return (
    <div className="lw-live-beat">
      <div className="lw-live-beat-meter" style={{ '--beat': beat }}>
        <div className="lw-live-beat-fill"/>
      </div>
      <div className="lw-live-beat-count">{String((beatNow % 4) + 1)}<span>/4</span></div>
      <div className="lw-live-beat-bar">{Math.floor(beatNow / 4) + 1}<span>bar</span></div>
    </div>
  );
}

export function LiveScreen({ onOpenShow }) {
  const {
    activePatternId, setActivePatternId,
    bpm, setBpm,
    liveRecording, setLiveRecording,
    liveQuantize, setLiveQuantize,
    timelinePlaying, setTimelinePlaying, timelinePlayhead,
    showClips, setShowClips,
    showTransitions, setShowTransitions,
    recordLivePattern,
    strips, viewBox, svgText, hidden,
    masterSpeed, setMasterSpeed,
    masterBrightness, setMasterBrightness,
    masterSaturation, setMasterSaturation,
    masterHueShift, setMasterHueShift,
    gammaEnabled, gammaValue,
    motionSmoothing, setMotionSmoothing,
    wledPush, symSettings,
  } = useProject();

  const [search, setSearch]             = useState('');
  const [livecat, setLiveCat]           = useState('all');
  const [crossfadeDur, setCrossfadeDur] = useState(3);   // seconds
  const [liveT, setLiveT]               = useState(0);
  const [nextUp, setNextUp]             = useState(null); // queued for next bar
  const [fullscreen, setFullscreen]     = useState(false);
  const [frozen, setFrozen]             = useState(false); // pause pattern animation
  const [leftWidth, , beginLeftResize] = usePersistentPanelSize('lw-live-left-width', {
    defaultValue: 340,
    min: 260,
    max: 620,
  });
  const [scenes, setScenes]             = useState(() => {
    try { return JSON.parse(localStorage.getItem('lw_live_scenes') || '[]'); } catch { return []; }
  });
  // Crossfade state
  const [blendFrom, setBlendFrom]       = useState(null); // previous pattern during transition
  const [blendAmt, setBlendAmt]         = useState(0);    // 0 = all active, 1 = all blendFrom
  const blendStartRef = useRef(null);
  const tapsRef = useRef([]);

  const toggleRecording = useCallback(() => {
    setLiveRecording(recording => {
      const next = !recording;
      if (next) setTimelinePlaying(true);
      return next;
    });
  }, [setLiveRecording, setTimelinePlaying]);

  const filtered = useMemo(() => {
    let base = PATTERNS;
    if (livecat !== 'all') {
      const rule = LIVE_CATEGORY_RULES[livecat];
      if (rule) base = base.filter(p => rule.includes(p.id));
    }
    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.desc && p.desc.toLowerCase().includes(q)) ||
      p.id.includes(q));
  }, [search, livecat]);

  const recordedClips = useMemo(() => {
    return [...(showClips || [])]
      .filter(clip => clip.recorded)
      .sort((a, b) => a.start - b.start);
  }, [showClips]);

  const recordedTransitions = useMemo(() => {
    return [...(showTransitions || [])]
      .filter(transition => transition.recorded)
      .sort((a, b) => a.start - b.start);
  }, [showTransitions]);

  const lastRecordedClip = recordedClips[recordedClips.length - 1] || null;
  const recentRecordedClips = recordedClips.slice(-6);

  const undoLastRecorded = useCallback(() => {
    if (!lastRecordedClip) return;
    setShowClips(clips => clips
      .filter(clip => clip.id !== lastRecordedClip.id)
      .map(clip => {
        if (!clip.recorded || (clip.track ?? 0) !== 0) return clip;
        if (clip.start < lastRecordedClip.start && clip.end > lastRecordedClip.start) {
          return { ...clip, end: lastRecordedClip.start };
        }
        return clip;
      }));
    setShowTransitions(transitions => transitions.filter(transition =>
      transition.clipA !== lastRecordedClip.id && transition.clipB !== lastRecordedClip.id
    ));
  }, [lastRecordedClip, setShowClips, setShowTransitions]);

  const clearRecordedTake = useCallback(() => {
    setShowClips(clips => clips.filter(clip => !clip.recorded));
    setShowTransitions(transitions => transitions.filter(transition => !transition.recorded));
  }, [setShowClips, setShowTransitions]);

  const handleTap = useCallback(() => {
    const now = Date.now();
    const taps = tapsRef.current;
    if (taps.length > 0 && now - taps[taps.length - 1] > 2500) tapsRef.current = [];
    tapsRef.current = [...tapsRef.current.slice(-7), now];
    if (tapsRef.current.length >= 2) {
      const intervals = [];
      for (let i = 1; i < tapsRef.current.length; i++)
        intervals.push(tapsRef.current[i] - tapsRef.current[i - 1]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      setBpm(Math.max(20, Math.min(600, Math.round(60000 / avg))));
    }
  }, [setBpm]);

  const startCrossfade = useCallback((fromId, toId) => {
    if (crossfadeDur <= 0 || fromId === toId) {
      setBlendFrom(null);
      setBlendAmt(0);
      blendStartRef.current = null;
      setActivePatternId(toId);
      return;
    }
    setBlendFrom(fromId);
    setBlendAmt(1);
    blendStartRef.current = performance.now();
    setActivePatternId(toId);
  }, [crossfadeDur, setActivePatternId]);

  // Animate crossfade amount
  useEffect(() => {
    if (blendFrom === null || blendAmt <= 0) return;
    const rafId = requestAnimationFrame(() => {
      const elapsed = (performance.now() - (blendStartRef.current || performance.now())) / 1000;
      const progress = crossfadeDur <= 0 ? 1 : Math.min(1, elapsed / crossfadeDur);
      const newAmt = Math.max(0, 1 - easeCrossfade(progress, 'ease-in-out'));
      setBlendAmt(newAmt);
      if (newAmt <= 0) setBlendFrom(null);
    });
    return () => cancelAnimationFrame(rafId);
  }, [blendFrom, blendAmt, crossfadeDur]);

  const firePattern = useCallback((patternId) => {
    if (liveQuantize === 'beat' || liveQuantize === 'bar') {
      setNextUp(patternId);
    } else {
      startCrossfade(activePatternId, patternId);
      setNextUp(null);
      if (liveRecording) {
        recordLivePattern(patternId, { crossfadeSecs: crossfadeDur });
      }
    }
  }, [liveQuantize, activePatternId, startCrossfade, liveRecording, recordLivePattern, crossfadeDur]);

  // Keyboard shortcuts for live performance
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'r' || e.key === 'R') { toggleRecording(); return; }
      if (e.key === 't' || e.key === 'T') { handleTap(); return; }
      if (e.key === 'b' || e.key === 'B') { setActivePatternId(null); return; }
      if (e.key === 'f' || e.key === 'F') { setFrozen(fr => !fr); return; }
      // 1-9 keys fire the first 9 visible pattern cards.
      const n = parseInt(e.key);
      if (!isNaN(n) && n >= 1 && n <= 9 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        const p = filtered[n - 1];
        if (p) firePattern(p.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleRecording, handleTap, filtered, firePattern, setActivePatternId]);

  // Fire queued pattern on beat/bar boundary
  useEffect(() => {
    if (!nextUp) return;
    const beatSecs = 60 / bpm;
    const barSecs = beatSecs * 4;
    const interval = liveQuantize === 'bar' ? barSecs : beatSecs;
    const now = liveT;
    const nextBoundary = Math.ceil(now / interval) * interval;
    const delay = (nextBoundary - now) * 1000;
    const tid = setTimeout(() => {
      startCrossfade(activePatternId, nextUp);
      if (liveRecording) {
        recordLivePattern(nextUp, { crossfadeSecs: crossfadeDur });
      }
      setNextUp(null);
    }, Math.max(0, delay));
    return () => clearTimeout(tid);
  }, [nextUp, bpm, liveQuantize, liveT, activePatternId, startCrossfade, liveRecording, recordLivePattern, crossfadeDur]);

  const handleFrame = useCallback((pixels) => {
    if (wledPush) wledPush(pixels);
  }, [wledPush]);

  return (
    <div
      className={`lw-live-screen ${fullscreen ? 'fullscreen' : ''}`}
      style={{ '--lw-live-left-width': `${leftWidth}px` }}
    >

      {/* ── Left: preview + controls ── */}
      <div className="lw-live-left">
        <div className="lw-live-preview-wrap">
          <LEDPreview
            patternId={activePatternId}
            playing={!frozen}
            glow={0.85}
            dotSize={1.1}
            strips={strips?.length > 0 ? strips : undefined}
            viewBox={viewBox}
            svgText={svgText}
            hidden={hidden}
            masterSpeed={masterSpeed}
            masterBrightness={masterBrightness}
            masterSaturation={masterSaturation}
            masterHueShift={masterHueShift}
            gammaEnabled={gammaEnabled}
            gammaValue={gammaValue}
            bpm={bpm}
            symSettings={symSettings}
            blendPatternId={blendFrom}
            blendAmount={blendAmt}
            blendType="crossfade"
            motionSmoothing={motionSmoothing}
            onTick={setLiveT}
            onFrame={handleFrame}
          />
          <div className="lw-live-preview-overlay">
            <div className="lw-live-now-playing">
              <span className="dot" style={{ background: CARD_COLORS[activePatternId] || '#888' }}/>
              {PATTERNS.find(p => p.id === activePatternId)?.name || activePatternId}
            </div>
            {nextUp && (
              <div className="lw-live-next-up">
                NEXT → {PATTERNS.find(p => p.id === nextUp)?.name || nextUp}
              </div>
            )}
          </div>
        </div>

        <div className="lw-live-controls">
          <div className={`lw-live-record-dock ${liveRecording ? 'recording' : ''}`}>
            <div className="lw-live-record-head">
              <div>
                <div className="lw-live-record-title">
                  {liveRecording ? 'Recording to Show' : recordedClips.length ? 'Take ready' : 'Record to Show'}
                </div>
                <div className="lw-live-record-meta">
                  {recordedClips.length} clips · {recordedTransitions.length} fades · {liveQuantize}
                </div>
              </div>
              <button
                className={`btn ${liveRecording ? 'btn-danger' : 'btn-primary'} lw-live-record-main`}
                onClick={toggleRecording}
              >
                {liveRecording ? 'Stop Recording' : 'Start Recording to Show'}
              </button>
            </div>

            <div className="lw-live-flow">
              <span className={`lw-live-flow-step ${liveRecording ? 'active' : recordedClips.length ? 'done' : ''}`}>1 Start</span>
              <span className={`lw-live-flow-step ${liveRecording ? 'active' : recordedClips.length ? 'done' : ''}`}>2 Tap effects</span>
              <span className={`lw-live-flow-step ${recordedClips.length && !liveRecording ? 'active' : ''}`}>3 Open Show</span>
            </div>

            <div className="lw-live-take-strip" aria-label="Recorded take">
              {recentRecordedClips.length ? recentRecordedClips.map((clip, idx) => {
                const pattern = PATTERNS.find(p => p.id === clip.patternId);
                const color = CARD_COLORS[clip.patternId] || '#888';
                return (
                  <div key={clip.id} className="lw-live-take-item" title={`${pattern?.name || clip.patternId} · ${clip.start.toFixed(1)}s`}>
                    <span className="dot" style={{ background: color }}/>
                    <span>{pattern?.name || clip.patternId}</span>
                    {idx < recentRecordedClips.length - 1 && <span className="fade">→</span>}
                  </div>
                );
              }) : (
                <div className="lw-live-take-empty">No take recorded</div>
              )}
            </div>

            <div className="lw-live-record-actions">
              <button className="btn btn-ghost" onClick={undoLastRecorded} disabled={!lastRecordedClip}>Undo last</button>
              <button className="btn btn-ghost" onClick={clearRecordedTake} disabled={!recordedClips.length}>Clear take</button>
              <button className="btn btn-ghost" onClick={onOpenShow} disabled={!recordedClips.length}>Open Show</button>
            </div>
          </div>

          <details className="lw-live-timing" open={liveRecording || liveQuantize !== 'free'}>
            <summary>
              <span>Timing</span>
              <span>{formatCrossfadeDuration(crossfadeDur)} fade · {liveQuantize}</span>
            </summary>

            <BeatIndicator bpm={bpm} t={liveT}/>

            <div className="lw-live-ctrl-row">
              <span className="k">BPM</span>
              <input type="number" min="20" max="600" value={bpm}
                     onChange={e => setBpm(Math.max(20, Math.min(600, +e.target.value)))}
                     className="lw-live-bpm-input"/>
              <button className="btn" onClick={handleTap}>TAP</button>
            </div>

            <div className="lw-live-ctrl-row">
              <span className="k">Quantize</span>
              <div className="lw-tweaks-seg" style={{ flex: 1 }}>
                {['free','beat','bar'].map(q => (
                  <button key={q}
                          className={liveQuantize === q ? 'active' : ''}
                          onClick={() => setLiveQuantize(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </div>

            <div className="lw-live-ctrl-row">
              <span className="k">Crossfade</span>
              <input type="range" min="0" max="120" step="0.5" value={crossfadeDur}
                     onChange={e => setCrossfadeDur(clampCrossfadeDuration(e.target.value))} style={{ flex: 1 }}/>
              <input type="number" min="0" max="120" step="0.5" value={crossfadeDur}
                     onChange={e => setCrossfadeDur(clampCrossfadeDuration(e.target.value))}
                     className="lw-live-bpm-input" style={{ width: 62 }}/>
              <span className="v">{formatCrossfadeDuration(crossfadeDur)}</span>
            </div>

            <div className="lw-live-ctrl-row">
              <span className="k">Motion</span>
              <div className="lw-tweaks-seg" style={{ flex: 1 }}>
                {MOTION_SMOOTHING_MODES.map(mode => (
                  <button key={mode}
                          className={motionSmoothing === mode ? 'active' : ''}
                          onClick={() => setMotionSmoothing(mode)}>
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          </details>

          <div className="lw-live-ctrl-row">
            <span className="k" style={{ fontSize: 'var(--fs-2xs)' }}>Brightness</span>
            <input type="range" min="0" max="1" step="0.01" value={masterBrightness}
                   onChange={e => setMasterBrightness(+e.target.value)} style={{ flex: 1 }}/>
            <span className="v" style={{ fontSize: 'var(--fs-2xs)', minWidth: 28 }}>{Math.round(masterBrightness * 100)}%</span>
          </div>
          <div className="lw-live-ctrl-row">
            <span className="k" style={{ fontSize: 'var(--fs-2xs)' }}>Speed</span>
            <input type="range" min="0" max="4" step="0.01" value={masterSpeed}
                   onChange={e => setMasterSpeed(+e.target.value)} style={{ flex: 1 }}/>
            <span className="v" style={{ fontSize: 'var(--fs-2xs)', minWidth: 38 }}>{formatMotionSpeed(masterSpeed)}</span>
          </div>
          <div className="lw-live-ctrl-row">
            <span className="k" style={{ fontSize: 'var(--fs-2xs)' }}>Hue</span>
            <input type="range" min="-0.5" max="0.5" step="0.01" value={masterHueShift}
                   onChange={e => setMasterHueShift(+e.target.value)} style={{ flex: 1 }}/>
            <span className="v" style={{ fontSize: 'var(--fs-2xs)', minWidth: 30 }}>
              {masterHueShift >= 0 ? '+' : ''}{Math.round(masterHueShift * 360)}°
            </span>
          </div>

          {blendFrom && (
            <div className="lw-live-ctrl-row" style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
              <span className="k">Blend</span>
              <div style={{ flex: 1, height: 4, background: 'var(--surface-2)', borderRadius: 2 }}>
                <div style={{ width: `${blendAmt * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 2 }}/>
              </div>
              <span className="v">{Math.round(blendAmt * 100)}%</span>
            </div>
          )}

          <div className="lw-live-ctrl-row">
            <button
              className={`btn btn-ghost ${fullscreen ? 'active' : ''}`}
              onClick={() => setFullscreen(f => !f)}
              title="Toggle fullscreen performance mode"
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" width="12" height="12">
                <path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8"/>
              </svg>
            </button>
          </div>

          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <button
              className="btn"
              style={{ flex: 1, background: 'oklch(20% 0.01 0)', color: 'var(--text-3)',
                       border: '1px solid oklch(30% 0.01 0)', fontSize: 'var(--fs-sm)', fontWeight: 600,
                       letterSpacing: '0.06em' }}
              title="Blackout — send all-black frame (B)"
              onClick={() => {
                if (wledPush) wledPush(makeBlackoutFrame(strips.reduce((n, s) => n + (s.pixels?.length || s.pixelCount || 0), 0)));
                setActivePatternId(null);
              }}>
              BLACKOUT
            </button>
            <button
              className={`btn ${frozen ? 'active' : 'btn-ghost'}`}
              style={{ flex: 1, fontSize: 'var(--fs-sm)', fontWeight: frozen ? 600 : 400 }}
              title="Freeze — pause pattern animation (F)"
              onClick={() => setFrozen(f => !f)}>
              {frozen ? '❚❚ FROZEN' : '❚❚ Freeze'}
            </button>
          </div>

          {timelinePlaying && (
            <div className="lw-live-timeline-status">
              <span className="dot" style={{ background: 'var(--mint)' }}/>
              Timeline playing · {String(Math.floor(timelinePlayhead / 60)).padStart(2,'0')}:{String(Math.floor(timelinePlayhead % 60)).padStart(2,'0')}
            </div>
          )}
          {liveRecording && (
            <div className="lw-live-rec-status">
              ● Recording · tap an effect to write the next fade
              {liveQuantize !== 'free' && ` · quantized to ${liveQuantize}`}
            </div>
          )}
        </div>
      </div>

      <div
        className="lw-resize-handle lw-resize-handle--vertical lw-live-resize-handle"
        data-resize-key="lw-live-left-width"
        onMouseDown={e => beginLeftResize(e, { axis: 'x' })}
      />

      {/* ── Right: pattern grid ── */}
      <div className="lw-live-right">
        <div className="lw-live-grid-header">
          <span className="lw-live-grid-title">Pattern Grid</span>
          <span className="lw-live-grid-count">{filtered.length}</span>
          <input
            className="lw-live-search"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '4px 12px 6px' }}>
          {LIVE_CATS.map(c => (
            <button key={c}
                    className={`btn btn-ghost ${livecat === c ? 'active' : ''}`}
                    style={{ fontSize: 'var(--fs-2xs)', padding: '2px 7px', borderRadius: 99, textTransform: 'capitalize' }}
                    onClick={() => setLiveCat(c)}>
              {c === 'bpm' ? '♩ bpm' : c === 'audio' ? '♪ audio' : c}
            </button>
          ))}
        </div>
        {/* Scenes */}
        {scenes.length > 0 && (
          <div style={{ padding: '2px 12px 6px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-4)', alignSelf: 'center', marginRight: 2 }}>Scenes:</span>
            {scenes.map((sc, i) => (
              <button key={i}
                      className={`btn btn-ghost ${sc.cat === livecat && sc.search === search ? 'active' : ''}`}
                      style={{ fontSize: 'var(--fs-2xs)', padding: '2px 8px', borderRadius: 99 }}
                      title={`Recall: cat=${sc.cat}, search="${sc.search}"`}
                      onClick={() => { setLiveCat(sc.cat); setSearch(sc.search); }}
                      onContextMenu={e => {
                        e.preventDefault();
                        if (window.confirm(`Delete scene "${sc.name}"?`)) {
                          const next = scenes.filter((_, j) => j !== i);
                          setScenes(next);
                          try { localStorage.setItem('lw_live_scenes', JSON.stringify(next)); } catch {}
                        }
                      }}>
                {sc.name}
              </button>
            ))}
          </div>
        )}
        <div style={{ padding: '0 12px 4px' }}>
          <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', width: '100%' }}
                  onClick={() => {
                    const name = prompt('Scene name:');
                    if (!name?.trim()) return;
                    const next = [...scenes, { name: name.trim(), cat: livecat, search }];
                    setScenes(next);
                    try { localStorage.setItem('lw_live_scenes', JSON.stringify(next)); } catch {}
                  }}>
            + Save current view as scene
          </button>
        </div>

        <div className="lw-live-grid">
          {filtered.map((pattern, idx) => (
            <div key={pattern.id} style={{ position: 'relative' }}>
              {idx < 9 && (
                <span className="lw-live-card-hotkey">
                  {idx + 1}
                </span>
              )}
              <PatternCard
                pattern={pattern}
                isActive={activePatternId === pattern.id}
                isNextUp={nextUp === pattern.id}
                onFire={firePattern}
                recording={liveRecording}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
