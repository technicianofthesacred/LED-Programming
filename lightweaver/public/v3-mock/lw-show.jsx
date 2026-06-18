/* global React, window */
/* Light Weaver v3 — Show (timeline) screen */
(function () {
  const { useState, useEffect, useRef } = React;
  const { I, PATTERNS, CLIP_COLOR, CLIPS, TRANSITIONS, LANES, CUES, SHOW_DURATION, fmtTime } = window.LW;

  const PPS = 1.5;            // px per second
  const HEAD = 132;          // left head column width
  const LANE_W = SHOW_DURATION * PPS;
  const cc = (id) => CLIP_COLOR[id] || "var(--text-lo)";

  const TRACKS = [
    { n: 0, name: "Full piece", meta: "all sections" },
    { n: 1, name: "Outer ring", meta: "layer 2 · 3" },
  ];

  function lanePath(keys, w, h) {
    return keys.map(([t, v], i) => `${i ? "L" : "M"}${((t / SHOW_DURATION) * w).toFixed(1)} ${((1 - v) * h).toFixed(1)}`).join(" ");
  }

  function AutoLane({ lane }) {
    const h = 48;
    const d = lanePath(lane.keys, LANE_W, h);
    return (
      <div className="tl-row">
        <div className="tl-head"><span className="tn" style={{ fontSize: 11 }}>{lane.label}</span></div>
        <div className="tl-lane auto-lane" style={{ height: h }}>
          <svg viewBox={`0 0 ${LANE_W} ${h}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id={`g-${lane.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={lane.color} stopOpacity="0.30" />
                <stop offset="1" stopColor={lane.color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={`${d} L${LANE_W} ${h} L0 ${h} Z`} fill={`url(#g-${lane.id})`} />
            <path d={d} fill="none" stroke={lane.color} strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {lane.keys.map(([t, v], i) => (
              <circle key={i} cx={(t / SHOW_DURATION) * LANE_W} cy={(1 - v) * h} r="3" fill="var(--bg-panel)" stroke={lane.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            ))}
          </svg>
        </div>
      </div>
    );
  }

  function ShowScreen() {
    const [playing, setPlaying] = useState(false);
    const [loop, setLoop] = useState(true);
    const [snap, setSnap] = useState(true);
    const [bpm] = useState(120);
    const [t, setT] = useState(92);
    const [selId, setSelId] = useState("c2");
    const [tab, setTab] = useState("clip");
    const [muted, setMuted] = useState(() => new Set());
    const [solo, setSolo] = useState(null);
    const raf = useRef(0);
    const last = useRef(0);

    useEffect(() => {
      if (!playing) return;
      last.current = performance.now();
      const step = (now) => {
        const dt = (now - last.current) / 1000; last.current = now;
        setT((p) => {
          let n = p + dt;
          if (n >= SHOW_DURATION) n = loop ? 0 : SHOW_DURATION;
          if (n >= SHOW_DURATION && !loop) setPlaying(false);
          return n;
        });
        raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf.current);
    }, [playing, loop]);

    const sel = CLIPS.find((c) => c.id === selId);
    const toggleMute = (n) => setMuted((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });

    return (
      <div className="screen">
        <div className="sh">
          {/* transport */}
          <div className="transport">
            <div className="tp-btns">
              <button className="tp-btn" title="Back to start" onClick={() => setT(0)}>{I.toStart}</button>
              <button className="tp-btn play" onClick={() => setPlaying((p) => !p)}>{playing ? I.pause : I.play}</button>
              <button className={"tp-btn" + (loop ? " on" : "")} title="Loop" onClick={() => setLoop((l) => !l)}>{I.loop}</button>
            </div>
            <div className="tp-time">{fmtTime(t)}<span className="d"> / {fmtTime(SHOW_DURATION)}</span></div>
            <div className="tp-field">BPM <span className="val">{bpm}</span></div>
            <div className="tp-spring" />
            <button className={"tp-btn" + (snap ? " on" : "")} title="Snap to grid" onClick={() => setSnap((s) => !s)}>{I.snap}</button>
            <button className="btn">{I.dice}Randomize</button>
            <button className="btn">{I.plus}Add clip</button>
          </div>

          {/* body: timeline + inspector */}
          <div className="sh-body">
            <div className="tl-wrap">
              <div className="tl-scroll">
                <div className="tl-inner" style={{ width: HEAD + LANE_W }}>
                  {/* ruler */}
                  <div className="tl-row">
                    <div className="tl-head"><span className="tmeta">timeline</span></div>
                    <div className="tl-lane tl-ruler" style={{ height: 30 }}>
                      {Array.from({ length: SHOW_DURATION / 60 + 1 }, (_, i) => (
                        <div key={i} className="tick" style={{ left: i * 60 * PPS }}><span className="lbl">{fmtTime(i * 60)}</span></div>
                      ))}
                      {CUES.map((c, i) => (
                        <div key={i} className="tl-cue" style={{ left: c.t * PPS }}><span className="cue-lbl">{c.label}</span></div>
                      ))}
                    </div>
                  </div>

                  {/* tracks */}
                  {TRACKS.map((tr) => {
                    const dim = solo !== null && solo !== tr.n;
                    return (
                      <div className="tl-row" key={tr.n}>
                        <div className="tl-head">
                          <div style={{ minWidth: 0 }}>
                            <div className="tn">{tr.name}</div>
                            <div className="tmeta">{tr.meta}</div>
                          </div>
                          <div className="ctrls">
                            <button className={"tl-mini" + (muted.has(tr.n) ? " on" : "")} title="Mute" onClick={() => toggleMute(tr.n)}>M</button>
                            <button className={"tl-mini solo" + (solo === tr.n ? " on" : "")} title="Solo" onClick={() => setSolo(solo === tr.n ? null : tr.n)}>S</button>
                          </div>
                        </div>
                        <div className="tl-lane" style={{ height: 56, opacity: dim || muted.has(tr.n) ? 0.4 : 1 }}>
                          {CLIPS.filter((c) => c.track === tr.n).map((c) => (
                            <div key={c.id} className={"clip" + (c.id === selId ? " sel" : "")}
                              style={{ left: c.start * PPS, width: (c.end - c.start) * PPS, "--cc": cc(c.patternId) }}
                              onClick={() => { setSelId(c.id); setTab("clip"); }}>
                              <div className="clab">
                                <div className="nm">{c.label}</div>
                                <div className="meta">{c.patternId} · {Math.round(c.end - c.start)}s</div>
                              </div>
                            </div>
                          ))}
                          {tr.n === 0 && TRANSITIONS.map((tz) => (
                            <div key={tz.id} className="tl-trans" style={{ left: (tz.at - tz.dur / 2) * PPS, width: tz.dur * PPS }} title={tz.type}>
                              <span className="ti">{tz.type === "cross-fade" ? "✕" : tz.type === "dip-black" ? "▽" : "→"}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}

                  {/* automation */}
                  {LANES.map((l) => <AutoLane key={l.id} lane={l} />)}

                  {/* playhead */}
                  <div className="playhead" style={{ left: HEAD + t * PPS }}><span className="ph-cap" /></div>
                </div>
              </div>
            </div>

            {/* inspector */}
            <aside className="sh-insp">
              <div className="sh-tabs">
                <button className={"sh-tab" + (tab === "clip" ? " on" : "")} onClick={() => setTab("clip")}>Clip</button>
                <button className={"sh-tab" + (tab === "show" ? " on" : "")} onClick={() => setTab("show")}>Show</button>
              </div>
              <div className="sh-insp-body">
                {tab === "clip" && sel && (
                  <>
                    <div className="sh-insp-head"><span className="dot" style={{ background: cc(sel.patternId) }} /><span className="nm">{sel.label}</span></div>
                    <div className="insp-row"><span className="k">Pattern</span>
                      <select className="lw-select" value={sel.patternId} onChange={() => {}}>
                        {PATTERNS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </div>
                    <div className="insp-row"><span className="k">Target</span>
                      <select className="lw-select" defaultValue={sel.track === 0 ? "all" : "outer"}>
                        <option value="all">All sections</option>
                        <option value="outer">Outer ring</option>
                        <option value="center">Center ring</option>
                      </select>
                    </div>
                    <div className="field-sep" />
                    <div className="insp-row"><span className="k">Start</span><span className="v">{fmtTime(sel.start)}</span></div>
                    <div className="insp-row"><span className="k">End</span><span className="v">{fmtTime(sel.end)}</span></div>
                    <div className="insp-row"><span className="k">Length</span><span className="v">{fmtTime(sel.end - sel.start)}</span></div>
                    <div className="insp-row"><span className="k">Track</span><span className="v">{sel.track + 1}</span></div>
                    <div className="field-sep" />
                    <div className="slider-row"><div className="lab"><span className="k">Speed</span><span className="v">1.00×</span></div><input className="lw" type="range" min="0.1" max="3" step="0.01" defaultValue="1" /></div>
                    <div className="slider-row"><div className="lab"><span className="k">Brightness</span><span className="v">100%</span></div><input className="lw" type="range" min="0" max="1" step="0.01" defaultValue="1" /></div>
                    <div className="insp-actions">
                      <button className="insp-act">{I.plus}Transition</button>
                      <button className="insp-act">{I.scissors}Split</button>
                      <button className="insp-act">{I.copy}Duplicate</button>
                      <button className="insp-act danger">{I.trash}Delete</button>
                    </div>
                  </>
                )}
                {tab === "show" && (
                  <>
                    <div className="sec-h"><span className="t">Overview</span><span className="line" /></div>
                    <div className="insp-row"><span className="k">Duration</span><span className="v">{fmtTime(SHOW_DURATION)}</span></div>
                    <div className="insp-row"><span className="k">Clips</span><span className="v">{CLIPS.length}</span></div>
                    <div className="insp-row"><span className="k">Transitions</span><span className="v">{TRANSITIONS.length}</span></div>
                    <div className="insp-row"><span className="k">Tracks</span><span className="v">{TRACKS.length} active</span></div>
                    <div className="field-sep" />
                    <div className="sec-h"><span className="t">Cue markers</span><span className="line" /></div>
                    {CUES.map((c, i) => (
                      <div key={i} className="insp-row" style={{ cursor: "pointer" }} onClick={() => setT(c.t)}>
                        <span className="k">{c.label}</span><span className="v">{fmtTime(c.t)}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </aside>
          </div>
        </div>
      </div>
    );
  }

  window.ShowScreen = ShowScreen;
})();
