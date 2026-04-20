import { useState, useRef, useEffect } from 'react';

const SHOW_DURATION = 600;

const CLIP_COLORS = {
  aurora: '#5fb8d9', ember: '#e89a3a', bloom: '#c84a8a',
  wave: '#3a6ac8', pulse: '#c84a3a', drift: '#8a4ac8',
  calm: '#3a8a6a', strobe: '#d9a84a',
};

const SHOW_CLIPS = [
  { id: 'c1', track: 0, patternId: 'calm',   start: 0,   end: 95,  label: 'Calm open' },
  { id: 'c2', track: 0, patternId: 'aurora',  start: 90,  end: 240, label: 'Aurora drift' },
  { id: 'c3', track: 0, patternId: 'bloom',   start: 235, end: 360, label: 'Bloom build' },
  { id: 'c4', track: 0, patternId: 'ember',   start: 355, end: 480, label: 'Ember pulse' },
  { id: 'c5', track: 0, patternId: 'wave',    start: 475, end: 600, label: 'Wave out' },
  { id: 'c6', track: 1, patternId: 'drift',   start: 120, end: 260, label: 'Outer drift', group: 'Outer ring' },
  { id: 'c7', track: 1, patternId: 'pulse',   start: 260, end: 420, label: 'Outer pulse', group: 'Outer ring' },
];

const TRANSITIONS = [
  { id: 't1', clipA: 'c1', clipB: 'c2', start: 90,  end: 95,  type: 'crossfade' },
  { id: 't2', clipA: 'c2', clipB: 'c3', start: 235, end: 240, type: 'fade-black' },
  { id: 't3', clipA: 'c3', clipB: 'c4', start: 355, end: 360, type: 'dissolve' },
  { id: 't4', clipA: 'c4', clipB: 'c5', start: 475, end: 480, type: 'crossfade' },
];

const AUTO_LANES = [
  { id: 'a1', label: 'Hue shift', color: '#c84a8a', keys: [[0,0.1],[60,0.2],[140,0.5],[240,0.75],[360,0.4],[480,0.9],[600,0.1]] },
  { id: 'a2', label: 'Speed',     color: '#5fb8d9', keys: [[0,0.3],[120,0.35],[240,0.5],[360,0.8],[480,0.9],[540,0.5],[600,0.25]] },
  { id: 'a3', label: 'Brightness',color: '#e89a3a', keys: [[0,0.2],[95,0.6],[240,0.75],[360,0.95],[480,0.85],[600,0.25]] },
];

const CUES = [
  { t: 0,   name: 'Start',     kbd: 'Q1' },
  { t: 95,  name: 'Drop 1',    kbd: 'Q2' },
  { t: 240, name: 'Bloom',     kbd: 'Q3' },
  { t: 360, name: 'Climax',    kbd: 'Q4' },
  { t: 480, name: 'Wind down', kbd: 'Q5' },
  { t: 600, name: 'End',       kbd: 'Q6' },
];

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

