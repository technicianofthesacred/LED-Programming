import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useProject, resolveTimelinePlayback, sampleLane } from '../state/ProjectContext.jsx';
import { LEDPreview } from './Preview.jsx';
import { PATTERNS } from '../data.js';

function fmt(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(2,'0')}`;
}

const CLIP_COLORS = {
  aurora: '#5fb8d9', ember: '#e89a3a', bloom: '#c84a8a',
  wave: '#3a6ac8', pulse: '#c84a3a', drift: '#8a4ac8',
  calm: '#3a8a6a', scanner: '#d9a84a', breathe: '#06d6a0',
  ripple: '#4ac8c8', fire: '#e85a3a', plasma: '#9a4ac8',
  lava: '#d95a3a', ocean: '#3a8ab8', candle: '#e8a03a',
  rainbow: '#e84ac8', sparkle: '#d9d94a', twinkle: '#8ab8d9',
  meteor: '#8a8ae8', strobe: '#d9d9d9', inkdrop: '#4a3a8a',
  stained: '#8a4a3a', heartbeat: '#e83a4a', neon: '#4ae8c8',
  matrix: '#3ae84a', glitch: '#e84a8a', warp: '#8a8ad9',
  confetti: '#e8a8e8', blocks: '#a8e880', 'binary-pulse': '#80a8e8',
  'pulse-ring': '#80e8c8', lightning: '#8080e8', chase: '#80c8e8',
  gradient: '#e8c880', 'debug-xy': '#808080',
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
  pixelate: '#ffcc00', smoke: '#888899',
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
  'sunrise-horizon': '#ff8800',
};

function lanePath(keys, width, height, duration) {
  return keys.map(([t, v], i) => {
    const x = (t / duration) * width;
    const y = height - v * height;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function applyTransitionCurve(t, curve) {
  switch (curve) {
    case 'ease-in-out': return t * t * (3 - 2 * t);
    case 'exp':         return 1 - Math.pow(1 - t, 3);
    case 's-curve':     return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    default:            return t;
  }
}

function Ruler({ width, pxPerSec, cues, duration, loopRegion, onMouseDown, onContextMenu }) {
  const ticks = [];
  const step = pxPerSec >= 2 ? 30 : pxPerSec >= 1 ? 60 : 120;
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  return (
    <div className="lw-tl-lane ruler" onMouseDown={onMouseDown} onContextMenu={onContextMenu} style={{ cursor: 'crosshair' }}>
      <svg width={width} height={28} style={{ display: 'block' }}>
        {loopRegion && (
          <rect x={loopRegion.start * pxPerSec} y={0}
                width={Math.max(0, (loopRegion.end - loopRegion.start) * pxPerSec)}
                height={28} fill="var(--accent)" opacity="0.18" style={{ pointerEvents: 'none' }}/>
        )}
        {loopRegion && <>
          <line x1={loopRegion.start * pxPerSec} y1={0} x2={loopRegion.start * pxPerSec} y2={28}
                stroke="var(--accent)" strokeWidth="1.5" opacity="0.7" style={{ pointerEvents: 'none' }}/>
          <line x1={loopRegion.end * pxPerSec} y1={0} x2={loopRegion.end * pxPerSec} y2={28}
                stroke="var(--accent)" strokeWidth="1.5" opacity="0.7" style={{ pointerEvents: 'none' }}/>
          <text x={loopRegion.start * pxPerSec + 3} y={9} fontSize="7" fill="var(--accent)"
                fontFamily="var(--mono-font)" style={{ pointerEvents: 'none' }}>↺</text>
        </>}
        {ticks.map(t => {
          const x = t * pxPerSec;
          const big = t % 60 === 0;
          return (
            <g key={t}>
              <line x1={x} y1={big ? 10 : 18} x2={x} y2={28} stroke="var(--border-2)" strokeWidth={big ? 1 : 0.5}/>
              {big && <text x={x + 3} y={9} fontSize="8" fill="var(--text-4)" fontFamily="var(--mono-font)">{fmt(t)}</text>}
            </g>
          );
        })}
        {cues.map((c, i) => {
          const x = c.t * pxPerSec;
          return (
            <g key={i}>
              <polygon points={`${x},28 ${x-3},18 ${x+3},18`} fill="var(--accent)" opacity="0.8"/>
              <text x={x + 4} y={17} fontSize="7" fill="var(--accent)" fontFamily="var(--mono-font)">{c.kbd}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Clip({ clip, pxPerSec, selected, multiSelected, onSelect, onResize, onMove }) {
  const left  = clip.start * pxPerSec;
  const width = Math.max(4, (clip.end - clip.start) * pxPerSec);
  const color = clip.color || CLIP_COLORS[clip.patternId] || '#888';
  const dragRef = useRef(false);

  const handleHandleDown = useCallback((e, edge) => {
    e.stopPropagation();
    e.preventDefault();
    const startX   = e.clientX;
    const startVal = edge === 'start' ? clip.start : clip.end;
    const onMv = (me) => {
      onResize(clip.id, edge, startVal + (me.clientX - startX) / pxPerSec);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMv);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMv);
    window.addEventListener('mouseup', onUp);
  }, [clip.id, clip.start, clip.end, pxPerSec, onResize]);

  const handleBodyDown = useCallback((e) => {
    if (e.target.classList.contains('clip-handle')) return;
    const startX    = e.clientX;
    const origStart = clip.start;
    const dur       = clip.end - clip.start;
    dragRef.current = false;
    const onMv = (me) => {
      const delta = (me.clientX - startX) / pxPerSec;
      if (Math.abs(me.clientX - startX) > 3) dragRef.current = true;
      if (dragRef.current) onMove(clip.id, origStart + delta, dur);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMv);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMv);
    window.addEventListener('mouseup', onUp);
  }, [clip.id, clip.start, clip.end, pxPerSec, onMove]);

  return (
    <div className={`lw-tl-clip ${selected || multiSelected ? 'selected' : ''} ${multiSelected ? 'multi-sel' : ''} ${clip.recorded ? 'recorded' : ''}`}
         style={{ left, width, '--clip-color': color }}
         onMouseDown={handleBodyDown}
         onClick={e => { if (!dragRef.current) onSelect(e); }}>
      <div className="clip-bg"/>
      <div className="clip-label">
        <span className="dot" style={{ background: color }}/>
        <span className="name">{clip.label}</span>
      </div>
      <div className="clip-meta">
        <span>{clip.patternId}</span>
        <span className="sep">·</span>
        <span>{(clip.end - clip.start).toFixed(0)}s</span>
        {clip.recorded && <><span className="sep">·</span><span style={{color:'var(--danger)'}}>REC</span></>}
      </div>
      <div className="clip-handle left"  onMouseDown={e => handleHandleDown(e, 'start')}/>
      <div className="clip-handle right" onMouseDown={e => handleHandleDown(e, 'end')}/>
    </div>
  );
}

function TransitionZone({ trans, pxPerSec, selected, onSelect }) {
  const left  = trans.start * pxPerSec;
  const width = Math.max(4, (trans.end - trans.start) * pxPerSec);
  const icon  = { crossfade: '⤫', 'fade-black': '◐', 'fade-white': '◑', dissolve: '▦', wipe: '▶' }[trans.type] || '⤫';
  return (
    <div className={`lw-tl-trans ${selected ? 'selected' : ''}`}
         style={{ left, width }}
         onClick={e => { e.stopPropagation(); onSelect(); }}
         title={trans.type}>
      <div className="trans-glyph">{icon}</div>
    </div>
  );
}

function AutomationLane({ lane, width, duration, onSetLane }) {
  const height = 44;

  const handleClick = (e) => {
    if (!onSetLane) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(duration, ((e.clientX - rect.left) / width) * duration));
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / height));
    const keys = [...lane.keys, [Math.round(t), parseFloat(v.toFixed(2))]].sort((a, b) => a[0] - b[0]);
    onSetLane(lane.id, keys);
  };

  const handleKeyDrag = (e, keyIdx) => {
    if (!onSetLane) return;
    e.stopPropagation();
    const rect = e.currentTarget.closest('svg').getBoundingClientRect();
    const onMv = (me) => {
      const t = Math.max(0, Math.min(duration, ((me.clientX - rect.left) / width) * duration));
      const v = Math.max(0, Math.min(1, 1 - (me.clientY - rect.top) / height));
      const keys = lane.keys.map((k, i) => i === keyIdx ? [Math.round(t), parseFloat(v.toFixed(2))] : k)
                             .sort((a, b) => a[0] - b[0]);
      onSetLane(lane.id, keys);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMv);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMv);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="lw-tl-lane auto">
      <svg width={width} height={height} style={{ display: 'block', cursor: 'crosshair' }}
           onClick={handleClick}>
        <defs>
          <linearGradient id={`grad-${lane.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={lane.color} stopOpacity="0.35"/>
            <stop offset="1" stopColor={lane.color} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="var(--border)" strokeWidth="1"/>
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="var(--border)" strokeWidth="0.5" strokeDasharray="2 3"/>
        <path d={`${lanePath(lane.keys, width, height, duration)} L${width},${height} L0,${height} Z`}
              fill={`url(#grad-${lane.id})`}/>
        <path d={lanePath(lane.keys, width, height, duration)} fill="none" stroke={lane.color} strokeWidth="1.5" strokeLinejoin="round"/>
        {lane.keys.map(([t, v], i) => {
          const x = (t / duration) * width;
          const y = height - v * height;
          return <rect key={i} x={x - 4} y={y - 4} width="8" height="8"
                       fill="var(--surface)" stroke={lane.color} strokeWidth="1.5"
                       transform={`rotate(45 ${x} ${y})`}
                       style={{ cursor: 'move' }}
                       onMouseDown={e => handleKeyDrag(e, i)}
                       onDoubleClick={e => {
                         e.stopPropagation();
                         if (!onSetLane) return;
                         onSetLane(lane.id, lane.keys.filter((_, j) => j !== i));
                       }}/>;
        })}
      </svg>
    </div>
  );
}

