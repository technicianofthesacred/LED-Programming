/* global React, window */
/* Light Weaver v3 — Playlist screen */
(function () {
  const { useState } = React;
  const { I, PATTERNS, MIXES } = window.LW;
  const byId = (id) => [...MIXES, ...PATTERNS].find((p) => p.id === id);

  function PlaylistScreen({ connected }) {
    const [order, setOrder] = useState(["mix1", "lava", "aurora", "ember", "calm", "ocean", "rainbow", "sparkle"]);
    const [live, setLive] = useState("aurora");
    const [host, setHost] = useState("lightweaver.local");

    const move = (i, d) => setOrder((o) => { const n = [...o]; const j = i + d; if (j < 0 || j >= n.length) return o; [n[i], n[j]] = [n[j], n[i]]; return n; });
    const first = (i) => setOrder((o) => { const n = [...o]; const [x] = n.splice(i, 1); n.unshift(x); return n; });
    const dup = (i) => setOrder((o) => { const n = [...o]; n.splice(i + 1, 0, o[i]); return n; });
    const remove = (i) => setOrder((o) => o.filter((_, k) => k !== i));
    const add = (id) => setOrder((o) => [...o, id]);

    const pool = PATTERNS.filter((p) => !order.includes(p.id));

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="pm">
            <header className="pm-hero">
              <div className="pm-title">
                <h1>Playlist</h1>
                <p>The order the dial press cycles through on the card. The first look starts on boot.</p>
              </div>
              <div className="pm-actions">
                <button className="btn">{I.refresh}Reset live</button>
                <button className="btn primary" disabled={!connected}>{I.bolt}Load playlist to card</button>
                <div className="pm-menu">
                  <button className="btn">{I.copy}Copy chip config</button>
                </div>
                <button className="btn">{I.download}Download</button>
                <button className="btn">{I.open}Open card</button>
              </div>
            </header>

            <div className="pm-grid">
              <section className="pm-main">
                <div className="pl-hostrow">
                  <span className="sf-l">Card address</span>
                  <input className="pm-input" value={host} onChange={(e) => setHost(e.target.value)} style={{ maxWidth: 260 }} />
                  <span className="pl-count">{order.length} looks · dial press to advance</span>
                </div>

                <div className="pl-list">
                  {order.map((id, i) => {
                    const p = byId(id);
                    if (!p) return null;
                    return (
                      <article key={id + i} className={"pl-row" + (live === id ? " is-live" : "")}>
                        <div className="pl-index">
                          <span className="pl-grip">::</span>
                          <strong>{String(i + 1).padStart(2, "0")}</strong>
                          <span>{i === 0 ? "startup" : "press"}</span>
                        </div>
                        <span className="pl-art" style={{ background: p.grad }} />
                        <div className="pl-copy">
                          <strong>{p.label}{p.mix && <span className="mixtag">mix</span>}</strong>
                          <span>{p.mix ? "section mix" : `${p.label} across the piece`}</span>
                        </div>
                        <div className="pl-actions">
                          <button className={"plbtn" + (live === id ? " on" : "")} onClick={() => setLive(id)}>Live</button>
                          <button className="plbtn" disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
                          <button className="plbtn" disabled={i === order.length - 1} onClick={() => move(i, 1)}>Down</button>
                          <button className="plbtn" disabled={i === 0} onClick={() => first(i)}>Make first</button>
                          <button className="plbtn" onClick={() => dup(i)}>Copy</button>
                          <button className="plbtn danger" onClick={() => remove(i)}>Remove</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <aside className="pm-aside">
                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Layer mixes</span><span className="m">{MIXES.length}</span></div>
                  {MIXES.map((m) => (
                    <button key={m.id} className="pl-source" onClick={() => add(m.id)} disabled={order.includes(m.id)}>
                      <span className="pl-src-art" style={{ background: m.grad }} />
                      <span className="pl-src-nm">{m.label}<span className="mixtag">mix</span></span>
                      <span className="pl-src-add">{order.includes(m.id) ? I.check : I.plus}</span>
                    </button>
                  ))}
                  {!MIXES.some((m) => !order.includes(m.id)) && <p className="pl-empty">All mixes added. Save more on Patterns.</p>}
                </div>

                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Pattern pool</span><span className="m">{pool.length} available</span></div>
                  <div className="pl-pool">
                    {pool.map((p) => (
                      <button key={p.id} className="pl-chip" onClick={() => add(p.id)} title={`Add ${p.label}`}>
                        <span className="pl-chip-art" style={{ background: p.grad }} />
                        <span className="pl-chip-nm">{p.label}</span>
                        <span className="pl-chip-add">{I.plus}</span>
                      </button>
                    ))}
                    {!pool.length && <p className="pl-empty">Every pattern is in the playlist.</p>}
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
    );
  }

  window.PlaylistScreen = PlaylistScreen;
})();