function fmt(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 100);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(2,'0')}`;
}

function lanePath(keys, width, height) {
  return keys.map(([t, v], i) => {
    const x = (t / SHOW_DURATION) * width;
    const y = height - v * height;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function Ruler({ width, pxPerSec, cues }) {
  const ticks = [];
  const step = pxPerSec >= 2 ? 30 : pxPerSec >= 1 ? 60 : 120;
  for (let t = 0; t <= SHOW_DURATION; t += step) {
    ticks.push(t);
  }
  return (
    <div className="lw-tl-lane ruler">
      <svg width={width} height={28} style={{ display: 'block' }}>
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

function TrackLane({ children }) {
  return <div className="lw-tl-lane track">{children}</div>;
}

function Clip({ clip, pxPerSec, selected, onSelect }) {
  const left = clip.start * pxPerSec;
  const width = (clip.end - clip.start) * pxPerSec;
  const color = CLIP_COLORS[clip.patternId] || '#888';
  return (
    <div className={`lw-tl-clip ${selected ? 'selected' : ''}`}
         style={{ left, width, '--clip-color': color }}
         onClick={onSelect}>
      <div className="clip-bg"/>
      <div className="clip-sparkle"/>
      <div className="clip-label">
        <span className="dot" style={{ background: color }}/>
        <span className="name">{clip.label}</span>
      </div>
      <div className="clip-meta">
        <span>{clip.patternId}</span>
        <span className="sep">·</span>
        <span>{(clip.end - clip.start).toFixed(0)}s</span>
        {clip.group && <><span className="sep">·</span><span>{clip.group}</span></>}
      </div>
      <div className="clip-handle left"/>
      <div className="clip-handle right"/>
    </div>
  );
}

function TransitionZone({ trans, pxPerSec, selected, onSelect }) {
  const left = trans.start * pxPerSec;
  const width = (trans.end - trans.start) * pxPerSec;
  const icon = { 'crossfade': '⤫', 'fade-black': '◐', 'fade-white': '◑', 'dissolve': '▦', 'wipe': '▶' }[trans.type] || '⤫';
  return (
    <div className={`lw-tl-trans ${selected ? 'selected' : ''}`}
         style={{ left, width }}
         onClick={e => { e.stopPropagation(); onSelect(); }}
         title={trans.type}>
      <div className="trans-glyph">{icon}</div>
    </div>
  );
}

function AutomationLane({ lane, width }) {
  const height = 44;
  return (
    <div className="lw-tl-lane auto">
      <svg width={width} height={height} style={{ display: 'block' }}>
        <defs>
          <linearGradient id={`grad-${lane.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={lane.color} stopOpacity="0.35"/>
            <stop offset="1" stopColor={lane.color} stopOpacity="0"/>
          </linearGradient>
        </defs>
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="var(--border)" strokeWidth="1"/>
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="var(--border)" strokeWidth="0.5" strokeDasharray="2 3"/>
        <path d={`${lanePath(lane.keys, width, height)} L${width},${height} L0,${height} Z`}
              fill={`url(#grad-${lane.id})`}/>
        <path d={lanePath(lane.keys, width, height)} fill="none" stroke={lane.color} strokeWidth="1.5" strokeLinejoin="round"/>
        {lane.keys.map(([t, v], i) => {
          const x = (t / SHOW_DURATION) * width;
          const y = height - v * height;
          return <rect key={i} x={x - 2.5} y={y - 2.5} width="5" height="5"
                       fill="var(--surface)" stroke={lane.color} strokeWidth="1.2"
                       transform={`rotate(45 ${x} ${y})`}/>;
        })}
      </svg>
    </div>
  );
}

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

function TimelinePreview({ playhead, clips, transitions }) {
  const activeClips = clips.filter(c => playhead >= c.start && playhead <= c.end && c.track === 0);
  const trans = transitions.find(t => playhead >= t.start && playhead <= t.end);
  const blend = trans ? (playhead - trans.start) / (trans.end - trans.start) : 0;
  const primary = activeClips[0];

  return (
    <div className="lw-tl-preview">
      <div className="lw-tl-preview-header">
        <span className="label">PREVIEW</span>
        <span className="sep">·</span>
        <span>{fmt(playhead)}</span>
        <span className="sep">·</span>
        <span>{primary?.label || '—'}</span>
        {trans && (
          <><span className="sep">·</span><span className="trans-badge">{trans.type} {Math.round(blend * 100)}%</span></>
        )}
      </div>
      <div className="lw-tl-preview-stage">
        {primary && (
          <div className="swatch a" style={{
            background: `radial-gradient(circle at 30% 40%, ${CLIP_COLORS[primary.patternId]}dd, #000 70%)`,
            opacity: trans ? (1 - blend) : 1,
          }}/>
        )}
        {trans && trans.type === 'fade-black' && (
          <div className="swatch" style={{ background: '#000', opacity: Math.sin(blend * Math.PI) * 0.85 }}/>
        )}
        {trans && (trans.type === 'crossfade' || trans.type === 'dissolve') && (() => {
          const nextClip = clips.find(c => c.id === trans.clipB);
          if (!nextClip) return null;
          return (
            <div className="swatch b" style={{
              background: `radial-gradient(circle at 70% 60%, ${CLIP_COLORS[nextClip.patternId]}dd, #000 70%)`,
              opacity: blend,
              mixBlendMode: trans.type === 'dissolve' ? 'screen' : 'normal',
            }}/>
          );
        })()}
        <div className="lw-tl-preview-leds">
          {Array.from({ length: 48 }).map((_, i) => {
            const phase = (i / 48 + playhead * 0.08) % 1;
            const bright = 0.4 + 0.6 * Math.sin(phase * Math.PI * 2);
            return <span key={i} style={{ opacity: bright }}/>;
          })}
        </div>
        <div className="lw-tl-preview-vignette"/>
      </div>
    </div>
  );
}