const WAVE_SAMPLES = (() => {
  const n = 240, out = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const env = 0.25 + 0.75 * Math.pow(Math.sin(t * Math.PI), 1.4);
    const x = t * 50;
    const noise = Math.sin(x*1.3)*0.3 + Math.sin(x*2.7)*0.25 + Math.sin(x*6.1)*0.2 + Math.sin(x*11.2)*0.15;
    out.push(Math.max(0.05, Math.min(1, env * (0.6 + noise * 0.4))));
  }
  return out;
})();

function AudioLane({ width }) {
  const height = 48;
  const n = WAVE_SAMPLES.length;
  const barW = width / n;
  return (
    <div className="lw-tl-lane audio">
      <svg width={width} height={height} style={{ display: 'block' }}>
        <line x1="0" y1={height/2} x2={width} y2={height/2} stroke="var(--border-2)" strokeWidth="0.5"/>
        {WAVE_SAMPLES.map((v, i) => {
          const h = v * (height - 4);
          return <rect key={i} x={i * barW} y={(height - h) / 2} width={Math.max(barW - 0.4, 0.6)} height={h}
                       fill="var(--text-3)" opacity="0.7"/>;
        })}
      </svg>
    </div>
  );
}

function LiveTimelinePreview({ playhead, clips, transitions, duration, strips, viewBox, svgText, hidden, bpm, wledPush, masterSpeed, masterBrightness, masterSaturation, masterHueShift, gammaEnabled, gammaValue }) {
  const { patternId, blendPatternId, blendAmount, transType, transCurve } = resolveTimelinePlayback(playhead, clips, transitions);
  const curvedBlend = blendAmount > 0 ? applyTransitionCurve(blendAmount, transCurve) : 0;

  const handleFrame = useCallback((pixels) => {
    if (wledPush) wledPush(pixels);
  }, [wledPush]);

  return (
    <div className="lw-tl-preview">
      <div className="lw-tl-preview-header">
        <span className="label">PREVIEW</span>
        <span className="sep">·</span>
        <span>{fmt(playhead)}</span>
        <span className="sep">·</span>
        <span>{patternId || '—'}</span>
        {blendPatternId && (
          <><span className="sep">·</span>
          <span className="trans-badge">{transType} {Math.round(curvedBlend * 100)}%</span></>
        )}
      </div>
      <div className="lw-tl-preview-stage">
        {patternId ? (
          <LEDPreview
            patternId={patternId}
            blendPatternId={blendPatternId}
            blendAmount={curvedBlend}
            playing={true}
            glow={1.4}
            dotSize={1.0}
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
            onFrame={handleFrame}
          />
        ) : (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color:'var(--text-4)', fontSize:'var(--fs-sm)' }}>
            No clip at playhead
          </div>
        )}
        <div className="lw-tl-preview-vignette"/>
      </div>
    </div>
  );
}

function EnvelopeEditor({ clip, onUpdate }) {
  const svgRef = useRef(null);
  const dur = clip.end - clip.start;
  const fadeIn  = Math.max(0, Math.min(dur * 0.45, clip.fadeIn  ?? 2.8));
  const fadeOut = Math.max(0, Math.min(dur * 0.45, clip.fadeOut ?? 2.8));
  const inPct   = fadeIn  / dur;
  const outPct  = fadeOut / dur;
  const ix = inPct  * 100;
  const ox = (1 - outPct) * 100;
  const TOP = 4, BOT = 30;

  const startDrag = (e, edge) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const onMv = (me) => {
      const rect = svg.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width));
      const newDur = Math.max(0, Math.min(dur * 0.45, frac * dur));
      onUpdate(edge === 'in' ? { fadeIn: newDur } : { fadeOut: dur - frac * dur });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMv);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMv);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div style={{ position: 'relative' }}>
      <svg ref={svgRef} viewBox="0 0 100 30" preserveAspectRatio="none"
           style={{ width: '100%', height: 40, display: 'block', cursor: 'ew-resize' }}>
        <path d={`M0 ${BOT} L${ix.toFixed(1)} ${TOP} L${ox.toFixed(1)} ${TOP} L100 ${BOT}`}
              fill="none" stroke="var(--accent)" strokeWidth="1.2"/>
        <path d={`M0 ${BOT} L${ix.toFixed(1)} ${TOP} L${ox.toFixed(1)} ${TOP} L100 ${BOT} Z`}
              fill="var(--accent)" fillOpacity="0.15"/>
        {/* fade-in handle */}
        <circle cx={ix.toFixed(1)} cy={TOP} r="3" fill="var(--accent)" style={{ cursor: 'ew-resize' }}
                onMouseDown={e => startDrag(e, 'in')}/>
        {/* fade-out handle */}
        <circle cx={ox.toFixed(1)} cy={TOP} r="3" fill="var(--accent)" style={{ cursor: 'ew-resize' }}
                onMouseDown={e => startDrag(e, 'out')}/>
      </svg>
      <div className="lw-insp-env-labels">
        <span>in {fadeIn.toFixed(1)}s</span>
        <span>hold {Math.max(0, dur - fadeIn - fadeOut).toFixed(1)}s</span>
        <span>out {fadeOut.toFixed(1)}s</span>
      </div>
    </div>
  );
}

