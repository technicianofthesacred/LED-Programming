/* global React, window */
/* Light Weaver v3 — Settings screen */
(function () {
  const { useState } = React;
  const { I, SWATCHES } = window.LW;

  function Row({ label, hint, stack, children }) {
    return (
      <div className={"set-row" + (stack ? " stack" : "")}>
        <div className="set-k"><span className="kk">{label}</span>{hint && <span className="hh">{hint}</span>}</div>
        <div className="set-v">{children}</div>
      </div>
    );
  }
  function Seg({ opts, val, set }) {
    return (
      <div className="mini-seg">
        {opts.map((o) => <button key={o} className={val === o ? "on" : ""} onClick={() => set(o)}>{o}</button>)}
      </div>
    );
  }
  function Range({ value, set, min, max, step, fmt }) {
    return (
      <div className="set-range">
        <input className="lw" type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(parseFloat(e.target.value))} />
        <span className="set-rv">{fmt(value)}</span>
      </div>
    );
  }

  function SettingsScreen() {
    const [name, setName] = useState("Willow Canopy v3");
    const [bpm, setBpm] = useState(120);
    const [dur, setDur] = useState(600);
    const [palette, setPalette] = useState([0, 2, 4, 6, 9]);
    const [theme, setTheme] = useState("Dark");
    const [speed, setSpeed] = useState(1.0);
    const [smooth, setSmooth] = useState("Soft");
    const [bri, setBri] = useState(85);
    const [sat, setSat] = useState(90);
    const [hue, setHue] = useState(0);
    const [gamma, setGamma] = useState(true);
    const [res, setRes] = useState("Med");
    const [fps, setFps] = useState("25");
    const [runtime, setRuntime] = useState("Playlist");
    const [order, setOrder] = useState("RGB");
    const [limit, setLimit] = useState(180);

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="set">
            <h1 className="set-title">Settings</h1>

            <div className="set-cols">
              <div className="set-col">
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Project</span></div>
                  <Row label="Project name"><input className="pm-input" value={name} onChange={(e) => setName(e.target.value)} /></Row>
                  <Row label="Default BPM" hint="Used for beat-quantized clip recording"><input className="num-input" type="number" value={bpm} onChange={(e) => setBpm(+e.target.value)} /></Row>
                  <Row label="Show duration" hint="Total timeline length"><div className="set-v-inline"><input className="num-input" type="number" value={dur} onChange={(e) => setDur(+e.target.value)} /><span className="set-u">sec</span></div></Row>
                </section>

                <section className="card set-card">
                  <div className="sec-h"><span className="t">Pattern palette</span><span className="m">read by all patterns</span></div>
                  <div className="set-pal">
                    {palette.map((s, i) => (
                      <span key={i} className="set-palsw" style={{ background: SWATCHES[s] }}>
                        <button className="set-palx" onClick={() => setPalette((p) => p.filter((_, k) => k !== i))}>{I.x}</button>
                      </span>
                    ))}
                    <button className="set-paladd" onClick={() => setPalette((p) => [...p, (p[p.length - 1] + 1) % SWATCHES.length])}>{I.plus}</button>
                  </div>
                </section>

                <section className="card set-card">
                  <div className="sec-h"><span className="t">Look defaults</span></div>
                  <Row label="Theme"><Seg opts={["Dark", "Light"]} val={theme} set={setTheme} /></Row>
                  <Row label="Master speed default"><Range value={speed} set={setSpeed} min={0.1} max={3} step={0.01} fmt={(v) => `${v.toFixed(2)}×`} /></Row>
                  <Row label="Motion smoothing"><Seg opts={["Off", "Soft", "Smooth"]} val={smooth} set={setSmooth} /></Row>
                  <Row label="Master brightness"><Range value={bri} set={setBri} min={5} max={100} step={1} fmt={(v) => `${v}%`} /></Row>
                  <Row label="Master saturation"><Range value={sat} set={setSat} min={0} max={100} step={1} fmt={(v) => `${v}%`} /></Row>
                  <Row label="Master hue shift" hint="Rotates all colors on the wheel">
                    <div className="set-v-inline"><Range value={hue} set={setHue} min={-128} max={128} step={1} fmt={(v) => `${v}`} /><button className="btn ghost-sm" onClick={() => setHue(0)}>Reset</button></div>
                  </Row>
                </section>
              </div>

              <div className="set-col">
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Rendering</span></div>
                  <Row label="Gamma correction" hint="Corrects LED brightness curve"><button className={"ex-toggle" + (gamma ? " on" : "")} onClick={() => setGamma((g) => !g)} /></Row>
                  <Row label="Canvas resolution" hint="Lower = faster rendering"><Seg opts={["Low", "Med", "High"]} val={res} set={setRes} /></Row>
                  <Row label="Card push fps" hint="Max frames per second sent to the card"><Seg opts={["15", "25", "30", "40"]} val={fps} set={setFps} /></Row>
                </section>

                <section className="card set-card">
                  <div className="sec-h"><span className="t">Card &amp; hardware</span></div>
                  <Row label="Runtime mode" hint="What the card plays from on boot"><Seg opts={["Playlist", "Single", "Sequence"]} val={runtime} set={setRuntime} /></Row>
                  <Row label="Color order" hint="This card is calibrated to RGB"><Seg opts={["RGB", "GRB", "BRG"]} val={order} set={setOrder} /></Row>
                  <Row label="Brightness limit" hint="Max firmware output for sellable pieces"><Range value={limit} set={setLimit} min={32} max={255} step={1} fmt={(v) => `${v}`} /></Row>
                  <Row label="LED output" hint="Firmware uses fixed connector pins" stack>
                    <div className="set-output">
                      <input className="pm-input" defaultValue="Strip 1" style={{ flex: 2 }} />
                      <div className="set-outfield"><input className="num-input" defaultValue="16" style={{ width: 56 }} /><span>GPIO</span></div>
                      <div className="set-outfield"><input className="num-input" defaultValue="1204" style={{ width: 70 }} /><span>pixels</span></div>
                    </div>
                  </Row>
                </section>

                <section className="card set-card">
                  <div className="sec-h"><span className="t">Project file</span></div>
                  <Row label="Save project" hint="Download a .lwproj.json file you can reload"><button className="btn">{I.download}Download .lwproj.json</button></Row>
                  <Row label="Load project" hint="Import a .lwproj.json file"><button className="btn">{I.doc}Choose file…</button></Row>
                </section>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  window.SettingsScreen = SettingsScreen;
})();