function TimelineInspector({ selectedClip, selectedTrans, onExport }) {
  return (
    <div className="lw-tl-inspector">
      <div className="lw-tl-inspector-tabs">
        <button className={`tab ${selectedClip ? 'active' : ''}`}>Clip</button>
        <button className={`tab ${selectedTrans ? 'active' : ''}`}>Transition</button>
        <button className="tab">Show</button>
      </div>
      <div className="lw-tl-inspector-body">
        {selectedClip && (
          <>
            <div className="lw-insp-header">
              <span className="dot" style={{ background: CLIP_COLORS[selectedClip.patternId] }}/>
              <h3>{selectedClip.label}</h3>
              <span className="kbd">C</span>
            </div>
            <div className="lw-insp-row"><span className="k">Pattern</span>
              <select className="lw-insp-select" defaultValue={selectedClip.patternId}>
                {Object.keys(CLIP_COLORS).map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div className="lw-insp-row"><span className="k">Target</span><span className="v">{selectedClip.group || 'All groups'}</span></div>
            <div className="lw-insp-row"><span className="k">Start</span><span className="v mono">{fmt(selectedClip.start)}</span></div>
            <div className="lw-insp-row"><span className="k">End</span><span className="v mono">{fmt(selectedClip.end)}</span></div>
            <div className="lw-insp-row"><span className="k">Length</span><span className="v mono">{fmt(selectedClip.end - selectedClip.start)}</span></div>
            <div className="lw-insp-divider"/>
            <div className="lw-insp-section">Live knobs (snapshot)</div>
            <div className="lw-insp-knob"><span>Intensity</span><input type="range" defaultValue="72"/><span className="v">0.72</span></div>
            <div className="lw-insp-knob"><span>Hue offset</span><input type="range" defaultValue="18"/><span className="v">+18°</span></div>
            <div className="lw-insp-knob"><span>Glow</span><input type="range" defaultValue="60"/><span className="v">1.8×</span></div>
            <div className="lw-insp-divider"/>
            <div className="lw-insp-section">Envelope</div>
            <div className="lw-insp-env">
              <svg viewBox="0 0 100 30" preserveAspectRatio="none">
                <path d="M0 30 L8 4 L92 4 L100 30" fill="none" stroke="var(--accent)" strokeWidth="1.2"/>
                <path d="M0 30 L8 4 L92 4 L100 30 Z" fill="var(--accent)" fillOpacity="0.15"/>
              </svg>
              <div className="lw-insp-env-labels"><span>in 2.8s</span><span>hold 120s</span><span>out 2.8s</span></div>
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
              <select className="lw-insp-select" defaultValue={selectedTrans.type}>
                <option>crossfade</option><option>dissolve</option>
                <option>fade-black</option><option>fade-white</option><option>wipe</option>
              </select>
            </div>
            <div className="lw-insp-row"><span className="k">Duration</span>
              <span className="v mono">{(selectedTrans.end - selectedTrans.start).toFixed(1)}s</span>
            </div>
            <div className="lw-insp-divider"/>
            <div className="lw-insp-section">Curve</div>
            <div className="lw-insp-curves">
              {['linear','ease-in-out','s-curve','exp'].map((e, i) => (
                <button key={i} className={`curve-btn ${e === 'ease-in-out' ? 'active' : ''}`}>
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
            <div className="lw-insp-divider"/>
            <div className="lw-insp-section">Per-group fade</div>
            {['Inner petals','Outer ring','Base + dia.'].map((g, i) => (
              <div key={g} className="lw-insp-row">
                <span className="k">{g}</span>
                <div className="lw-insp-offset">
                  <input type="range" min="-2" max="2" step="0.1" defaultValue={[0, 0.4, -0.2][i]}/>
                  <span className="v mono">{[0, 0.4, -0.2][i] > 0 ? '+' : ''}{[0, 0.4, -0.2][i].toFixed(1)}s</span>
                </div>
              </div>
            ))}
          </>
        )}
        <div className="lw-insp-divider" style={{ marginTop: 'auto' }}/>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} onClick={onExport}>
          Export Show →
        </button>
      </div>
    </div>
  );
}

export function TimelineScreen({ onExport }) {
  const [zoom, setZoom] = useState(1.2);
  const [playhead, setPlayhead] = useState(52);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState({ kind: 'clip', id: 'c2' });
  const [loopEnabled, setLoopEnabled] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now(), raf;
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      setPlayhead(p => { const next = p + dt; return next >= SHOW_DURATION ? 0 : next; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const pxPerSec = zoom;
  const totalWidth = SHOW_DURATION * pxPerSec;
  const selectedClip = selected.kind === 'clip' ? SHOW_CLIPS.find(c => c.id === selected.id) : null;
  const selectedTrans = selected.kind === 'trans' ? TRANSITIONS.find(t => t.id === selected.id) : null;

  return (
    <div className="lw-timeline-screen">
      <div className="lw-tl-top">
        <TimelinePreview playhead={playhead} clips={SHOW_CLIPS} transitions={TRANSITIONS}/>
        <TimelineInspector selectedClip={selectedClip} selectedTrans={selectedTrans} onExport={onExport}/>
      </div>

      <div className="lw-tl-editor">
        <div className="lw-tl-headers">
          <div className="lw-tl-header ruler"><div className="lw-tl-track-label" style={{ opacity: 0 }}>ruler</div></div>
          <div className="lw-tl-header">
            <div className="lw-tl-track-label">
              <span className="pin" style={{ background: '#c84a8a' }}/><span>Master</span><span className="meta">Pattern A</span>
            </div>
            <div className="lw-tl-track-ctrls"><button>M</button><button>S</button><button>
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="4" width="6" height="4.5" rx="0.5"/><path d="M3 4V2.5a1.5 1.5 0 013 0V4"/></svg>
            </button></div>
          </div>
          <div className="lw-tl-header">
            <div className="lw-tl-track-label">
              <span className="pin" style={{ background: '#5fb8d9' }}/><span>Outer ring</span><span className="meta">Group · Pattern B</span>
            </div>
            <div className="lw-tl-track-ctrls"><button>M</button><button>S</button><button>
              <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="4" width="6" height="4.5" rx="0.5"/><path d="M3 4V2.5a1.5 1.5 0 013 0V4"/></svg>
            </button></div>
          </div>
          {AUTO_LANES.map(lane => (
            <div key={lane.id} className="lw-tl-header auto">
              <div className="lw-tl-track-label">
                <span className="pin" style={{ background: lane.color }}/><span>{lane.label}</span><span className="meta">automation</span>
              </div>
              <div className="lw-tl-track-ctrls"><button title="curve">
                <svg width="11" height="9" viewBox="0 0 11 9" fill="none" stroke="currentColor" strokeWidth="1.1"><path d="M1 7.5 Q3 7, 4 4 T 10 1.5"/></svg>
              </button></div>
            </div>
          ))}
          <div className="lw-tl-header audio">
            <div className="lw-tl-track-label">
              <span className="pin" style={{ background: '#8a9aa8' }}/><span>Audio</span><span className="meta">journey.wav · 10:00</span>
            </div>
            <div className="lw-tl-track-ctrls"><button>M</button></div>
          </div>
        </div>

        <div className="lw-tl-scroll" ref={scrollRef}>
          <div className="lw-tl-lanes" style={{ width: totalWidth }}>
            <Ruler width={totalWidth} pxPerSec={pxPerSec} cues={CUES}/>
            <TrackLane>
              {SHOW_CLIPS.filter(c => c.track === 0).map(c => (
                <Clip key={c.id} clip={c} pxPerSec={pxPerSec}
                      selected={selected.kind === 'clip' && selected.id === c.id}
                      onSelect={() => setSelected({ kind: 'clip', id: c.id })}/>
              ))}
              {TRANSITIONS.map(t => (
                <TransitionZone key={t.id} trans={t} pxPerSec={pxPerSec}
                                selected={selected.kind === 'trans' && selected.id === t.id}
                                onSelect={() => setSelected({ kind: 'trans', id: t.id })}/>
              ))}
            </TrackLane>
            <TrackLane>
              {SHOW_CLIPS.filter(c => c.track === 1).map(c => (
                <Clip key={c.id} clip={c} pxPerSec={pxPerSec}
                      selected={selected.kind === 'clip' && selected.id === c.id}
                      onSelect={() => setSelected({ kind: 'clip', id: c.id })}/>
              ))}
            </TrackLane>
            {AUTO_LANES.map(lane => <AutomationLane key={lane.id} lane={lane} width={totalWidth}/>)}
            <AudioLane width={totalWidth}/>
            <div className="lw-tl-playhead" style={{ left: playhead * pxPerSec }}><div className="head"/></div>
          </div>
        </div>
      </div>

      <div className="lw-tl-transport">
        <div className="lw-tl-transport-left">
          <button className="lw-tl-tbtn" onClick={() => setPlayhead(0)}>
            <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor"><rect x="1" y="1.5" width="1.5" height="8"/><path d="M10 1.5 L4 5.5 L10 9.5 Z"/></svg>
          </button>
          <button className={`lw-tl-tbtn play ${playing ? 'stop' : ''}`} onClick={() => setPlaying(!playing)}>
            {playing
              ? <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect width="3.5" height="10"/><rect x="6.5" width="3.5" height="10"/></svg>
              : <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M1 0 L10 5 L1 10 Z"/></svg>}
            <span>{playing ? 'Stop' : 'Play'}</span>
          </button>
          <button className="lw-tl-tbtn rec"><span className="dot"/><span>Rec</span></button>
          <button className={`lw-tl-tbtn ${loopEnabled ? 'active' : ''}`} onClick={() => setLoopEnabled(l => !l)}>
            <svg width="11" height="10" viewBox="0 0 11 10" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 4a3 3 0 013-3h3l-1.5-1M9 6a3 3 0 01-3 3H3l1.5 1"/></svg>
            <span>Loop</span>
          </button>
        </div>

        <div className="lw-tl-timecode">
          <div className="big">{fmt(playhead)}</div>
          <div className="meta">
            <span><em>of</em> {fmt(SHOW_DURATION)}</span>
            <span className="sep">·</span><span><em>FPS</em> 44</span>
            <span className="sep">·</span><span><em>BPM</em> 118</span>
            <span className="sep">·</span><span><em>UNI</em> 4</span>
          </div>
        </div>

        <div className="lw-tl-transport-right">
          <div className="lw-tl-cues">
            {CUES.map((c, i) => (
              <button key={i} className={`lw-tl-cue-btn ${Math.abs(playhead - c.t) < 2 ? 'active' : ''}`}
                      onClick={() => setPlayhead(c.t)}>
                <span className="kbd">{c.kbd}</span>
                <span className="name">{c.name}</span>
              </button>
            ))}
          </div>
          <div className="lw-tl-zoom">
            <span>Zoom</span>
            <input type="range" min="0.5" max="4" step="0.1" value={zoom} onChange={e => setZoom(+e.target.value)}/>
            <span className="v">{zoom.toFixed(1)}×</span>
          </div>
        </div>
      </div>
    </div>
  );
}