function TimelineInspector({ selectedClip, selectedTrans, onExport, clips, onDeleteClip, onDeleteTrans, onDuplicateClip, onAddTransition, onSplitClip, multiSel, onClearMultiSel }) {
  const { setShowTransitions, setShowClips, showCues, setShowCues, showDuration } = useProject();
  const [inspTab, setInspTab] = useState('auto'); // 'auto' | 'show'
  const activeTab = inspTab === 'show' ? 'show' : (selectedTrans && !selectedClip) ? 'trans' : selectedClip ? 'clip' : 'show';

  return (
    <div className="lw-tl-inspector">
      <div className="lw-tl-inspector-tabs">
        <button className={`tab ${activeTab === 'clip' ? 'active' : ''}`}
                onClick={() => setInspTab('auto')}>Clip</button>
        <button className={`tab ${activeTab === 'trans' ? 'active' : ''}`}
                onClick={() => setInspTab('auto')}>Transition</button>
        <button className={`tab ${activeTab === 'show' ? 'active' : ''}`}
                onClick={() => setInspTab('show')}>Show</button>
      </div>
      <div className="lw-tl-inspector-body">
        {selectedClip && (
          <>
            <div className="lw-insp-header">
              <span className="dot" style={{ background: CLIP_COLORS[selectedClip.patternId] || '#888' }}/>
              <input
                defaultValue={selectedClip.label}
                onBlur={e => setShowClips(cs => cs.map(c => c.id === selectedClip.id ? { ...c, label: e.target.value } : c))}
                onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                style={{ background: 'none', border: 'none', borderBottom: '1px solid var(--border-2)',
                         color: 'var(--text)', fontSize: 'var(--fs-md)', fontWeight: 500, flex: 1, outline: 'none' }}
              />
              <span className="kbd">C</span>
            </div>
            <div className="lw-insp-row"><span className="k">Pattern</span>
              <select className="lw-insp-select" value={selectedClip.patternId}
                      onChange={e => setShowClips(cs => cs.map(c => c.id === selectedClip.id
                        ? { ...c, patternId: e.target.value, label: c.label === c.patternId ? e.target.value : c.label }
                        : c))}>
                {PATTERNS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="lw-insp-row"><span className="k">Color</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <div style={{ width: 18, height: 18, borderRadius: 3, border: '1px solid var(--border-2)',
                              background: selectedClip.color || CLIP_COLORS[selectedClip.patternId] || '#888' }}/>
                <input type="color"
                       value={selectedClip.color || CLIP_COLORS[selectedClip.patternId] || '#888888'}
                       style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
                       onChange={e => setShowClips(cs => cs.map(c => c.id === selectedClip.id ? { ...c, color: e.target.value } : c))}/>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)', fontFamily: 'var(--mono-font)' }}>
                  {selectedClip.color || 'default'}
                </span>
                {selectedClip.color && (
                  <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 5px' }}
                          onClick={() => setShowClips(cs => cs.map(c => c.id === selectedClip.id ? { ...c, color: undefined } : c))}>
                    Reset
                  </button>
                )}
              </label>
            </div>
            <div className="lw-insp-row"><span className="k">Target</span><span className="v">{selectedClip.group || 'All groups'}</span></div>
            <div className="lw-insp-row"><span className="k">Start</span><span className="v mono">{fmt(selectedClip.start)}</span></div>
            <div className="lw-insp-row"><span className="k">End</span><span className="v mono">{fmt(selectedClip.end)}</span></div>
            <div className="lw-insp-row"><span className="k">Length</span><span className="v mono">{fmt(selectedClip.end - selectedClip.start)}</span></div>
            <div className="lw-insp-row"><span className="k">Track</span>
              <select className="lw-insp-select" value={selectedClip.track ?? 0}
                      onChange={e => setShowClips(cs => cs.map(c => c.id === selectedClip.id ? { ...c, track: +e.target.value } : c))}>
                <option value={0}>Master</option>
                <option value={1}>Outer ring</option>
              </select>
            </div>
            <div className="lw-insp-row"><span className="k">Speed</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                <input type="range" min="0.1" max="4" step="0.05"
                       value={selectedClip.speed ?? 1}
                       style={{ flex: 1 }}
                       onChange={e => setShowClips(cs => cs.map(c => c.id === selectedClip.id ? { ...c, speed: +e.target.value } : c))}/>
                <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-sm)', minWidth: 34 }}>
                  {(selectedClip.speed ?? 1).toFixed(2)}×
                </span>
                {(selectedClip.speed ?? 1) !== 1 && (
                  <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 5px' }}
                          onClick={() => setShowClips(cs => cs.map(c => c.id === selectedClip.id ? { ...c, speed: 1 } : c))}>
                    Reset
                  </button>
                )}
              </div>
            </div>
            <div className="lw-insp-row"><span className="k">Brightness</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                <input type="range" min="0" max="1" step="0.01"
                       value={selectedClip.brightness ?? 1}
                       style={{ flex: 1 }}
                       onChange={e => setShowClips(cs => cs.map(c => c.id === selectedClip.id ? { ...c, brightness: +e.target.value } : c))}/>
                <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-sm)', minWidth: 34 }}>
                  {Math.round((selectedClip.brightness ?? 1) * 100)}%
                </span>
              </div>
            </div>
            <div className="lw-insp-row"><span className="k">Notes</span>
              <input
                placeholder="Clip notes…"
                defaultValue={selectedClip.notes || ''}
                onBlur={e => setShowClips(cs => cs.map(c => c.id === selectedClip.id ? { ...c, notes: e.target.value } : c))}
                onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                style={{ flex: 1, background: 'none', border: 'none', borderBottom: '1px solid var(--border)',
                         color: 'var(--text)', fontSize: 'var(--fs-sm)', outline: 'none' }}
              />
            </div>
            <div className="lw-insp-divider"/>
            <div className="lw-insp-section">Envelope</div>
            <div className="lw-insp-env">
              <EnvelopeEditor
                clip={selectedClip}
                onUpdate={patch => setShowClips(cs => cs.map(c => c.id === selectedClip.id ? { ...c, ...patch } : c))}
              />
            </div>
          </>
        )}
        {selectedTrans && !selectedClip && (
          <>
            <div className="lw-insp-header">
              <span className="dot" style={{ background: 'var(--accent)' }}/>
              <h3>{selectedTrans.type.replace('-', ' ')}</h3>
              <span className="kbd">T</span>
            </div>
            <div className="lw-insp-row"><span className="k">Type</span>
              <select className="lw-insp-select" value={selectedTrans.type}
                      onChange={e => setShowTransitions(ts => ts.map(t => t.id === selectedTrans.id ? { ...t, type: e.target.value } : t))}>
                <option value="crossfade">crossfade</option>
                <option value="dissolve">dissolve</option>
                <option value="fade-black">fade-black</option>
                <option value="fade-white">fade-white</option>
                <option value="wipe">wipe</option>
              </select>
            </div>
            <div className="lw-insp-row"><span className="k">Duration</span>
              <span className="v mono">{(selectedTrans.end - selectedTrans.start).toFixed(1)}s</span>
            </div>
            <div className="lw-insp-divider"/>
            <div className="lw-insp-section">Curve</div>
            <div className="lw-insp-curves">
              {['linear','ease-in-out','s-curve','exp'].map((e, i) => (
                <button key={i}
                        className={`curve-btn ${selectedTrans.curve === e || (!selectedTrans.curve && e === 'linear') ? 'active' : ''}`}
                        onClick={() => setShowTransitions(ts => ts.map(t => t.id === selectedTrans.id ? { ...t, curve: e } : t))}>
                  <svg viewBox="0 0 30 16" preserveAspectRatio="none">
                    {e === 'linear'      && <path d="M0 16 L30 0" stroke="currentColor" strokeWidth="1" fill="none"/>}
                    {e === 'ease-in-out' && <path d="M0 16 Q15 16 15 8 T30 0" stroke="currentColor" strokeWidth="1" fill="none"/>}
                    {e === 's-curve'     && <path d="M0 16 C10 16 5 0 15 0 C25 0 20 0 30 0" stroke="currentColor" strokeWidth="1" fill="none"/>}
                    {e === 'exp'         && <path d="M0 16 Q22 16 30 0" stroke="currentColor" strokeWidth="1" fill="none"/>}
                  </svg>
                  <span>{e}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {activeTab === 'show' && (
          <div style={{ padding: '4px 0' }}>
            <div className="lw-insp-section" style={{ marginBottom: 6 }}>Overview</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 10 }}>
              {[
                ['Clips', clips.length],
                ['Transitions', (clips.length > 0 ? clips.length - 1 : 0) + ' est'],
                ['Tracks', '2 active'],
                ['Duration', `${Math.floor(showDuration / 60)}m ${showDuration % 60}s`],
              ].map(([label, val]) => (
                <div key={label} style={{ background: 'var(--surface)', borderRadius: 4, padding: '4px 8px' }}>
                  <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-4)' }}>{label}</div>
                  <div style={{ fontSize: 'var(--fs-md)', fontFamily: 'var(--mono-font)', color: 'var(--text)' }}>{val}</div>
                </div>
              ))}
            </div>
            <div className="lw-insp-section" style={{ marginBottom: 8 }}>Cue markers</div>
            {showCues.map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 'var(--fs-sm)' }}>
                <span style={{ fontFamily: 'var(--mono-font)', color: 'var(--accent)', minWidth: 24 }}>{c.kbd}</span>
                <input
                  defaultValue={c.name}
                  onBlur={e => setShowCues(cs => cs.map((q, j) => j === i ? { ...q, name: e.target.value } : q))}
                  onKeyDown={e => e.key === 'Enter' && e.target.blur()}
                  style={{ flex: 1, background: 'none', border: 'none', borderBottom: '1px solid var(--border)',
                           color: 'var(--text)', fontSize: 'var(--fs-sm)', outline: 'none' }}
                />
                <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', minWidth: 40 }}>{fmt(c.t)}</span>
                <button onClick={() => setShowCues(cs => cs.filter((_, j) => j !== i))}
                        style={{ background: 'none', border: 'none', color: 'var(--text-4)', cursor: 'pointer', fontSize: 'var(--fs-md)' }}>×</button>
              </div>
            ))}
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)', width: '100%', marginTop: 6 }}
                    onClick={() => setShowCues(cs => [...cs, { t: Math.round(showDuration * 0.5), name: `Cue ${cs.length + 1}`, kbd: `Q${cs.length + 1}` }])}>
              + Add cue
            </button>
          </div>
        )}
        {activeTab !== 'show' && !selectedClip && !selectedTrans && multiSel?.size > 0 && (
          <div style={{ padding: '12px 0', fontSize: 'var(--fs-sm)', textAlign: 'center' }}>
            <div style={{ color: 'var(--accent)', marginBottom: 8 }}>{multiSel.size} clips selected</div>
            <button className="btn btn-ghost lw-btn-danger" style={{ fontSize: 'var(--fs-sm)', width: '80%' }}
                    onClick={() => { setShowClips(cs => cs.filter(c => !multiSel.has(c.id))); onClearMultiSel?.(); }}>
              Delete {multiSel.size} clips
            </button>
          </div>
        )}
        {activeTab !== 'show' && !selectedClip && !selectedTrans && (!multiSel || multiSel.size === 0) && (
          <div style={{ padding: '20px 0', color: 'var(--text-4)', fontSize: 'var(--fs-sm)', textAlign: 'center' }}>
            Click a clip or transition to inspect<br/>
            <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.7 }}>Shift+click to multi-select · ⌘A to select all</span>
          </div>
        )}
        <div className="lw-insp-divider" style={{ marginTop: 'auto' }}/>
        {selectedClip && (
          <>
            <button className="btn btn-ghost" style={{ width: '100%', fontSize: 'var(--fs-sm)', marginBottom: 4 }}
                    onClick={() => onAddTransition?.(selectedClip.id)}>
              + Transition After Clip
            </button>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <button className="btn btn-ghost" style={{ flex: 1, fontSize: 'var(--fs-sm)' }}
                      title="Split clip at playhead position"
                      onClick={() => onSplitClip?.(selectedClip.id)}>
                Split
              </button>
              <button className="btn btn-ghost" style={{ flex: 1, fontSize: 'var(--fs-sm)' }}
                      onClick={() => onDuplicateClip?.(selectedClip.id)}>
                Duplicate
              </button>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              <button className="btn btn-ghost lw-btn-danger" style={{ flex: 1, fontSize: 'var(--fs-sm)' }}
                      onClick={() => onDeleteClip?.(selectedClip.id)}>
                Delete
              </button>
            </div>
          </>
        )}
        {selectedTrans && !selectedClip && (
          <button className="btn btn-ghost lw-btn-danger" style={{ width: '100%', marginBottom: 6 }}
                  onClick={() => onDeleteTrans?.(selectedTrans.id)}>
            Delete Transition
          </button>
        )}
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 2 }} onClick={onExport}>
          Export Show →
        </button>
      </div>
    </div>
  );
}

