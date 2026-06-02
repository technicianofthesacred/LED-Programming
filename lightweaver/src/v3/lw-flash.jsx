/* Light Weaver v3 — Flash screen */
/* Exact mockup file, converted from window-global script to ES module.
   Only the wrapper changed; the component body below is byte-identical. */
import React, { useState, useRef, useEffect } from 'react';
import { I } from './lw-shared.jsx';


  const STEPS = [
    { n: 1, label: "Hold BOOT", sub: "GPIO0 pin", kbd: "BOOT ↓" },
    { n: 2, label: "Press RESET", sub: "EN pin — then release", kbd: "RESET ⟳" },
    { n: 3, label: "Release BOOT", sub: "then click Connect", kbd: "BOOT ↑" },
  ];

  function FlashScreen() {
    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [fw, setFw] = useState(null);
    const [erase, setErase] = useState(true);
    const [addr, setAddr] = useState("0x0");
    const [flashing, setFlashing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState("");
    const [kind, setKind] = useState("");
    const [log, setLog] = useState("");
    const logRef = useRef(null);

    const append = (line) => setLog((p) => p + line + "\n");
    useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

    const connect = () => {
      if (connected) { setConnected(false); setStatus("Disconnected"); setKind(""); append("Disconnected."); return; }
      setConnecting(true); setStatus("Select serial port…"); setKind("");
      setTimeout(() => { setConnecting(false); setConnected(true); setStatus("● ESP32-S3 (QFN56) (revision v0.2)"); setKind("ok"); append("Connected: ESP32-S3"); }, 900);
    };
    const useFirmware = () => { setFw({ name: "lightweaver-controller-esp32s3-factory.bin", size: "1.84 MB" }); setAddr("0x0"); setErase(true); setStatus("Lightweaver firmware selected."); setKind("ok"); append("Selected lightweaver-controller-esp32s3-factory.bin (1.84 MB)"); };

    const flash = () => {
      if (!connected || !fw || flashing) return;
      setFlashing(true); setProgress(0); setStatus("Erasing flash…"); setKind("");
      append(`Flashing 1.84 MB @ ${addr}${erase ? "  [erase all]" : ""}…`);
      if (erase) append("Erasing flash — this takes ~15 s…");
      let p = 0;
      const iv = setInterval(() => {
        p += 0.04 + Math.random() * 0.05;
        if (p >= 1) {
          p = 1; clearInterval(iv); setFlashing(false);
          setStatus("● Flash complete — Lightweaver is booting"); setKind("ok");
          append("Flash complete. Lightweaver should start in a few seconds.");
        } else { setStatus(`Flashing… ${Math.round(p * 100)}%`); }
        setProgress(p);
      }, 180);
    };

    const canFlash = connected && fw && !flashing;

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="fl">
            <div className="fl-warn ok">{I.info}<div>The card ships pre-flashed with Lightweaver firmware. Use this only for blank ESP32-S3 boards or a firmware replacement.</div></div>

            <div>
              <div className="sec-h"><span className="t">Bootloader mode</span><span className="m">do this before connecting</span><span className="line" /></div>
              <div className="boot-steps">
                {STEPS.map((s) => (
                  <div key={s.n} className="boot-step">
                    <div className="sn">STEP {s.n}</div>
                    <div className="sl">{s.label}</div>
                    <div className="ss">{s.sub}</div>
                    <div className="kbd">{s.kbd}</div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="sec-h"><span className="t">Lightweaver firmware</span><span className="line" /></div>
              <div className="card fw-card">
                <p>Use the bundled Lightweaver factory firmware for sellable cards and blank ESP32-S3 boards. Only browse for a file if you were given a specific replacement binary.</p>
                <div className="fw-actions">
                  <button className="btn-lg" onClick={useFirmware}>{I.bolt}Use Lightweaver firmware</button>
                  <span className="fw-or">or</span>
                  <button className="btn-lg ghost" onClick={() => { setFw({ name: "custom-build.bin", size: "1.79 MB" }); append("Selected custom-build.bin (1.79 MB)"); }}>{I.doc}Browse .bin</button>
                </div>
                {fw && <div className="fw-file">{I.check}{fw.name} ({fw.size})</div>}
              </div>
            </div>

            <div>
              <div className="sec-h"><span className="t">Flash options</span><span className="line" /></div>
              <div className="card opt-grid">
                <span className="k">Address</span>
                <input className="num-input" style={{ width: 110, textAlign: "left" }} value={addr} onChange={(e) => setAddr(e.target.value)} />
                <span className="k">Erase all</span>
                <label className="ex-check" style={{ margin: 0 }} onClick={() => setErase((x) => !x)}>
                  <span className={"ex-toggle" + (erase ? " on" : "")} />
                  <span className="hint">Wipes the chip first — takes ~15 s. Leave on for factory firmware.</span>
                </label>
              </div>
            </div>

            <div className="fl-run">
              <button className={"btn-lg" + (connected ? " ghost" : "")} onClick={connect} disabled={connecting}>
                {connecting ? "Connecting…" : connected ? "Disconnect" : "Connect"}
              </button>
              <button className="btn-lg" onClick={flash} disabled={!canFlash} title={!connected ? "Connect device first" : !fw ? "Select firmware first" : "Flash firmware"}>Flash firmware</button>
              {status && <span className={"stat" + (kind === "ok" ? " ok" : kind === "err" ? " err" : "")}>{status}</span>}
            </div>

            <div className="fl-bar"><div className="fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>

            <div>
              <div className="sec-h"><span className="t">Log</span><span className="m">{Math.round(progress * 100)}%</span><span className="line" /></div>
              <textarea ref={logRef} className="fl-log" readOnly value={log} placeholder="Connect the card to begin…" />
            </div>
          </div>
        </div>
      </div>
    );
  }

export { FlashScreen };
