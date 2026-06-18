/* Light Weaver v3 — Flash screen */
/* Exact mockup file. The component BODY (JSX, class names, layout) is
   unchanged from the design source; only the local SAMPLE flash simulation
   was swapped for the real ESP32 Web Serial flashing engine. No visual
   structure was altered. */
import React, { useState, useRef, useEffect } from 'react';
import { I } from './lw-shared.jsx';
import { connectESP, disconnectESP, flashFirmware } from '../lib/flash.js';
import {
  DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS,
  DEFAULT_WLED_APP_FLASH_ADDRESS,
  validateFlashPlan,
} from '../lib/flashPlan.js';

  const STEPS = [
    { n: 1, label: "Hold BOOT", sub: "GPIO0 pin", kbd: "BOOT ↓" },
    { n: 2, label: "Press RESET", sub: "EN pin — then release", kbd: "RESET ⟳" },
    { n: 3, label: "Release BOOT", sub: "then click Connect", kbd: "BOOT ↑" },
  ];

  const LIGHTWEAVER_FIRMWARE_URL = '/firmware/lightweaver-controller-esp32s3-factory.bin';
  const LIGHTWEAVER_FIRMWARE_NAME = 'lightweaver-controller-esp32s3-factory.bin';

  // Mockup-bug guard: keep button-internal glyphs at the mockup's 16px so the
  // larger 24-viewBox icons do not blow up inside .btn-lg / .fw-file / .fl-warn.
  const ICON16 = { width: 16, height: 16, flexShrink: 0 };

  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function FlashScreen() {
    const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator;

    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [fw, setFw] = useState(null);
    const [erase, setErase] = useState(true);
    const [addr, setAddr] = useState(DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS);
    const [flashing, setFlashing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [status, setStatus] = useState("");
    const [kind, setKind] = useState("");
    const [log, setLog] = useState("");
    const [loadingBundled, setLoadingBundled] = useState(false);

    const logRef = useRef(null);
    const loaderRef = useRef(null);
    const transportRef = useRef(null);
    const fileInputRef = useRef(null);

    const append = (line) => setLog((p) => p + line + "\n");
    useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

    const connect = async () => {
      if (connected) {
        setConnecting(true);
        await disconnectESP(loaderRef.current, transportRef.current);
        loaderRef.current = null;
        transportRef.current = null;
        setConnected(false);
        setConnecting(false);
        setStatus("Disconnected"); setKind(""); append("Disconnected.");
        return;
      }
      setConnecting(true); setStatus("Select serial port…"); setKind("");
      try {
        const { loader, transport, chip } = await connectESP();
        loaderRef.current = loader;
        transportRef.current = transport;
        setConnected(true);
        setStatus(`● ${chip}`); setKind("ok"); append(`Connected: ${chip}`);
      } catch (err) {
        const msg = err?.message ?? String(err);
        setStatus(`✕ ${msg}`); setKind("err"); append(`Connection failed: ${msg}`);
        if (msg.includes('Failed to connect') || msg.includes('sync')) {
          append('→ Hold BOOT → press+release RESET → release BOOT → then Connect');
        }
        loaderRef.current = null;
        transportRef.current = null;
      } finally {
        setConnecting(false);
      }
    };

    const useFirmware = async () => {
      setLoadingBundled(true);
      setStatus("Loading Lightweaver firmware…"); setKind("");
      try {
        const response = await fetch(LIGHTWEAVER_FIRMWARE_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`firmware file ${response.status}`);
        const blob = await response.blob();
        const file = new File([blob], LIGHTWEAVER_FIRMWARE_NAME, { type: 'application/octet-stream' });
        setFw(file);
        setAddr(DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS);
        setErase(true);
        setStatus("Lightweaver firmware selected."); setKind("ok");
        append(`Selected ${LIGHTWEAVER_FIRMWARE_NAME} (${fmtSize(file.size)})`);
      } catch (err) {
        setStatus(`✕ Could not load bundled firmware: ${err.message}`); setKind("err");
        append(`Bundled firmware failed: ${err.message}`);
      } finally {
        setLoadingBundled(false);
      }
    };

    const browseFile = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setFw(file);
      append(`Selected ${file.name} (${fmtSize(file.size)})`);
    };

    const flash = async () => {
      if (!connected || !fw || flashing || !loaderRef.current) return;
      let address;
      try {
        ({ address } = validateFlashPlan({ address: addr, eraseAll: erase }));
      } catch (err) {
        setStatus(`✕ ${err.message ?? err}`); setKind("err");
        append(`Flash blocked: ${err.message ?? err}`);
        return;
      }
      setFlashing(true); setProgress(0); setStatus(erase ? "Erasing flash…" : "Flashing…"); setKind("");
      append(`Flashing ${fmtSize(fw.size)} @ 0x${address.toString(16).toUpperCase()}${erase ? "  [erase all]" : ""}…`);
      if (erase) append("Erasing flash — this takes ~15 s…");
      try {
        await flashFirmware(loaderRef.current, fw, address, erase, (pct) => {
          setProgress(pct);
          setStatus(`Flashing… ${Math.round(pct * 100)}%`);
        });
        setProgress(1);
        setStatus("● Flash complete — Lightweaver is booting"); setKind("ok");
        append("Flash complete. Lightweaver should start in a few seconds.");
      } catch (err) {
        setStatus(`✕ Flash failed: ${err.message ?? err}`); setKind("err");
        append(`Error: ${err.message ?? err}`);
      } finally {
        setFlashing(false);
      }
    };

    const canFlash = connected && fw && !flashing;
    const canConnect = hasWebSerial && !connecting && !flashing;

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="fl">
            <div className={"fl-warn " + (hasWebSerial ? "ok" : "warn")}>
              <span style={ICON16}>{I.info}</span>
              <div>
                {hasWebSerial
                  ? "The card ships pre-flashed with Lightweaver firmware. Use this only for blank ESP32-S3 boards or a firmware replacement."
                  : "Web Serial requires Chrome or Edge. In-browser flashing is not available in your current browser."}
              </div>
            </div>

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
                  <button className="btn-lg" onClick={useFirmware} disabled={loadingBundled}>
                    <span style={ICON16}>{I.bolt}</span>{loadingBundled ? "Loading…" : "Use Lightweaver firmware"}
                  </button>
                  <span className="fw-or">or</span>
                  <button className="btn-lg ghost" onClick={() => fileInputRef.current?.click()}>
                    <span style={ICON16}>{I.doc}</span>Browse .bin
                  </button>
                  <input ref={fileInputRef} type="file" accept=".bin" style={{ display: "none" }} onChange={browseFile} />
                </div>
                {fw && <div className="fw-file"><span style={{ width: 14, height: 14, flexShrink: 0 }}>{I.check}</span>{fw.name} ({fmtSize(fw.size)})</div>}
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
                  <span className="hint">Wipes the chip first — takes ~15 s. Factory firmware flashes at {DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS}; app-only replacements usually flash at {DEFAULT_WLED_APP_FLASH_ADDRESS} with this off.</span>
                </label>
              </div>
            </div>

            <div className="fl-run">
              <button className={"btn-lg" + (connected ? " ghost" : "")} onClick={connect} disabled={!canConnect}>
                {connecting ? (connected ? "Disconnecting…" : "Connecting…") : connected ? "Disconnect" : "Connect"}
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