export function TimelineScreen({ onExport }) {
  const {
    showClips, setShowClips,
    showTransitions, setShowTransitions,
    showCues, setShowCues,
    autoLanes, setAutoLanes,
    showDuration,
    timelinePlaying,  setTimelinePlaying,
    timelinePlayhead, setTimelinePlayhead,
    liveRecording,    setLiveRecording,
    liveQuantize,     setLiveQuantize,
    bpm,
    strips, viewBox, svgText, hidden,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaEnabled, gammaValue,
    setShowDuration,
    wledPush,
    setActivePatternId,
    patternParams,
    undoTimeline, redoTimeline,
    setBpm,
  } = useProject();

  const [zoom, setZoom]         = useState(1.2);
  const tapTimesRef = useRef([]);
  const [selected, setSelected] = useState({ kind: 'clip', id: 'c2' });
  const [multiSel, setMultiSel] = useState(new Set()); // set of clip IDs for multi-select
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopRegion, setLoopRegion]   = useState(null); // null = full show
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [playRate,    setPlayRate]     = useState(1.0); // playback speed multiplier
  const [mutedTracks, setMutedTracks] = useState(new Set()); // set of muted track numbers
  const [soloTrack,   setSoloTrack]   = useState(null);      // null or track number
  const scrollRef    = useRef(null);
  const rafRef       = useRef(null);
  const lastRef      = useRef(null);
  const clipboardRef = useRef(null); // stores copied clip

  // ── Playback loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!timelinePlaying) { cancelAnimationFrame(rafRef.current); return; }
    lastRef.current = null;
    const tick = (now) => {
      if (lastRef.current === null) lastRef.current = now;
      const dt = (now - lastRef.current) / 1000;
      lastRef.current = now;
      setTimelinePlayhead(p => {
        const next = p + dt * playRate;
        const loopEnd   = loopEnabled ? (loopRegion ? loopRegion.end   : showDuration) : showDuration;
        const loopBack  = loopEnabled ? (loopRegion ? loopRegion.start : 0) : null;
        if (next >= loopEnd) {
          if (loopEnabled) return loopBack;
          setTimelinePlaying(false);
          return showDuration;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [timelinePlaying, showDuration, loopEnabled, loopRegion, playRate, setTimelinePlayhead, setTimelinePlaying]);

  // ── Keep global activePatternId synced with timeline ─────────────────────
  useEffect(() => {
    if (!timelinePlaying) return;
    const { patternId } = resolveTimelinePlayback(timelinePlayhead, showClips, showTransitions);
    if (patternId) setActivePatternId(patternId);
  }, [timelinePlayhead, timelinePlaying, showClips, showTransitions, setActivePatternId]);

  // ── Automation: apply lane values to master controls ─────────────────────
  const { setMasterSpeed, setMasterBrightness } = useProject();
  useEffect(() => {
    if (!timelinePlaying) return;
    for (const lane of autoLanes) {
      const v = sampleLane(lane, timelinePlayhead);
      if (lane.param === 'speed')      setMasterSpeed(Math.max(0, Math.min(4, v * 4)));
      if (lane.param === 'brightness') setMasterBrightness(Math.max(0, Math.min(1, v)));
    }
  }, [timelinePlayhead, timelinePlaying, autoLanes, setMasterSpeed, setMasterBrightness]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      // Space = play/stop
      if (e.key === ' ') { e.preventDefault(); setTimelinePlaying(p => !p); return; }
      // Home = go to start
      if (e.key === 'Home') { e.preventDefault(); setTimelinePlayhead(0); return; }
      // End = go to end
      if (e.key === 'End') { e.preventDefault(); setTimelinePlayhead(showDuration); return; }
      // Arrow keys = nudge selected clip (Alt), jog 1s (plain), or jog 10s (shift)
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (e.altKey && selected.kind === 'clip' && selected.id) {
          const nudge = e.shiftKey ? 10 : 1;
          setShowClips(cs => cs.map(c => {
            if (c.id !== selected.id) return c;
            const dur = c.end - c.start;
            const s = Math.max(0, c.start - nudge);
            return { ...c, start: s, end: s + dur };
          }));
        } else {
          setTimelinePlayhead(p => Math.max(0, p - (e.shiftKey ? 10 : 1)));
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (e.altKey && selected.kind === 'clip' && selected.id) {
          const nudge = e.shiftKey ? 10 : 1;
          setShowClips(cs => cs.map(c => {
            if (c.id !== selected.id) return c;
            const dur = c.end - c.start;
            const s = Math.min(showDuration - dur, c.start + nudge);
            return { ...c, start: s, end: s + dur };
          }));
        } else {
          setTimelinePlayhead(p => Math.min(showDuration, p + (e.shiftKey ? 10 : 1)));
        }
        return;
      }
      // Delete / Backspace = remove selected clip/transition (or multi-selection)
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selected.id || multiSel.size > 0)) {
        if (multiSel.size > 0) {
          setShowClips(cs => cs.filter(c => !multiSel.has(c.id)));
          setMultiSel(new Set());
          setSelected({ kind: 'clip', id: null });
        } else {
          if (selected.kind === 'clip') setShowClips(cs => cs.filter(c => c.id !== selected.id));
          if (selected.kind === 'trans') setShowTransitions(ts => ts.filter(t => t.id !== selected.id));
          setSelected({ kind: 'clip', id: null });
        }
        return;
      }
      // Cmd+A = select all clips
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        setMultiSel(new Set(showClips.map(c => c.id)));
        return;
      }
      // Cue hotkeys: Shift+1–9
      if (e.shiftKey) {
        const idx = parseInt(e.key) - 1;
        if (!isNaN(idx) && showCues[idx]) { setTimelinePlayhead(showCues[idx].t); return; }
      }
      // Undo/redo
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoTimeline(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redoTimeline(); return; }
      // Copy/paste clip
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && selected.kind === 'clip' && selected.id) {
        const clip = showClips.find(c => c.id === selected.id);
        if (clip) { clipboardRef.current = clip; e.preventDefault(); }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboardRef.current) {
        e.preventDefault();
        const src = clipboardRef.current;
        const dur = src.end - src.start;
        const newId = `clip_${Date.now()}`;
        const newClip = { ...src, id: newId, start: timelinePlayhead, end: Math.min(showDuration, timelinePlayhead + dur) };
        setShowClips(cs => [...cs, newClip]);
        setSelected({ kind: 'clip', id: newId });
        return;
      }
      // L = clear loop region
      if (e.key === 'l' && !e.metaKey && !e.ctrlKey && !e.shiftKey) { setLoopRegion(null); return; }
      // S = split selected clip at playhead
      if (e.key === 's' && !e.metaKey && !e.ctrlKey && !e.shiftKey && selected.id && selected.kind === 'clip') {
        handleSplitClip(selected.id); return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showCues, showDuration, selected, multiSel, showClips, timelinePlayhead, setTimelinePlayhead, setTimelinePlaying, setShowClips, setShowTransitions, undoTimeline, redoTimeline, handleSplitClip]);

  // ── Scroll playhead into view ─────────────────────────────────────────────
  useEffect(() => {
    if (!timelinePlaying || !scrollRef.current) return;
    const x = timelinePlayhead * zoom;
    const { scrollLeft, clientWidth } = scrollRef.current;
    if (x < scrollLeft + 40 || x > scrollLeft + clientWidth - 80) {
      scrollRef.current.scrollLeft = Math.max(0, x - clientWidth * 0.3);
    }
  }, [timelinePlayhead, timelinePlaying, zoom]);

  const activeClips = useMemo(() => {
    return showClips.filter(c => {
      const track = c.track ?? 0;
      if (soloTrack !== null) return track === soloTrack;
      return !mutedTracks.has(track);
    });
  }, [showClips, mutedTracks, soloTrack]);

  const pxPerSec    = zoom;
  const totalWidth  = showDuration * pxPerSec;
  const snapGrid    = bpm > 0 ? 60 / bpm : 5; // snap to beat or 5s grid
  const snap        = useCallback((t) => snapEnabled ? Math.round(t / snapGrid) * snapGrid : t, [snapEnabled, snapGrid]);
  const selectedClip = selected.kind === 'clip'  ? showClips.find(c => c.id === selected.id)        : null;
  const selectedTrans = selected.kind === 'trans' ? showTransitions.find(t => t.id === selected.id) : null;

  const handleResizeClip = useCallback((id, edge, newVal) => {
    const snapped = snap(newVal);
    setShowClips(cs => cs.map(c => {
      if (c.id !== id) return c;
      if (edge === 'start') return { ...c, start: Math.max(0, Math.min(c.end - 1, snapped)) };
      return { ...c, end: Math.max(c.start + 1, Math.min(showDuration, snapped)) };
    }));
  }, [setShowClips, showDuration, snap]);

  const handleMoveClip = useCallback((id, newStart, dur) => {
    const snapped = snap(newStart);
    setShowClips(cs => cs.map(c => {
      if (c.id !== id) return c;
      const s = Math.max(0, Math.min(showDuration - dur, snapped));
      return { ...c, start: s, end: s + dur };
    }));
  }, [setShowClips, showDuration, snap]);

  const handleRandomizeClips = useCallback(() => {
    const allIds = PATTERNS.map(p => p.id);
    setShowClips(cs => cs.map(c => ({
      ...c,
      patternId: allIds[Math.floor(Math.random() * allIds.length)],
    })));
  }, [setShowClips]);

  const handleAutoFill = useCallback(() => {
    const FILL_PATTERNS = ['calm','aurora','bloom','ember','wave','drift','ocean','plasma','fire','lava'];
    const clipDur = Math.max(20, Math.round(showDuration / FILL_PATTERNS.length));
    const newClips = FILL_PATTERNS.map((pid, i) => ({
      id: `fill_${Date.now()}_${i}`,
      track: 0, patternId: pid, label: pid,
      start: i * clipDur,
      end: Math.min(showDuration, (i + 1) * clipDur),
    }));
    setShowClips(newClips);
    const transitions = [];
    for (let i = 0; i < newClips.length - 1; i++) {
      const a = newClips[i], b = newClips[i + 1];
      const dur = 4;
      transitions.push({
        id: `ftrans_${Date.now()}_${i}`, type: 'crossfade', curve: 'ease-in-out',
        start: a.end - dur / 2, end: b.start + dur / 2,
      });
    }
    setShowTransitions(transitions);
  }, [showDuration, setShowClips, setShowTransitions]);

  const handleRulerMouseDown = useCallback((e) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = scrollRef.current.getBoundingClientRect();
    const getT = (clientX) => Math.max(0, Math.min(showDuration,
      (clientX - rect.left + scrollRef.current.scrollLeft) / pxPerSec));
    const startT = getT(e.clientX);
    setLoopRegion({ start: startT, end: startT });
    const onMv = (me) => {
      const endT = getT(me.clientX);
      const [s, en] = startT <= endT ? [startT, endT] : [endT, startT];
      setLoopRegion({ start: s, end: Math.max(s + 0.5, en) });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMv);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMv);
    window.addEventListener('mouseup', onUp);
  }, [showDuration, pxPerSec]);

  const handleAddClip = useCallback((track = 0) => {
    const { patternId: suggestId } = resolveTimelinePlayback(timelinePlayhead, showClips, showTransitions);
    const id = `clip_${Date.now()}`;
    const newClip = {
      id, track,
      patternId: suggestId || 'aurora',
      start: timelinePlayhead,
      end: Math.min(showDuration, timelinePlayhead + 30),
      label: suggestId || 'aurora',
    };
    setShowClips(cs => [...cs, newClip]);
    setSelected({ kind: 'clip', id });
  }, [timelinePlayhead, showClips, showTransitions, showDuration, setShowClips]);

  const handleAddTransition = useCallback((clipId) => {
    const clip = showClips.find(c => c.id === clipId);
    if (!clip) return;
    const dur = Math.min(4, (clip.end - clip.start) * 0.2);
    const id = `trans_${Date.now()}`;
    setShowTransitions(ts => [...ts, {
      id, type: 'crossfade', curve: 'ease-in-out',
      start: clip.end - dur / 2,
      end: clip.end + dur / 2,
    }]);
  }, [showClips, setShowTransitions]);

  const handleSplitClip = useCallback((id) => {
    const clip = showClips.find(c => c.id === id);
    if (!clip || timelinePlayhead <= clip.start || timelinePlayhead >= clip.end) return;
    const newId = `clip_${Date.now()}`;
    setShowClips(cs => cs.flatMap(c => {
      if (c.id !== id) return [c];
      return [
        { ...c, end: timelinePlayhead },
        { ...c, id: newId, start: timelinePlayhead },
      ];
    }));
    setSelected({ kind: 'clip', id: newId });
  }, [showClips, timelinePlayhead, setShowClips]);

  const handleDuplicateClip = useCallback((id) => {
    const clip = showClips.find(c => c.id === id);
    if (!clip) return;
    const dur = clip.end - clip.start;
    const newId = `clip_${Date.now()}`;
    const newClip = { ...clip, id: newId, start: clip.end, end: Math.min(showDuration, clip.end + dur) };
    setShowClips(cs => [...cs, newClip]);
    setSelected({ kind: 'clip', id: newId });
  }, [showClips, showDuration, setShowClips]);

  const handleTapTempo = useCallback(() => {
    const now = performance.now();
    const times = tapTimesRef.current;
    // Reset if last tap was more than 3 seconds ago
    if (times.length > 0 && now - times[times.length - 1] > 3000) {
      tapTimesRef.current = [];
    }
    tapTimesRef.current = [...tapTimesRef.current, now].slice(-8);
    const t = tapTimesRef.current;
    if (t.length < 2) return;
    const intervals = t.slice(1).map((v, i) => v - t[i]);
    const avgMs = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const newBpm = Math.round(60000 / avgMs);
    if (newBpm >= 20 && newBpm <= 300) setBpm(newBpm);
  }, [setBpm]);

  const handlePlayheadClick = (e) => {
    if (!scrollRef.current) return;
    const rect = scrollRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollRef.current.scrollLeft;
    setTimelinePlayhead(Math.max(0, Math.min(showDuration, x / pxPerSec)));
  };

  return (
    <div className="lw-timeline-screen">
      <div className="lw-tl-top">
        <LiveTimelinePreview
          playhead={timelinePlayhead}
          clips={activeClips}
          transitions={showTransitions}
          duration={showDuration}
          strips={strips}
          viewBox={viewBox}
          svgText={svgText}
          hidden={hidden}
          bpm={bpm}
          wledPush={wledPush}
          masterSpeed={masterSpeed}
          masterBrightness={masterBrightness}
          masterSaturation={masterSaturation}
          masterHueShift={masterHueShift}
          gammaEnabled={gammaEnabled}
          gammaValue={gammaValue}
        />
        <TimelineInspector
          selectedClip={selectedClip}
          selectedTrans={selectedTrans}
          onExport={onExport}
          clips={showClips}
          onDeleteClip={(id) => { setShowClips(cs => cs.filter(c => c.id !== id)); setSelected({ kind: 'clip', id: null }); }}
          onDeleteTrans={(id) => { setShowTransitions(ts => ts.filter(t => t.id !== id)); setSelected({ kind: 'trans', id: null }); }}
          onDuplicateClip={handleDuplicateClip}
          onAddTransition={handleAddTransition}
          onSplitClip={handleSplitClip}
          multiSel={multiSel}
          onClearMultiSel={() => setMultiSel(new Set())}
        />
      </div>

      <div className="lw-tl-editor">
        <div className="lw-tl-headers">
          <div className="lw-tl-header ruler"><div className="lw-tl-track-label" style={{ opacity: 0 }}>ruler</div></div>
          <div className="lw-tl-header">
            <div className="lw-tl-track-label">
              <span className="pin" style={{ background: '#c84a8a' }}/><span>Master</span><span className="meta">Pattern A</span>
            </div>
            <div className="lw-tl-track-ctrls">
              <button className={mutedTracks.has(0) ? 'active' : ''}
                      title="Mute track"
                      onClick={() => setMutedTracks(s => { const n = new Set(s); n.has(0) ? n.delete(0) : n.add(0); return n; })}>
                M
              </button>
              <button className={soloTrack === 0 ? 'active' : ''}
                      title="Solo track"
                      onClick={() => setSoloTrack(t => t === 0 ? null : 0)}>
                S
              </button>
            </div>
          </div>
          <div className="lw-tl-header">
            <div className="lw-tl-track-label">
              <span className="pin" style={{ background: '#5fb8d9' }}/><span>Outer ring</span><span className="meta">Group · Pattern B</span>
            </div>
            <div className="lw-tl-track-ctrls">
              <button className={mutedTracks.has(1) ? 'active' : ''}
                      title="Mute track"
                      onClick={() => setMutedTracks(s => { const n = new Set(s); n.has(1) ? n.delete(1) : n.add(1); return n; })}>
                M
              </button>
              <button className={soloTrack === 1 ? 'active' : ''}
                      title="Solo track"
                      onClick={() => setSoloTrack(t => t === 1 ? null : 1)}>
                S
              </button>
            </div>
          </div>
          {autoLanes.map(lane => (
            <div key={lane.id} className="lw-tl-header auto" style={{ position: 'relative' }}>
              <div className="lw-tl-track-label">
                <span className="pin" style={{ background: lane.color }}/><span>{lane.label}</span><span className="meta">automation</span>
              </div>
              <button
                style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                         background: 'none', border: 'none', color: 'var(--text-4)',
                         cursor: 'pointer', fontSize: 'var(--fs-sm)', padding: '2px 4px' }}
                title="Remove lane"
                onClick={() => setAutoLanes(ls => ls.filter(l => l.id !== lane.id))}>×</button>
            </div>
          ))}
          <button
            className="btn btn-ghost"
            style={{ margin: '2px 4px', fontSize: 'var(--fs-xs)', width: 'calc(100% - 8px)' }}
            onClick={() => {
              const colors = ['#e84ac8','#3ae84a','#e8a03a','#4ac8c8','#8a8ad9'];
              const params = ['hueShift','speed','brightness','saturation','size'];
              const i = autoLanes.length % colors.length;
              setAutoLanes(ls => [...ls, {
                id: `auto_${Date.now()}`, label: params[i], color: colors[i],
                param: params[i], keys: [[0, 0.5], [showDuration, 0.5]],
              }]);
            }}>
            + Lane
          </button>
          <div className="lw-tl-header audio">
            <div className="lw-tl-track-label">
              <span className="pin" style={{ background: '#8a9aa8' }}/><span>Audio</span><span className="meta">journey.wav</span>
            </div>
            <div className="lw-tl-track-ctrls"><button>M</button></div>
          </div>
        </div>

        <div className="lw-tl-scroll" ref={scrollRef} onClick={handlePlayheadClick}
             onWheel={e => {
               if (e.ctrlKey || e.metaKey) {
                 e.preventDefault();
                 setZoom(z => Math.max(0.5, Math.min(4, z * (e.deltaY < 0 ? 1.1 : 0.9))));
               }
             }}>
          <div className="lw-tl-lanes" style={{ width: totalWidth }}>
            <Ruler width={totalWidth} pxPerSec={pxPerSec} cues={showCues} duration={showDuration}
                   loopRegion={loopRegion} onMouseDown={handleRulerMouseDown}
                   onContextMenu={e => {
                     e.preventDefault();
                     const rect = scrollRef.current.getBoundingClientRect();
                     const t = Math.max(0, Math.min(showDuration, (e.clientX - rect.left + scrollRef.current.scrollLeft) / pxPerSec));
                     setShowCues(cs => [...cs, { t: Math.round(t), name: `Cue ${cs.length + 1}`, kbd: `Q${cs.length + 1}` }]);
                   }}/>
            {/* Track 0 */}
            <div className="lw-tl-lane track"
                 style={{ opacity: (soloTrack !== null && soloTrack !== 0) || mutedTracks.has(0) ? 0.3 : 1 }}>
              {showClips.filter(c => c.track === 0).map(c => (
                <Clip key={c.id} clip={c} pxPerSec={pxPerSec}
                      selected={selected.kind === 'clip' && selected.id === c.id}
                      multiSelected={multiSel.has(c.id)}
                      onSelect={e => {
                        if (e.shiftKey) {
                          setMultiSel(s => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; });
                        } else {
                          setMultiSel(new Set());
                          setSelected({ kind: 'clip', id: c.id });
                        }
                      }}
                      onResize={handleResizeClip}
                      onMove={handleMoveClip}/>
              ))}
              {showTransitions.map(t => (
                <TransitionZone key={t.id} trans={t} pxPerSec={pxPerSec}
                                selected={selected.kind === 'trans' && selected.id === t.id}
                                onSelect={() => setSelected({ kind: 'trans', id: t.id })}/>
              ))}
            </div>
            {/* Track 1 */}
            <div className="lw-tl-lane track"
                 style={{ opacity: (soloTrack !== null && soloTrack !== 1) || mutedTracks.has(1) ? 0.3 : 1 }}>
              {showClips.filter(c => c.track === 1).map(c => (
                <Clip key={c.id} clip={c} pxPerSec={pxPerSec}
                      selected={selected.kind === 'clip' && selected.id === c.id}
                      multiSelected={multiSel.has(c.id)}
                      onSelect={e => {
                        if (e.shiftKey) {
                          setMultiSel(s => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; });
                        } else {
                          setMultiSel(new Set());
                          setSelected({ kind: 'clip', id: c.id });
                        }
                      }}
                      onResize={handleResizeClip}
                      onMove={handleMoveClip}/>
              ))}
            </div>
            {autoLanes.map(lane => (
              <AutomationLane key={lane.id} lane={lane} width={totalWidth} duration={showDuration}
                              onSetLane={(id, keys) => setAutoLanes(ls => ls.map(l => l.id === id ? { ...l, keys } : l))}/>
            ))}
            <AudioLane width={totalWidth}/>
            <div className="lw-tl-playhead" style={{ left: timelinePlayhead * pxPerSec }}>
              <div className="head"/>
            </div>
          </div>
        </div>
      </div>

      {/* ── Minimap ── */}
      <div style={{ height: 20, background: 'var(--bg)', borderTop: '1px solid var(--border)', position: 'relative', flexShrink: 0, cursor: 'pointer' }}
           onClick={e => {
             const rect = e.currentTarget.getBoundingClientRect();
             const t = (e.clientX - rect.left) / rect.width * showDuration;
             setTimelinePlayhead(Math.max(0, Math.min(showDuration, t)));
           }}>
        <svg width="100%" height="20" style={{ display: 'block' }} preserveAspectRatio="none"
             viewBox={`0 0 ${showDuration} 20`}>
          {showClips.map(c => (
            <rect key={c.id} x={c.start} y={c.track === 1 ? 10 : 2} width={Math.max(0.5, c.end - c.start)}
                  height={8} rx="1" fill={c.color || CLIP_COLORS[c.patternId] || '#888'} opacity="0.7"/>
          ))}
          {showTransitions.map(t => (
            <rect key={t.id} x={t.start} y={0} width={Math.max(0.5, t.end - t.start)} height={20}
                  fill="var(--accent)" opacity="0.2"/>
          ))}
          {showCues.map((c, i) => (
            <line key={i} x1={c.t} y1={0} x2={c.t} y2={20} stroke="var(--accent)" strokeWidth="0.5" opacity="0.8"/>
          ))}
          {loopRegion && (
            <rect x={loopRegion.start} y={0} width={loopRegion.end - loopRegion.start} height={20}
                  fill="var(--accent)" opacity="0.1"/>
          )}
          <line x1={timelinePlayhead} y1={0} x2={timelinePlayhead} y2={20}
                stroke="var(--accent)" strokeWidth="1" opacity="0.9"/>
        </svg>
      </div>

      <div className="lw-tl-transport">
        <div className="lw-tl-transport-left">
          <button className="lw-tl-tbtn" onClick={() => { setTimelinePlayhead(0); setTimelinePlaying(false); }}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><rect x="1" y="1.5" width="1.5" height="8"/><path d="M10 1.5 L4 5.5 L10 9.5 Z"/></svg>
          </button>
          <button className={`lw-tl-tbtn play ${timelinePlaying ? 'stop' : ''}`}
                  onClick={() => setTimelinePlaying(p => !p)}>
            {timelinePlaying
              ? <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect width="3.5" height="10"/><rect x="6.5" width="3.5" height="10"/></svg>
              : <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M1 0 L10 5 L1 10 Z"/></svg>}
            <span>{timelinePlaying ? 'Stop' : 'Play'}</span>
          </button>

          <button
            className={`lw-tl-tbtn rec ${liveRecording ? 'armed' : ''}`}
            onClick={() => setLiveRecording(r => !r)}
            title="Arm clip recording — switch to Live screen and tap patterns to stamp"
          >
            <span className="dot" style={{ background: liveRecording ? 'var(--danger)' : 'currentColor' }}/>
            <span>Rec</span>
          </button>

          {liveRecording && (
            <select
              className="lw-tl-quantize-sel"
              value={liveQuantize}
              onChange={e => setLiveQuantize(e.target.value)}
              title="Quantize clip stamps"
            >
              <option value="free">Free</option>
              <option value="beat">Beat</option>
              <option value="bar">Bar</option>
            </select>
          )}

          <button className={`lw-tl-tbtn ${loopEnabled ? 'active' : ''}`}
                  onClick={() => setLoopEnabled(l => !l)}
                  title="Loop playback · Shift+drag ruler to set region · L to clear region">
            <svg width="11" height="10" viewBox="0 0 11 10" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 4a3 3 0 013-3h3l-1.5-1M9 6a3 3 0 01-3 3H3l1.5 1"/></svg>
            <span>Loop</span>
            {loopRegion && <span style={{ fontSize: 'var(--fs-2xs)', opacity: 0.7, marginLeft: 2 }}>●</span>}
          </button>
          <button className="lw-tl-tbtn" onClick={() => handleAddClip(0)} title="Add clip at playhead">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3"><line x1="5" y1="1" x2="5" y2="9"/><line x1="1" y1="5" x2="9" y2="5"/></svg>
            <span>Clip</span>
          </button>
          <button className={`lw-tl-tbtn ${snapEnabled ? 'active' : ''}`}
                  onClick={() => setSnapEnabled(s => !s)}
                  title="Snap to beat grid">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <line x1="2" y1="1" x2="2" y2="9"/><line x1="5" y1="1" x2="5" y2="9"/><line x1="8" y1="1" x2="8" y2="9"/>
              <line x1="1" y1="5" x2="4" y2="5" strokeDasharray="1 1"/>
            </svg>
            <span>Snap</span>
          </button>
          <button className="lw-tl-tbtn"
                  onClick={() => handleRandomizeClips()}
                  title="Randomize pattern assignment for all clips">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M1 3h5.5a1.5 1.5 0 010 3H3.5a1.5 1.5 0 000 3H9M7 1l2 2-2 2M7 7l2 2-2 2"/>
            </svg>
            <span>Rnd</span>
          </button>
          <button className="lw-tl-tbtn"
                  onClick={() => {
                    if (window.confirm('Replace all clips with an auto-generated sequence?')) handleAutoFill();
                  }}
                  title="Auto-fill timeline with pattern sequence">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="1" y="3" width="3" height="4"/><rect x="5" y="1" width="3" height="8"/>
              <path d="M4 9 L6 9" strokeDasharray="1 1"/>
            </svg>
            <span>Fill</span>
          </button>
          <button className="lw-tl-tbtn"
                  title="Trim show duration to last clip end"
                  onClick={() => {
                    if (showClips.length === 0) return;
                    const lastEnd = Math.max(...showClips.map(c => c.end));
                    if (lastEnd > 0) setShowDuration(Math.ceil(lastEnd) + 5);
                  }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M1 2 L6 5 L1 8"/><line x1="7" y1="2" x2="7" y2="8"/>
            </svg>
            <span>Trim</span>
          </button>
          <button className="lw-tl-tbtn"
                  onClick={() => setShowCues(cs => [...cs, {
                    t: Math.round(timelinePlayhead),
                    name: `Cue ${cs.length + 1}`,
                    kbd: `Q${cs.length + 1}`,
                  }])}
                  title="Add cue at playhead (right-click ruler to add at position)">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <polygon points="5,2 3,8 7,8"/><line x1="5" y1="2" x2="5" y2="0"/>
            </svg>
            <span>Cue</span>
          </button>
          <button className="lw-tl-tbtn"
                  onClick={() => {
                    if (!bpm) return;
                    const beatSecs = 60 / bpm;
                    const barSecs = beatSecs * 4;
                    const newCues = [];
                    for (let t = 0; t < showDuration; t += barSecs * 4) {
                      newCues.push({ t: Math.round(t), name: `Bar ${Math.round(t / barSecs) + 1}`, kbd: `Q${newCues.length + 1}` });
                    }
                    if (window.confirm(`Auto-generate ${newCues.length} cues at every 4-bar boundary?`)) {
                      setShowCues(newCues.slice(0, 9));
                    }
                  }}
                  title="Auto-generate cues every 4 bars from BPM">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
              <polygon points="2,2 2,8 6,8"/><polygon points="5,2 5,8 9,8"/>
            </svg>
            <span>Auto</span>
          </button>
        </div>

        <div className="lw-tl-timecode">
          <div className="big">{fmt(timelinePlayhead)}</div>
          <div className="meta">
            <span><em>of</em> {fmt(showDuration)}</span>
            <span className="sep">·</span>
            <span style={{ cursor: 'pointer', userSelect: 'none' }}
                  title="Tap to set BPM"
                  onClick={handleTapTempo}>
              <em>BPM</em> {bpm}
            </span>
            {loopEnabled && loopRegion && (
              <><span className="sep">·</span>
              <span style={{ color: 'var(--accent)', fontSize: 'var(--fs-xs)' }}>
                ↺ {fmt(loopRegion.start)}–{fmt(loopRegion.end)}
              </span></>
            )}
            {strips?.length > 0 && (
              <><span className="sep">·</span>
              <span style={{ color: 'var(--text-4)', fontSize: 'var(--fs-xs)' }}>
                {strips.reduce((s, st) => s + (st.pixels?.length || 0), 0)} LEDs
              </span></>
            )}
            {liveRecording && <><span className="sep">·</span><span style={{color:'var(--danger)'}}>● REC ARMED</span></>}
          </div>
        </div>

        <div className="lw-tl-transport-right">
          <div className="lw-tl-cues">
            {showCues.map((c, i) => (
              <button key={i}
                      className={`lw-tl-cue-btn ${Math.abs(timelinePlayhead - c.t) < 2 ? 'active' : ''}`}
                      onClick={() => setTimelinePlayhead(c.t)}>
                <span className="kbd">{c.kbd}</span>
                <span className="name">{c.name}</span>
              </button>
            ))}
          </div>
          <div className="lw-tl-zoom">
            <span>Speed</span>
            <div className="lw-tweaks-seg" style={{ fontSize: 'var(--fs-2xs)' }}>
              {[0.25, 0.5, 1, 2].map(r => (
                <button key={r}
                        className={Math.abs(playRate - r) < 0.01 ? 'active' : ''}
                        onClick={() => setPlayRate(r)}>
                  {r}×
                </button>
              ))}
            </div>
          </div>
          <div className="lw-tl-zoom">
            <span>Zoom</span>
            <input type="range" min="0.5" max="4" step="0.1" value={zoom}
                   onChange={e => setZoom(+e.target.value)}/>
            <span className="v">{zoom.toFixed(1)}×</span>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '2px 5px' }}
                    title="Fit all clips into view"
                    onClick={() => {
                      if (!scrollRef.current) return;
                      const viewW = scrollRef.current.clientWidth;
                      const fitZoom = Math.max(0.5, Math.min(4, viewW / showDuration));
                      setZoom(fitZoom);
                    }}>
              Fit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
