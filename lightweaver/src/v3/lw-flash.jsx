/* Lightweaver v3 — safe automatic installer + technician diagnostics. */
import React, { useState, useRef, useEffect } from 'react';
import { I } from './lw-shared.jsx';
import { connectESP, disconnectESP, flashFirmware, inspectConnectedESP } from '../lib/flash.js';
import {
  FLASH_COMPLETE_RELEASED_LOG,
  FLASH_COMPLETE_RELEASED_STATUS,
  flashFirmwareAndRelease,
} from '../lib/flashWorkflow.js';
import {
  DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS,
  DEFAULT_WLED_APP_FLASH_ADDRESS,
  validateFirmwareImage,
  validateFlashPlan,
  validateInstallHardware,
  validateProductionInstallRelease,
  replaceInstallConnection,
} from '../lib/flashPlan.js';
import { loadProductionFirmwareRelease } from '../lib/firmwareRelease.js';
import { SECURE_INSTALLER_URL, detectPlatformCapabilities } from '../lib/platformCapabilities.js';
import { nextCardConnectionAction } from '../lib/cardConnectionFlow.js';
import { createBridgeResultChannel, launchBridgeOperation, resumeBridgeReturnCode } from '../lib/bridgeLaunch.js';
import { saveCurrentProjectToLibrary } from '../lib/projectStorage.js';
import { useProject } from '../state/ProjectContext.jsx';
import { CardCommissioningPanel, CardCommissioningSteps } from '../components/card/CardCommissioningPanel.jsx';
import { readCardProjectEvidence } from '../lib/cardPushClient.js';
import { readCardWiringCandidateEvidence } from '../lib/cardWiringSafety.js';
import {
  beginCardCommissioning,
  completeCardInstall,
  readCardCommissioning,
  writeCardCommissioning,
} from '../lib/cardCommissioningFlow.js';

  const STEPS = [
    { n: 1, label: "Hold BOOT", sub: "GPIO0 pin", kbd: "BOOT ↓" },
    { n: 2, label: "Press RESET", sub: "EN pin — then release", kbd: "RESET ⟳" },
    { n: 3, label: "Release BOOT", sub: "then click Connect", kbd: "BOOT ↑" },
  ];

  const LIGHTWEAVER_FIRMWARE_NAME = 'lightweaver-controller-esp32s3-factory.bin';

  // Mockup-bug guard: keep button-internal glyphs at the mockup's 16px so the
  // larger 24-viewBox icons do not blow up inside .btn-lg / .fw-file / .fl-warn.
  const ICON16 = { width: 16, height: 16, flexShrink: 0 };

  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function TechnicianFlashScreen() {
    const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator;

    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [fw, setFw] = useState(null);
    const [erase, setErase] = useState(true);
    const [eraseConfirmed, setEraseConfirmed] = useState(false);
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
        const release = await loadProductionFirmwareRelease();
        validateProductionInstallRelease(release);
        const { bytes } = release;
        const file = new File([bytes], LIGHTWEAVER_FIRMWARE_NAME, { type: 'application/octet-stream' });
        setFw(file);
        setAddr(DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS);
        setErase(true);
        setStatus("Verified Lightweaver firmware selected."); setKind("ok");
        append(`Verified and selected ${LIGHTWEAVER_FIRMWARE_NAME} (${fmtSize(file.size)})`);
      } catch (err) {
        setStatus(`✕ Could not verify Lightweaver firmware: ${err.message}`); setKind("err");
        append(`Signed firmware verification failed: ${err.message}`);
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
      // Last line of defense before anything touches the chip: whatever is
      // selected (bundled or browsed) must at least be an ESP image.
      try {
        const head = new Uint8Array(await fw.slice(0, 1).arrayBuffer());
        validateFirmwareImage({ bytes: head, size: fw.size });
      } catch (err) {
        setStatus(`✕ ${err.message ?? err}`); setKind("err");
        append(`Flash blocked: ${err.message ?? err}`);
        return;
      }
      setFlashing(true); setProgress(0); setStatus(erase ? "Erasing flash…" : "Flashing…"); setKind("");
      append(`Flashing ${fmtSize(fw.size)} @ 0x${address.toString(16).toUpperCase()}${erase ? "  [erase all]" : ""}…`);
      if (erase) append("Erasing flash — this takes ~15 s…");
      try {
        await flashFirmwareAndRelease({
          loader: loaderRef.current,
          transport: transportRef.current,
          file: fw,
          address,
          eraseAll: erase,
          flashFirmware,
          onProgress: (pct) => {
            setProgress(pct);
            setStatus(`Flashing… ${Math.round(pct * 100)}%`);
          },
        });
        setProgress(1);
        setStatus(FLASH_COMPLETE_RELEASED_STATUS); setKind("ok");
        append(FLASH_COMPLETE_RELEASED_LOG);
      } catch (err) {
        setStatus(`✕ Flash failed: ${err.message ?? err}`); setKind("err");
        append(`Error: ${err.message ?? err}`);
      } finally {
        loaderRef.current = null;
        transportRef.current = null;
        setConnected(false);
        setFlashing(false);
      }
    };

    const canFlash = connected && fw && !flashing && (!erase || eraseConfirmed);
    const canConnect = hasWebSerial && !connecting && !flashing;

    return (
      <div className="screen">
        <div className="screen-scroll">
          <details className="technician-disclosure">
            <summary>Technician diagnostics</summary>
            <div className="fl">
            <div>
              <div className="eyebrow">Advanced tools</div>
              <h1 className="flash-screen-title">Manual firmware tools</h1>
              <p className="flash-screen-intro">Manual firmware files, offsets, erase controls, and the serial log are kept here for trained repair work.</p>
            </div>
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
                <label className="ex-check" style={{ margin: 0 }}>
                  <input type="checkbox" checked={erase} onChange={() => { setErase((x) => !x); setEraseConfirmed(false); }} />
                  <span className={"ex-toggle" + (erase ? " on" : "")} />
                  <span className="hint">Wipes the chip first — takes ~15 s. Factory firmware flashes at {DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS}; app-only replacements usually flash at {DEFAULT_WLED_APP_FLASH_ADDRESS} with this off.</span>
                </label>
                {erase && (
                  <label className="ex-check" style={{ margin: 0, gridColumn: '1 / -1' }}>
                    <input type="checkbox" checked={eraseConfirmed} onChange={(event) => setEraseConfirmed(event.target.checked)} />
                    <span className="hint"><strong>Final confirmation:</strong> I understand Erase all permanently removes the current card settings.</span>
                  </label>
                )}
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
          </details>
        </div>
      </div>
    );
  }

  function detectInstallerCapabilities() {
    if (typeof navigator === 'undefined') return detectPlatformCapabilities();
    return detectPlatformCapabilities({
      secureContext: globalThis.isSecureContext === true,
      topLevel: globalThis.top === globalThis.self,
      serial: navigator.serial,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    });
  }

  function UnsupportedInstall({ action, onLaunchBridge }) {
    const [bridgeState, setBridgeState] = useState('idle');
    const [returnCode, setReturnCode] = useState('');
    const [returnError, setReturnError] = useState('');
    const bridgeLifecycleState = bridgeState === 'idle' && action.id === 'install-native-bridge'
      ? 'installer-unavailable' : bridgeState;
    let firstStep;
    let showSecureInstaller = false;
    switch (action.id) {
      case 'escape-insecure-card-frame':
        firstStep = 'Open secure Lightweaver Studio in its own top-level tab.';
        showSecureInstaller = true;
        break;
      case 'handoff-supported-device':
        firstStep = 'Open led.mandalacodes.com on a Mac, Windows, or Linux computer.';
        break;
      case 'launch-native-bridge':
      case 'install-native-bridge':
        firstStep = 'Use secure Studio in a browser with USB support, or continue on another supported computer.';
        break;
      case 'needs-safe-recovery':
      case 'needs-card-update':
        firstStep = 'Keep the card powered and use secure Studio on a supported computer.';
        break;
      case 'ready-browser-usb':
        firstStep = 'Return to the secure top-level installer and connect the card by USB.';
        break;
      case 'ready-local-card':
      case 'wrong-card':
      case 'recoverable-failure':
      default:
        firstStep = 'Return to Studio and check the physical card connection.';
        break;
    }

    return (
      <div className="card install-handoff" role="status">
        <div className="eyebrow">Your project is safe in Studio</div>
        <h1>{bridgeLifecycleState === 'installer-unavailable' ? 'Signed Bridge installer unavailable' : action.title}</h1>
        <p>{action.explanation}</p>
        <ol>
          <li>{firstStep}</li>
          <li>Open this project, then choose <strong>Connect card</strong> and <strong>Blank or not responding</strong>.</li>
          <li>Plug the Lightweaver card into that computer by USB.</li>
        </ol>
        {showSecureInstaller && (
          <a className="btn-lg" href={SECURE_INSTALLER_URL} target="_blank" rel="noopener noreferrer">Open secure installer</a>
        )}
        {(action.id === 'launch-native-bridge' || action.id === 'install-native-bridge') && (
          <>
            <button
              className="btn-lg"
              type="button"
              disabled={bridgeState === 'opening' || bridgeState === 'waiting-for-bridge' || bridgeState === 'return-pending'}
              onClick={async () => {
                setBridgeState('opening');
                try {
                  await onLaunchBridge('install-current-release');
                  setBridgeState('waiting-for-bridge');
                } catch { setBridgeState('error'); }
              }}
            >
              {bridgeState === 'opening' || bridgeState === 'waiting-for-bridge' ? 'Waiting for Lightweaver Bridge…' : bridgeState === 'return-pending' ? 'Return pending…' : 'Open Lightweaver Bridge'}
            </button>
            {bridgeState === 'waiting-for-bridge' && <p>Studio sent the launch request but cannot confirm whether Bridge opened. Keep this tab available, or paste the one-time return code below.</p>}
            {bridgeState === 'return-pending' && <p>Return pending while Studio validates the code and acknowledges the saved Bridge result.</p>}
            <form onSubmit={async event => {
                event.preventDefault();
                setReturnError('');
                setBridgeState('return-pending');
                const channel = createBridgeResultChannel();
                try {
                  await resumeBridgeReturnCode(returnCode, { publish: result => channel.publish(result) });
                  setReturnCode('');
                } catch {
                  setBridgeState('waiting-for-bridge');
                  setReturnError('That return code is invalid, expired, already used, or belongs to another browser profile.');
                } finally { channel.close(); }
              }}>
                <label htmlFor="installer-bridge-return-code">Return code from Bridge</label>
                <input id="installer-bridge-return-code" value={returnCode} onChange={event => setReturnCode(event.target.value)} autoComplete="off" spellCheck="false" maxLength={904} />
                <button type="submit" disabled={!returnCode.trim() || bridgeState === 'return-pending'}>Resume in this tab</button>
            </form>
            {action.id === 'install-native-bridge' && <p>A verified signed installer is not yet available. Studio does not offer an unsigned download.</p>}
            {returnError && <p role="alert">{returnError}</p>}
            {bridgeState === 'error' && <p role="alert">Studio could not save the project and open Bridge. Save the project, then try again.</p>}
          </>
        )}
      </div>
    );
  }

  function AutomaticInstallScreen({ cardLink = {}, onConnectCard }) {
    const { serializeProject, markProjectPersisted, projectLifecycle } = useProject();
    const capabilities = detectInstallerCapabilities();
    const handoff = nextCardConnectionAction({ intent: 'blank-card', capabilities });
    const [releaseState, setReleaseState] = useState({ state: 'loading', release: null, error: '' });
    const [cardState, setCardState] = useState({ state: 'idle', hardware: null, error: '' });
    const [eraseConfirmed, setEraseConfirmed] = useState(false);
    const [progress, setProgress] = useState(0);
    const [installState, setInstallState] = useState('idle');
    const [releaseAttempt, setReleaseAttempt] = useState(0);
    const [commissioning, setCommissioning] = useState(readCardCommissioning);
    const loaderRef = useRef(null);
    const transportRef = useRef(null);
    const mountedRef = useRef(true);
    const findingRef = useRef(false);
    const installingRef = useRef(false);

    useEffect(() => {
      if (!capabilities.canWebSerialInstall) return undefined;
      let active = true;
      setReleaseState({ state: 'loading', release: null, error: '' });
      loadProductionFirmwareRelease()
        .then((release) => {
          validateProductionInstallRelease(release);
          if (active) setReleaseState({ state: 'ready', release, error: '' });
        })
        .catch((error) => {
          if (active) setReleaseState({ state: 'error', release: null, error: error?.message || String(error) });
        });
      return () => { active = false; };
    }, [capabilities.canWebSerialInstall, releaseAttempt]);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (!installingRef.current) disconnectESP(loaderRef.current, transportRef.current);
        loaderRef.current = null;
        transportRef.current = null;
      };
    }, []);

    useEffect(() => {
      if (installState !== 'installing') return undefined;
      const preventUnload = (event) => {
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', preventUnload);
      window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: true } }));
      return () => {
        window.removeEventListener('beforeunload', preventUnload);
        window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: false } }));
      };
    }, [installState]);

    const launchBridge = operation => launchBridgeOperation(operation, {
      persistProject: async () => {
        saveCurrentProjectToLibrary(serializeProject());
        markProjectPersisted('browser');
      },
      navigate: url => {
        const testNavigate = window.__LW_BRIDGE_NAVIGATE_FOR_TEST__;
        if (typeof testNavigate === 'function') testNavigate(url);
        else window.location.assign(url);
      },
    });

    if (!capabilities.canWebSerialInstall) return <UnsupportedInstall action={handoff} onLaunchBridge={launchBridge} />;

    const findCard = async () => {
      if (findingRef.current || installingRef.current) return;
      findingRef.current = true;
      setCardState({ state: 'finding', hardware: null, error: '' });
      setEraseConfirmed(false);
      try {
        const previous = transportRef.current
          ? { loader: loaderRef.current, transport: transportRef.current }
          : null;
        loaderRef.current = null;
        transportRef.current = null;
        const { connection, hardware } = await replaceInstallConnection({
          previous,
          connect: () => connectESP(),
          verify: async candidate => {
            const inspected = await inspectConnectedESP(candidate.loader, candidate.chip);
            return { ...inspected, ...validateInstallHardware(inspected) };
          },
          disconnect: candidate => disconnectESP(candidate?.loader, candidate?.transport),
        });
        if (!mountedRef.current) {
          await disconnectESP(connection.loader, connection.transport);
          return;
        }
        loaderRef.current = connection.loader;
        transportRef.current = connection.transport;
        setCardState({ state: 'ready', hardware, error: '' });
      } catch (error) {
        loaderRef.current = null;
        transportRef.current = null;
        setCardState({ state: 'error', hardware: null, error: error?.message || String(error) });
      } finally {
        findingRef.current = false;
      }
    };

    const install = async () => {
      if (!eraseConfirmed || cardState.state !== 'ready' || releaseState.state !== 'ready' || installingRef.current) return;
      installingRef.current = true;
      const { manifest, bytes } = releaseState.release;
      const file = new File([bytes], `lightweaver-${manifest.firmwareVersion}.bin`, { type: 'application/octet-stream' });
      setInstallState('installing');
      setProgress(0);
      try {
        const record = saveCurrentProjectToLibrary(serializeProject());
        markProjectPersisted('browser');
        const started = beginCardCommissioning({
          source: 'web-serial',
          operation: 'install-current-release',
          strategy: 'clean-recovery',
          projectRecord: record,
          projectRevision: projectLifecycle.editedRevision,
          installTarget: {
            id: cardState.hardware.cardId,
            firmwareVersion: releaseState.release.manifest.firmwareVersion,
            buildId: releaseState.release.manifest.buildId,
          },
        });
        writeCardCommissioning(started);
        setCommissioning(started);
        await flashFirmwareAndRelease({
          loader: loaderRef.current,
          transport: transportRef.current,
          file,
          address: 0,
          eraseAll: true,
          flashFirmware,
          onProgress: setProgress,
        });
        loaderRef.current = null;
        transportRef.current = null;
        installingRef.current = false;
        setProgress(1);
        const completed = completeCardInstall(started, {
          operation: 'install-current-release',
          cardId: cardState.hardware.cardId,
          firmwareVersion: releaseState.release.manifest.firmwareVersion,
          buildId: releaseState.release.manifest.buildId,
        });
        writeCardCommissioning(completed);
        setCommissioning(completed);
        setInstallState('complete');
      } catch (error) {
        loaderRef.current = null;
        transportRef.current = null;
        installingRef.current = false;
        setInstallState('error');
        setCardState({ state: 'error', hardware: null, error: `Installation stopped: ${error?.message || String(error)}. USB was released.` });
      }
    };

    if (installState === 'complete' || (commissioning?.source === 'web-serial' && commissioning.stage === 'install-safely' && installState !== 'installing')) {
      return (
        <div className="install-flow" aria-live="polite">
          <CardCommissioningPanel
            result={null}
            link={cardLink}
            onReconnect={() => onConnectCard?.()}
            readProjectEvidence={readCardProjectEvidence}
            readCandidateEvidence={readCardWiringCandidateEvidence}
          />
        </div>
      );
    }

    const releaseReady = releaseState.state === 'ready';
    return (
      <div className="install-flow" aria-live="polite">
        <CardCommissioningSteps stage={cardState.state === 'ready' || installState === 'installing' ? 'install-safely' : 'connect-card'} />
        <div>
          <div className="eyebrow">Safe automatic installer</div>
          <h1>Install Lightweaver</h1>
          <p>Plug the card into this computer by USB. Studio verifies the official firmware and checks the card before it can erase anything.</p>
        </div>

        <div className={`install-release ${releaseState.state}`} role="status">
          {releaseState.state === 'loading' && 'Verifying the official Lightweaver release…'}
          {releaseState.state === 'ready' && `Official Lightweaver ${releaseState.release.manifest.firmwareVersion} verified and ready.`}
          {releaseState.state === 'error' && `Official firmware could not be verified. Nothing can be installed. ${releaseState.error}`}
        </div>
        {releaseState.state === 'error' && (
          <button className="btn" type="button" onClick={() => setReleaseAttempt(attempt => attempt + 1)}>Retry official firmware</button>
        )}

        <div className="card install-card-check">
          <div>
            <h2>1. Find your connected card</h2>
            <p>Studio will ask which USB device to use, then confirm it is the correct ESP32-S3 card with 16 MB of flash.</p>
          </div>
          <button className="btn-lg" type="button" onClick={findCard} disabled={!releaseReady || cardState.state === 'finding' || installState === 'installing'}>
            {cardState.state === 'finding' ? 'Checking card…' : cardState.state === 'ready' ? 'Change connected card' : 'Find connected card'}
          </button>
          {cardState.state === 'ready' && (
            <div className="install-check-ok">Correct card found · ESP32-S3 · 16 MB</div>
          )}
          {cardState.state === 'error' && <div className="install-check-error" role="alert">{cardState.error}</div>}
        </div>

        {cardState.state === 'ready' && (
          <div className="card install-confirm">
            <h2>2. Confirm the reset</h2>
            <p>Installing Lightweaver erases the card's current firmware, Wi-Fi details, patterns, and settings. Your Studio project stays here.</p>
            <label>
              <input type="checkbox" checked={eraseConfirmed} onChange={(event) => setEraseConfirmed(event.target.checked)} />
              <span>I understand this will erase everything currently stored on this card.</span>
            </label>
            <button className="btn-lg" type="button" onClick={install} disabled={!eraseConfirmed || installState === 'installing'}>
              {installState === 'installing' ? `Installing… ${Math.round(progress * 100)}%` : 'Erase card and install Lightweaver'}
            </button>
          </div>
        )}

        {installState === 'installing' && (
          <div className="fl-bar" role="progressbar" aria-label="Installing Lightweaver" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress * 100)}>
            <div className="fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
    );
  }

  function FlashScreen(props) {
    const installMode = typeof window !== 'undefined' && new URLSearchParams(window.location.hash.slice(1)).get('mode') === 'install';
    return installMode ? <AutomaticInstallScreen {...props} /> : <TechnicianFlashScreen />;
  }

export { FlashScreen };
