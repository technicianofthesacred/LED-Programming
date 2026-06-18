/* global React, window */
/* Light Weaver v3 — Installer screen (worker bench guide) */
(function () {
  const { useState } = React;
  const { I } = window.LW;

  const WIRING = [
    ["LED output 1", "GPIO 16", "first data output"],
    ["LED output 2", "GPIO 17", "optional second output"],
    ["LED output 3", "GPIO 18", "optional third output"],
    ["LED output 4", "GPIO 21", "optional fourth output"],
    ["Dial A", "GPIO 4", "rotary encoder A"],
    ["Dial B", "GPIO 5", "rotary encoder B"],
    ["Dial press", "GPIO 6", "press to change look"],
    ["Previous button", "GPIO 7", "optional"],
    ["Next button", "GPIO 8", "optional"],
    ["Blackout button", "GPIO 9", "optional"],
    ["Brightness pot", "GPIO 1", "3.3 V to GND, wiper to GPIO"],
    ["Shared ground", "GND", "required between card and LED supply"],
  ];
  const STEPS = [
    { t: "Flash the card", b: "Use Chrome or Edge on a laptop. Plug the ESP32-S3 in by USB, enter bootloader mode, then flash the Lightweaver firmware.", a: "Open flash", go: "flash" },
    { t: "Wire one output first", b: "Connect LED data to GPIO 16 through the level shifter. Power LEDs from the final supply, not USB. Confirm shared ground before lighting anything." },
    { t: "Join setup WiFi", b: "After flashing, look for Lightweaver-XXXX WiFi. Join it, open 192.168.4.1, then add the shop or customer WiFi and set the hostname." },
    { t: "Load the project", b: "Open the Studio, choose patterns, layout, and settings. Save the card package through the card page so it survives reboot.", a: "Open settings", go: "settings" },
    { t: "Prove it survives", b: "Reboot the card. Confirm the right pattern starts, the dial dims and brightens, dial press changes looks, and zones match the project." },
  ];
  const STOPS = [
    ["Power", "LEDs use the final power supply. USB is only for flashing and debugging."],
    ["Shared ground", "Controller ground, LED supply ground, and level shifter ground must be tied together."],
    ["Dial press", "Use GPIO 6 for the worker build. Avoid GPIO 0 for the main dial press because it is also BOOT."],
    ["One output at a time", "Prove output 1 before adding outputs 2, 3, and 4."],
  ];
  const FAILS = [
    ["No serial port", "Use desktop Chrome or Edge, a data USB cable, and close any serial monitor."],
    ["Flash will not connect", "Hold BOOT, tap RESET, release BOOT, then click Connect again."],
    ["No LEDs", "Check LED supply, shared ground, data direction arrow, and GPIO 16."],
    ["Wrong colors", "Change Color order in Settings, then save to card."],
    ["Dial backwards", "Swap Dial A and Dial B, or change rotation direction before saving."],
    ["Cannot find card later", "Join Lightweaver-XXXX again or open 192.168.4.1."],
  ];
  const SIGNOFF = [
    "Firmware flashes from this site.",
    "Output 1 lights correctly.",
    "Inner and outer zones match the project.",
    "Dial turn changes brightness.",
    "Dial press changes looks.",
    "Reboot keeps the saved project.",
  ];

  function InstallerScreen({ go }) {
    const [checks, setChecks] = useState(() => new Set());
    const toggle = (i) => setChecks((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
    const goTo = (v) => go && go(v);

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="inst">
            <header className="inst-hero">
              <div>
                <div className="inst-kicker">Installer</div>
                <h1>Worker install</h1>
                <p>Flash the card, wire the piece, load the project, then run the bench checks before it leaves the shop.</p>
              </div>
              <div className="inst-actions">
                <button className="btn primary" onClick={() => goTo("flash")}>{I.bolt}Flash chip</button>
                <button className="btn" onClick={() => goTo("settings")}>Load project</button>
              </div>
            </header>

            <div className="inst-grid">
              <div className="inst-stack">
                <section className="card inst-sec">
                  <div className="sec-h"><span className="t">Start here</span><span className="m">do not skip</span></div>
                  <div className="inst-steps">
                    {STEPS.map((s, i) => (
                      <div className="inst-step" key={i}>
                        <span className="inst-stepn">{i + 1}</span>
                        <div className="inst-stepbody">
                          <strong>{s.t}</strong>
                          <p>{s.b}</p>
                        </div>
                        {s.a && <button className="btn ghost-sm" onClick={() => goTo(s.go)}>{s.a}</button>}
                      </div>
                    ))}
                  </div>
                </section>

                <section className="card inst-sec">
                  <div className="sec-h"><span className="t">Wiring map</span><span className="m">default card pins</span></div>
                  <div className="inst-wiring">
                    {WIRING.map(([n, pin, note]) => (
                      <div className="inst-wire" key={n}>
                        <strong>{n}</strong>
                        <code>{pin}</code>
                        <span>{note}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <aside className="inst-stack">
                <section className="card inst-sec">
                  <div className="sec-h"><span className="t">Hard stops</span><span className="m">fix before shipping</span></div>
                  <div className="inst-stops">
                    {STOPS.map(([t, b]) => (
                      <div className="inst-stop" key={t}><strong>{t}</strong><span>{b}</span></div>
                    ))}
                  </div>
                </section>

                <section className="card inst-sec">
                  <div className="sec-h"><span className="t">If something fails</span><span className="m">recovery</span></div>
                  <div className="inst-fails">
                    {FAILS.map(([p, f]) => (
                      <div className="inst-fail" key={p}><strong>{p}</strong><span>{f}</span></div>
                    ))}
                  </div>
                </section>

                <section className="card inst-sec">
                  <div className="sec-h"><span className="t">Final signoff</span><span className="m">{checks.size}/{SIGNOFF.length} bench test</span></div>
                  <div className="inst-signoff">
                    {SIGNOFF.map((s, i) => (
                      <label key={i} className="inst-check" onClick={() => toggle(i)}>
                        <span className={"pm-box" + (checks.has(i) ? " on" : "")}>{checks.has(i) && I.check}</span>
                        <span className={checks.has(i) ? "done" : ""}>{s}</span>
                      </label>
                    ))}
                  </div>
                </section>
              </aside>
            </div>
          </div>
        </div>
      </div>
    );
  }

  window.InstallerScreen = InstallerScreen;
})();
