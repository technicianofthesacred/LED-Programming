/* Lightweaver v3 — safe automatic installer + technician diagnostics. */
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { I } from './lw-shared.jsx';
import { connectESP, disconnectESP, flashFirmware, inspectConnectedESP, writeApplicationWithoutReset } from '../lib/flash.js';
import {
  FLASH_COMPLETE_RELEASED_LOG,
  FLASH_COMPLETE_RELEASED_STATUS,
  flashFirmwareAndRelease,
  resetEspIntoApp,
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
import { formatFirmwareBuildLabel, loadProductionFirmwareRelease } from '../lib/firmwareRelease.js';
import { SECURE_INSTALLER_URL, detectPlatformCapabilities } from '../lib/platformCapabilities.js';
import { nextCardConnectionAction } from '../lib/cardConnectionFlow.js';
import { createBridgeResultChannel, launchBridgeOperation, resumeBridgeReturnCode } from '../lib/bridgeLaunch.js';
import { saveCurrentProjectToLibraryGuarded } from '../lib/projectStorage.js';
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
import { observePostFlashNetwork } from '../lib/cardPostFlashNetwork.js';
import {
  cardSupportsNetworkFirmwareUpdate,
  describeFirmwareUpdate,
  normalizeFirmwareUpdateCard,
  resolveInstalledFirmware,
} from '../lib/firmwareUpdatePlan.js';
import { readPersistedCardIdentity } from '../lib/cardIdentity.js';
import { openInChrome } from '../lib/openInChrome.js';
import { loadVerifiedFirmwareUpdateRelease } from '../lib/firmwareUpdateRelease.js';
import {
  clearFirmwareUpdateSession,
  correlateFirmwareUpdateRecovery,
  createCardFirmwareUpdater,
  readFirmwareUpdateSession,
  readFirmwareUpdateStatus,
  saveFirmwareUpdateSession,
} from '../lib/cardFirmwareUpdater.js';
import { runPreservingUsbBootstrap } from '../lib/preservingUsbBootstrap.js';
import { getActiveCardTransportAuthority } from '../lib/cardTransport.js';
import {
  clearActiveUsbInspection,
  registerActiveUsbInspection,
} from '../lib/usbInspection.js';

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

  // Inspection runs in the ESP ROM loader. Closing Web Serial without a reset
  // leaves the card application and Wi-Fi stopped, so every non-flash exit
  // restarts the app before releasing the browser's port handle.
  async function releaseInspectedConnection(loader, transport) {
    if (!loader && !transport) return true;
    try { await resetEspIntoApp(transport, loader); } catch { /* reset may tear down USB after succeeding */ }
    return disconnectESP(loader, transport);
  }

  function TechnicianFlashScreen({ embedded = false } = {}) {
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
    const [chromeFallback, setChromeFallback] = useState("");

    const logRef = useRef(null);
    const loaderRef = useRef(null);
    const transportRef = useRef(null);
    const fileInputRef = useRef(null);

    const append = (line) => setLog((p) => p + line + "\n");
    useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

    const copyCurrentUrl = async (url) => {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
    };

    const launchInChrome = () => {
      setChromeFallback("");
      openInChrome({
        currentUrl: window.location.href,
        copyText: copyCurrentUrl,
        launch: (url) => { window.location.href = url; },
        isPageVisible: () => document.visibilityState === 'visible',
        onFallback: setChromeFallback,
      });
    };

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

    const TechnicianHeading = embedded ? 'h2' : 'h1';

    return (
      <div className={embedded ? 'technician-embedded' : 'screen'}>
        <div className={embedded ? 'technician-embedded-scroll' : 'screen-scroll'}>
          <div className="technician-disclosure">
            <div className="technician-disclosure-label">Technician diagnostics</div>
            <div className="fl">
            <div>
              <div className="eyebrow">Advanced tools</div>
              <TechnicianHeading className="flash-screen-title">Manual firmware tools</TechnicianHeading>
              <p className="flash-screen-intro">Manual firmware files, offsets, erase controls, and the serial log are kept here for trained repair work.</p>
            </div>
            <div className={"fl-warn " + (hasWebSerial ? "ok" : "warn")}>
              <span style={ICON16}>{I.info}</span>
              {hasWebSerial ? (
                <div>The card ships pre-flashed with Lightweaver firmware. Use this only for blank ESP32-S3 boards or a firmware replacement.</div>
              ) : (
                <div className="fl-warn-copy">
                  <span>Open this page in Chrome to flash your card.</span>
                  <button className="btn primary" type="button" onClick={launchInChrome}>Open in Chrome</button>
                  {chromeFallback && <span className="fl-warn-feedback" role="status">{chromeFallback}</span>}
                </div>
              )}
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
          </div>
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

  function UnsupportedInstall({ action, onLaunchBridge, embedded = false }) {
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

    const UnsupportedHeading = embedded ? 'h2' : 'h1';

    return (
      <div className="card install-handoff" role="status">
        <div className="eyebrow">Your project is safe in Studio</div>
        <UnsupportedHeading>{bridgeLifecycleState === 'installer-unavailable' ? 'Signed Bridge installer unavailable' : action.title}</UnsupportedHeading>
        <p>{action.explanation}</p>
        <ol>
          <li>{firstStep}</li>
          <li>Open this project, then choose <strong>Connect card</strong> and <strong>Blank or not responding</strong>.</li>
          <li>Plug the Lightweaver card into that computer by USB.</li>
        </ol>
        {showSecureInstaller && (
          <>
            <p>Your browser only allows USB install from a separate secure top-level tab, so the button below continues in the Lightweaver Studio tab.</p>
            {/* Stable named target ('lightweaver-studio', the same name the
                firmware card page uses for its Studio opens) so repeated
                clicks reuse one Studio tab instead of minting a new unnamed
                tab each time. */}
            <a className="btn-lg" href={SECURE_INSTALLER_URL} target="lightweaver-studio" rel="noopener noreferrer">Open secure installer</a>
          </>
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
                  // Unsupported browsers may hand the card to Bridge for a
                  // read-only inspection, but must never turn a routine update
                  // into the legacy destructive factory installer.
                  await onLaunchBridge('inspect-compatible-card');
                  setBridgeState('waiting-for-bridge');
                } catch { setBridgeState('error'); }
              }}
            >
              {bridgeState === 'opening' || bridgeState === 'waiting-for-bridge' ? 'Waiting for Lightweaver Bridge…' : bridgeState === 'return-pending' ? 'Return pending…' : 'Open Lightweaver Bridge'}
            </button>
            {bridgeState === 'waiting-for-bridge' && <p>Bridge can inspect the exact card without erasing it. Complete the preserving update in Chrome or another browser with USB support. Keep this tab available, or paste the one-time return code below.</p>}
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

  const UPDATE_PHASE_LABELS = Object.freeze({
    idle: '', confirming: '', preflight: 'Preparing card', sending: 'Sending signed update',
    verifying: 'Verifying update', restarting: 'Restarting card', reconnected: 'Reconnected',
    probation: 'Checking card health', valid: 'Update valid',
  });

  function PreservingUpdatePanel({
    mode,
    card,
    readiness,
    release,
    loaderRef,
    transportRef,
    onUsbReleased,
    onReconnectCard,
    reconnectHost = '',
  }) {
    const [confirming, setConfirming] = useState(false);
    const [physicalConfirmed, setPhysicalConfirmed] = useState(false);
    const [phase, setPhase] = useState('idle');
    const [acknowledgedBytes, setAcknowledgedBytes] = useState(0);
    const [error, setError] = useState('');
    const [rollback, setRollback] = useState(null);
    const [observedUpdateStatus, setObservedUpdateStatus] = useState(null);
    const rolledBackRef = useRef(false);
    const target = release?.manifest;
    const actionLabel = mode === 'wifi' ? 'Update over Wi-Fi' : 'Update once over USB';
    const phaseLabel = mode === 'usb' && phase === 'verifying'
      ? 'Upload complete · checking the saved update'
      : UPDATE_PHASE_LABELS[phase] || '';
    const installedLabel = card.recovering
      ? 'Checking restarted card…'
      : `${card.firmwareVersion || 'unknown'} · ${formatFirmwareBuildLabel(card)}`;
    const targetLabel = target ? `${target.firmwareVersion} · ${formatFirmwareBuildLabel(target)}` : 'Verifying signed release…';
    const onProgress = event => {
      setAcknowledgedBytes(Number(event?.acknowledgedBytes || 0));
      if (event?.phase === 'preflight') setPhase('preflight');
      else if (event?.phase === 'sending') setPhase('sending');
      else if (event?.phase === 'verifying') setPhase('verifying');
      else if (event?.phase === 'restarting' || event?.phase === 'pending-reboot') setPhase('restarting');
      else if (event?.phase === 'probation') setPhase('probation');
      else if (event?.phase === 'valid') setPhase('restarting');
      else if (event?.phase === 'rolled-back') {
        rolledBackRef.current = true;
        setRollback({
          restoredBuildNumber: Number(event.restoredBuildNumber) || null,
          reason: String(event.rollbackReason || 'health-check-failed').slice(0, 96),
        });
        setPhase('rolled-back');
      }
    };

    useEffect(() => {
      if (!target) return;
      const session = readFirmwareUpdateSession();
      if (!session || session.cardId !== card.id
        || session.targetBuildId !== target.buildId
        || session.targetFirmwareVersion !== target.firmwareVersion) return;
      const result = correlateFirmwareUpdateRecovery(
        session,
        readiness?.firmwareUpdate || observedUpdateStatus || {},
        readiness || {},
      );
      if (result.phase === 'rolled-back') {
        rolledBackRef.current = true;
        setRollback({ restoredBuildNumber: result.restoredBuildNumber, reason: result.reason });
        setPhase('rolled-back');
      } else if (result.phase === 'probation') {
        setPhase('probation');
      } else if (result.ok && result.phase === 'valid') {
        setPhase('reconnected');
        clearFirmwareUpdateSession();
      } else if (['restarting', 'pending-reboot', 'probation', 'valid', 'rolled-back'].includes(session.phase)) {
        setPhase(session.phase === 'probation' ? 'probation' : 'restarting');
      }
    }, [card.id, observedUpdateStatus, readiness, target]);

    useEffect(() => {
      const session = readFirmwareUpdateSession();
      if (!session || !target || session.cardId !== card.id || session.targetBuildId !== target.buildId) return undefined;
      const authority = getActiveCardTransportAuthority(readiness?.host || '')
        || getActiveCardTransportAuthority();
      if (!authority) return undefined;
      let active = true;
      readFirmwareUpdateStatus(authority)
        .then(status => { if (active) setObservedUpdateStatus(status); })
        .catch(() => {});
      return () => { active = false; };
    }, [card.id, readiness?.host, target]);

    useEffect(() => {
      if (phase !== 'restarting') return undefined;
      const configured = import.meta.env.DEV ? Number(window.__LW_PRESERVING_RECONNECT_TIMEOUT_MS__) : 0;
      const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : 45_000;
      const timer = window.setTimeout(() => {
        setError('Studio could not verify the restarted card in time. Keep the card powered, reconnect this exact card, and resume the preserving update check. Your saved card data was not erased.');
        setConfirming(false);
        setPhysicalConfirmed(false);
        setPhase('idle');
      }, timeoutMs);
      return () => window.clearTimeout(timer);
    }, [phase]);

    const start = async () => {
      if (!physicalConfirmed || !release) return;
      setError('');
      setPhase('preflight');
      try {
        if (mode === 'wifi') {
          const testFactory = import.meta.env.DEV && window.__LW_CREATE_FIRMWARE_UPDATER_FOR_TEST__;
          const authority = getActiveCardTransportAuthority(readiness?.host || '')
            || getActiveCardTransportAuthority();
          if (!testFactory && !authority) throw new Error('Reconnect this exact card before updating over Wi-Fi.');
          if (!testFactory && !authority.ownerCapability) {
            await authority.issueOwnerCapability({
              commissioningProof: 'owner-confirmed-physical-control',
              expectedProjectHead: readiness?.projectHead || authority.projectHead,
            });
          }
          const makeUpdater = testFactory || createCardFirmwareUpdater;
          const physicalConfirmationNonce = globalThis.crypto?.randomUUID?.()
            || `physical-${Date.now()}-${Math.random()}`;
          const updater = makeUpdater({
            authority,
            release,
            physicalConfirmation: physicalConfirmationNonce,
            projectFingerprint: readiness?.projectFingerprint || '',
            onProgress,
          });
          await updater.preflight();
          await updater.begin();
          await updater.send();
          setPhase('verifying');
          await updater.commit();
          if (!rolledBackRef.current) {
            setPhase('restarting');
            try { await updater.readStatus(); } catch { /* reboot can close the committed request path */ }
          }
        } else {
          const usbSession = {
            mode: 'usb',
            cardId: card.id,
            previousBootId: readiness?.cardId === card.id ? readiness.bootId || '' : '',
            expectedProjectHead: readiness?.cardId === card.id ? readiness.projectHead || '' : '',
            expectedProjectFingerprint: readiness?.cardId === card.id ? readiness.projectFingerprint || '' : '',
            targetFirmwareVersion: target.firmwareVersion,
            targetBuildId: target.buildId,
            targetBuildNumber: target.buildNumber,
            ticketSha256: release.ticketSha256,
            phase: 'sending',
            acknowledgedBytes: 0,
          };
          saveFirmwareUpdateSession(usbSession);
          const testBootstrap = import.meta.env.DEV && window.__LW_RUN_PRESERVING_USB_BOOTSTRAP_FOR_TEST__;
          const runBootstrap = testBootstrap || runPreservingUsbBootstrap;
          await runBootstrap({
            loader: loaderRef.current,
            transport: transportRef.current,
            evidence: {
              ...card,
              chipName: card.chipName,
              flashBytes: card.flashBytes,
              source: card.source,
              installedAppOffset: 0x10000,
            },
            release,
            writeApplication: writeApplicationWithoutReset,
            resetIntoApp: resetEspIntoApp,
            disconnect: disconnectESP,
            onProgress: event => {
              setPhase(event.phase === 'updating' ? 'sending' : event.phase);
              setAcknowledgedBytes(Math.round((event.progress || 0) * release.imageBytes.byteLength));
            },
          });
          saveFirmwareUpdateSession({
            ...usbSession,
            phase: 'restarting',
            acknowledgedBytes: release.imageBytes.byteLength,
          });
          loaderRef.current = null;
          transportRef.current = null;
          onUsbReleased?.();
          setPhase('restarting');
          try { await onReconnectCard?.(reconnectHost); } catch { /* bounded status wait reports the actionable failure */ }
        }
      } catch (cause) {
        setError(cause?.message || String(cause));
        setPhase('idle');
      }
    };

    return (
      <section className="card install-action-card preserving-update-panel" data-testid="preserving-update-panel" aria-live="polite">
        <div className="install-action-copy">
          <div className="eyebrow">Preserving firmware update</div>
          <h2>{mode === 'wifi' ? 'Update this card over Wi-Fi' : 'One-time USB update for this card'}</h2>
          <p><strong>Keeps Wi-Fi, project, patterns, wiring, and settings.</strong>{mode === 'usb' ? ' Future updates use Wi-Fi.' : ''}</p>
          <dl className="card-acknowledged-facts">
            <dt>Card</dt><dd>{card.id}</dd>
            <dt>Installed</dt><dd>{installedLabel}</dd>
            <dt>Update</dt>
            <dd className="preserving-update-target">
              <span>{targetLabel}</span>
              {!confirming && phase === 'idle' && (
                <button className="btn preserving-update-inline-action" type="button" disabled={!release} onClick={() => setConfirming(true)}>{actionLabel}</button>
              )}
            </dd>
            {readiness?.projectHead && <><dt>Project head</dt><dd>{readiness.projectHead}</dd></>}
          </dl>
        </div>
        {confirming && phase === 'idle' && (
          <div className="install-confirm-action">
            <p>Press the card control once, then confirm below. Studio binds this update to this exact card and project.</p>
            <label>
              <input type="checkbox" checked={physicalConfirmed} onChange={event => setPhysicalConfirmed(event.target.checked)} />
              <span>I physically confirmed this exact Lightweaver card.</span>
            </label>
            <button className="btn-lg" type="button" disabled={!physicalConfirmed} onClick={start}>Start preserving update</button>
          </div>
        )}
        {phaseLabel && (
          <div className="install-release ready" role="status">
            <strong>{phaseLabel}</strong>
            {phase === 'sending' && release && <span> · {acknowledgedBytes} of {release.imageBytes.byteLength} bytes acknowledged by the card</span>}
            {phase === 'reconnected' && <span> to Card {card.id} on firmware {targetLabel}</span>}
          </div>
        )}
        {error && <div className="install-check-error" role="alert">{error}</div>}
        {rollback && (
          <div className="install-check-error" role="alert">
            <strong>Update rolled back.</strong> The card restored Build {rollback.restoredBuildNumber || 'unknown'}. Reason: {rollback.reason}.
          </div>
        )}
      </section>
    );
  }

  function AutomaticInstallScreen({ cardLink = {}, onConnectCard, onCommissioningComplete, persistCurrentProjectToBrowser, embedded = false }) {
    const { serializeProject, flushProjectAutosave, markProjectPersisted, projectLifecycle } = useProject();
    const capabilities = detectInstallerCapabilities();
    const preservingFixture = import.meta.env.DEV ? window.__LW_PRESERVING_UPDATE_FIXTURE__ || null : null;
    const handoff = nextCardConnectionAction({ intent: 'blank-card', capabilities });
    const [releaseState, setReleaseState] = useState({ state: 'loading', release: null, error: '' });
    const [updateReleaseState, setUpdateReleaseState] = useState({ state: 'loading', release: null, error: '' });
    const [cardState, setCardState] = useState({ state: 'idle', hardware: null, error: '' });
    const [eraseConfirmed, setEraseConfirmed] = useState(false);
    const [progress, setProgress] = useState(0);
    const [installState, setInstallState] = useState('idle');
    const [releaseAttempt, setReleaseAttempt] = useState(0);
    const [commissioning, setCommissioning] = useState(readCardCommissioning);
    // What the card is running NOW, so the screen can say which direction this
    // install moves it. A live link is the best account; a remembered identity
    // is used only when it belongs to the card actually plugged in.
    const installedFirmware = useMemo(() => resolveInstalledFirmware({
        linkedCard: cardLink?.card,
        rememberedCard: readPersistedCardIdentity(),
        hardware: cardState.hardware,
      }), [cardLink?.card, cardState.hardware]);
    const updatePlan = useMemo(() => describeFirmwareUpdate({
      installed: installedFirmware,
      available: releaseState.state === 'ready' ? releaseState.release.manifest : null,
    }), [installedFirmware, releaseState]);
    const installedEvidenceLabel = installedFirmware?.source === 'usb-flash'
      ? 'read directly from this card over USB'
      : installedFirmware === cardLink?.card
        ? 'live card connection'
        : installedFirmware ? 'last verified for this exact card' : '';
    const updateReadiness = preservingFixture?.readiness || cardLink?.readiness || null;
    const connectedCardCandidate = preservingFixture?.card || cardLink?.card || null;
    const connectedUpdateCard = cardSupportsNetworkFirmwareUpdate(updateReadiness) && connectedCardCandidate
      ? { ...connectedCardCandidate, bootId: updateReadiness.bootId, projectHead: updateReadiness.projectHead }
      : null;
    const usbUpdateCard = (cardState.state === 'ready' || cardState.state === 'reconnecting')
      && cardState.hardware?.source === 'usb-flash'
      ? normalizeFirmwareUpdateCard({ ...cardState.hardware, ...installedFirmware })
      : null;
    const recoverySession = readFirmwareUpdateSession();
    const recoveryTarget = updateReleaseState.state === 'ready' ? updateReleaseState.release.manifest : null;
    const recoveryCard = recoverySession && recoveryTarget
      && recoverySession.targetBuildId === recoveryTarget.buildId
      && recoverySession.targetFirmwareVersion === recoveryTarget.firmwareVersion
      ? normalizeFirmwareUpdateCard({
          cardId: recoverySession.cardId,
          firmwareVersion: recoverySession.targetFirmwareVersion,
          buildId: recoverySession.targetBuildId,
          buildNumber: recoverySession.targetBuildNumber,
          bootId: recoverySession.previousBootId,
          projectHead: recoverySession.expectedProjectHead,
          projectFingerprint: recoverySession.expectedProjectFingerprint,
          recovering: true,
        })
      : null;
    const preservingMode = preservingFixture?.mode
      || (connectedUpdateCard ? 'wifi'
        : usbUpdateCard && updateReleaseState.state === 'ready' ? 'usb'
          : recoveryCard ? (recoverySession.mode === 'usb' ? 'usb' : 'wifi') : '');
    const preservingCard = connectedUpdateCard || usbUpdateCard
      || (preservingFixture?.mode === 'usb' ? preservingFixture.card : null)
      || recoveryCard;
    const loaderRef = useRef(null);
    const transportRef = useRef(null);
    const inspectionRef = useRef(null);
    const mountedRef = useRef(true);
    const findingRef = useRef(false);
    const installingRef = useRef(false);
    const browserAssociationRef = useRef(null);
    const InstallHeading = embedded ? 'h2' : 'h1';

    const releaseHeldInspection = async ({ clearRegistry = false } = {}) => {
      if (installingRef.current) return false;
      const token = inspectionRef.current;
      if (clearRegistry && token) clearActiveUsbInspection(token);
      const loader = loaderRef.current;
      const transport = transportRef.current;
      const released = await releaseInspectedConnection(loader, transport);
      if (!released) return false;
      if (inspectionRef.current === token) inspectionRef.current = null;
      if (loaderRef.current === loader) loaderRef.current = null;
      if (transportRef.current === transport) transportRef.current = null;
      if (mountedRef.current) setCardState({ state: 'idle', hardware: null, error: '' });
      return true;
    };

    const persistProject = async () => {
      const project = serializeProject();
      if (flushProjectAutosave() !== true) {
        throw new Error('Studio could not create a browser recovery copy before installing.');
      }
      const result = persistCurrentProjectToBrowser
        ? await persistCurrentProjectToBrowser(project)
        : await saveCurrentProjectToLibraryGuarded(project, browserAssociationRef.current
          ? { expectedAssociationSnapshot: browserAssociationRef.current }
          : {});
      if (!result?.ok) {
        const error = new Error(result?.reason === 'browser-conflict'
          ? 'Another tab saved a newer browser copy. Reopen that copy before installing.'
          : 'Studio could not safely save this project in the browser.');
        error.reason = result?.reason;
        throw error;
      }
      browserAssociationRef.current = result.associationSnapshot;
      markProjectPersisted('browser');
      return result.record;
    };

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
      let active = true;
      const testLoader = import.meta.env.DEV && window.__LW_LOAD_UPDATE_RELEASE_FOR_TEST__;
      const loading = testLoader ? testLoader() : loadVerifiedFirmwareUpdateRelease();
      Promise.resolve(loading)
        .then(release => { if (active) setUpdateReleaseState({ state: 'ready', release, error: '' }); })
        .catch(error => { if (active) setUpdateReleaseState({ state: 'error', release: null, error: error?.message || String(error) }); });
      return () => { active = false; };
    }, [releaseAttempt]);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (!installingRef.current) void releaseHeldInspection({ clearRegistry: true });
      };
    }, []);

    useEffect(() => {
      // 'observing' still holds the card's USB port open to read its boot log,
      // so it is as unsafe to navigate away from as the write itself.
      if (installState !== 'installing' && installState !== 'observing') return undefined;
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
        await persistProject();
      },
      navigate: url => {
        const testNavigate = window.__LW_BRIDGE_NAVIGATE_FOR_TEST__;
        if (typeof testNavigate === 'function') testNavigate(url);
        else window.location.assign(url);
      },
    });

    if (!capabilities.canWebSerialInstall && !preservingFixture && preservingMode !== 'wifi') {
      return <UnsupportedInstall action={handoff} onLaunchBridge={launchBridge} embedded={embedded} />;
    }

    const findCard = async () => {
      if (findingRef.current || installingRef.current) return;
      findingRef.current = true;
      setCardState({ state: 'finding', hardware: null, error: '' });
      setEraseConfirmed(false);
      try {
        const previous = transportRef.current
          ? { loader: loaderRef.current, transport: transportRef.current }
          : null;
        if (inspectionRef.current) clearActiveUsbInspection(inspectionRef.current);
        inspectionRef.current = null;
        loaderRef.current = null;
        transportRef.current = null;
        const testFindCard = import.meta.env.DEV && typeof window.__LW_FIND_INSTALL_CARD_FOR_TEST__ === 'function'
          ? window.__LW_FIND_INSTALL_CARD_FOR_TEST__
          : null;
        const { connection, hardware } = testFindCard
          ? await testFindCard()
          : await replaceInstallConnection({
          previous,
          connect: () => connectESP(),
          verify: async candidate => {
            const inspected = await inspectConnectedESP(candidate.loader, candidate.chip);
            return { ...inspected, ...validateInstallHardware(inspected) };
          },
          disconnect: candidate => releaseInspectedConnection(candidate?.loader, candidate?.transport),
          });
        if (!mountedRef.current) {
          await releaseInspectedConnection(connection.loader, connection.transport);
          return;
        }
        loaderRef.current = connection.loader;
        transportRef.current = connection.transport;
        inspectionRef.current = registerActiveUsbInspection({
          cardId: hardware.cardId,
          release: () => releaseHeldInspection(),
        });
        setCardState({ state: 'ready', hardware, error: '' });
      } catch (error) {
        if (inspectionRef.current) clearActiveUsbInspection(inspectionRef.current);
        inspectionRef.current = null;
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
      if (inspectionRef.current) clearActiveUsbInspection(inspectionRef.current);
      inspectionRef.current = null;
      const { manifest, bytes } = releaseState.release;
      const file = new File([bytes], `lightweaver-${manifest.firmwareVersion}.bin`, { type: 'application/octet-stream' });
      setInstallState('installing');
      setProgress(0);
      let handedToFlashWorkflow = false;
      try {
        const record = await persistProject();
        const started = beginCardCommissioning({
          source: 'web-serial',
          operation: 'install-current-release',
          strategy: 'clean-recovery',
          projectRecord: record,
          projectRevision: projectLifecycle.editedRevision,
          projectGeneration: projectLifecycle.generation,
          installTarget: {
            id: cardState.hardware.cardId,
            firmwareVersion: releaseState.release.manifest.firmwareVersion,
            buildId: releaseState.release.manifest.buildId,
          },
        });
        await writeCardCommissioning(started);
        setCommissioning(started);
        // Keep the granted Web Serial port: flashFirmwareAndRelease closes the
        // esptool transport, but the permission survives, so the same port can
        // be reopened at 115200 to watch the card narrate its own boot.
        const serialPort = transportRef.current?.device || null;
        handedToFlashWorkflow = true;
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
        // Flashing does not always clear NVS. A card whose saved Wi-Fi survives
        // boots onto the LAN and never raises a setup hotspot, so Studio has to
        // observe what actually happened instead of asserting AP mode. This
        // never throws: an unusable port degrades to 'inconclusive'.
        setInstallState('observing');
        const observe = typeof window.__LW_OBSERVE_POST_FLASH_NETWORK_FOR_TEST__ === 'function'
          ? window.__LW_OBSERVE_POST_FLASH_NETWORK_FOR_TEST__
          : observePostFlashNetwork;
        const postFlashNetwork = await observe({ port: serialPort });
        const completed = completeCardInstall(started, {
          operation: 'install-current-release',
          cardId: cardState.hardware.cardId,
          firmwareVersion: releaseState.release.manifest.firmwareVersion,
          buildId: releaseState.release.manifest.buildId,
          postFlashNetwork,
        });
        await writeCardCommissioning(completed);
        setCommissioning(completed);
        setInstallState('complete');
      } catch (error) {
        if (!handedToFlashWorkflow) {
          await releaseInspectedConnection(loaderRef.current, transportRef.current);
        }
        loaderRef.current = null;
        transportRef.current = null;
        installingRef.current = false;
        setInstallState('error');
        setCardState({ state: 'error', hardware: null, error: `Installation stopped: ${error?.message || String(error)}. USB was released.` });
      }
    };

    const hasResumableCommissioning = commissioning
      && (commissioning.stage === 'set-up-card' || commissioning.stage === 'check-lights');
    if (installState === 'complete' || hasResumableCommissioning || (commissioning?.source === 'web-serial' && commissioning.stage === 'install-safely' && installState !== 'installing' && installState !== 'observing')) {
      return (
        <div className={`install-flow${embedded ? ' embedded' : ''}`} aria-live="polite">
          <CardCommissioningPanel
            result={null}
            link={cardLink}
            onReconnect={(host) => onConnectCard?.(host)}
            onComplete={onCommissioningComplete}
            readProjectEvidence={readCardProjectEvidence}
            readCandidateEvidence={readCardWiringCandidateEvidence}
          />
        </div>
      );
    }

    const releaseReady = releaseState.state === 'ready';
    return (
      <div className={`install-flow${embedded ? ' embedded' : ''}`} aria-live="polite">
        <div className="install-task">
          <CardCommissioningSteps stage={cardState.state === 'ready' || installState === 'installing' || installState === 'observing' ? 'install-safely' : 'connect-card'} />

          <header className="install-intro">
            <div className="eyebrow">Safe automatic installer</div>
            <InstallHeading>{preservingMode ? 'Update Lightweaver' : 'Install Lightweaver'}</InstallHeading>
            <p>{preservingMode
              ? 'Studio verifies the signed update and keeps this card’s Wi-Fi, project, patterns, wiring, and settings.'
              : 'Plug the card into this computer by USB. Studio verifies the official firmware and checks the card before it can erase anything.'}</p>
            <div className={`install-release ${releaseState.state}`} role="status">
              {releaseState.state === 'loading' && 'Verifying the official Lightweaver release…'}
              {releaseState.state === 'ready' && `Official Lightweaver ${releaseState.release.manifest.firmwareVersion} · ${formatFirmwareBuildLabel(releaseState.release.manifest)} verified and ready.`}
              {releaseState.state === 'error' && `Official firmware could not be verified. Nothing can be installed. ${releaseState.error}`}
            </div>
            {releaseState.state === 'error' && (
              <button className="btn" type="button" onClick={() => setReleaseAttempt(attempt => attempt + 1)}>Retry official firmware</button>
            )}
          </header>

          {preservingMode && preservingCard && (
            <PreservingUpdatePanel
              mode={preservingMode}
              card={preservingCard}
              readiness={updateReadiness}
              release={updateReleaseState.state === 'ready' ? updateReleaseState.release : null}
              loaderRef={loaderRef}
              transportRef={transportRef}
              onUsbReleased={() => setCardState(previous => ({
                state: 'reconnecting', hardware: previous.hardware, error: '',
              }))}
              onReconnectCard={onConnectCard}
              reconnectHost={cardLink?.host || updateReadiness?.host || ''}
            />
          )}
          {preservingMode && updateReleaseState.state === 'error' && (
            <div className="install-check-error" role="alert">Signed preserving update unavailable. {updateReleaseState.error}</div>
          )}

          {/* Explain exactly what this install does to the connected card. */}
          {!preservingMode && updatePlan.headline && (
            <div className={`install-update-plan is-${updatePlan.state}`} data-testid="install-update-plan" role="status">
              <p className="install-update-headline">{updatePlan.headline}</p>
              <p className="install-update-caution">{updatePlan.caution}</p>
            </div>
          )}

          {preservingMode !== 'wifi' && (
          <section className="card install-action-card install-card-check">
            <div className="install-action-copy">
              <h2>Find your connected card</h2>
              <p>Studio will ask which USB device to use, then confirm it is the correct ESP32-S3 card with 16 MB of flash.</p>
            </div>
            <button className="btn-lg" type="button" onClick={findCard} disabled={!releaseReady || cardState.state === 'finding' || installState === 'installing' || installState === 'observing'}>
              {cardState.state === 'finding' ? 'Checking card and firmware…' : cardState.state === 'ready' ? 'Change connected card' : 'Find connected card'}
            </button>
            {cardState.state === 'ready' && (
              <div className="install-check-ok" data-testid="install-card-identity">
                <strong>Correct card found</strong>
                <dl>
                  <dt>Card</dt><dd>{cardState.hardware.cardId}</dd>
                  <dt>Hardware</dt><dd>ESP32-S3 · 16 MB</dd>
                  <dt>Installed firmware</dt>
                  <dd>{installedFirmware
                    ? `v${installedFirmware.firmwareVersion || 'unknown'} · ${formatFirmwareBuildLabel(installedFirmware)} (${installedEvidenceLabel})`
                    : 'Unknown — USB confirms the card hardware, not the firmware stored on it.'}</dd>
                  <dt>Current firmware</dt>
                  <dd>{releaseState.state === 'ready'
                    ? `v${releaseState.release.manifest.firmwareVersion} · ${formatFirmwareBuildLabel(releaseState.release.manifest)}`
                    : 'Unavailable'}</dd>
                </dl>
              </div>
            )}
            {cardState.state === 'error' && <div className="install-check-error" role="alert">{cardState.error}</div>}
          </section>
          )}

          {cardState.state === 'ready' && !preservingMode && (
            <section className="card install-action-card install-confirm">
              <div className="install-action-copy">
                <h2>Confirm the reset</h2>
                <p>Installing Lightweaver erases the card's current firmware, Wi-Fi details, patterns, and settings. Your Studio project stays here.</p>
              </div>
              <label>
                <input type="checkbox" checked={eraseConfirmed} onChange={(event) => setEraseConfirmed(event.target.checked)} />
                <span>I understand this will erase everything currently stored on this card.</span>
              </label>
              <div className="install-confirm-action">
                <button className="btn-lg" type="button" onClick={install} disabled={!eraseConfirmed || installState === 'installing' || installState === 'observing'}>
                  {installState === 'installing'
                    ? `Installing… ${Math.round(progress * 100)}%`
                    : installState === 'observing'
                      ? 'Checking how the card restarted…'
                      : 'Erase card and install Lightweaver'}
                </button>
                {installState === 'installing' && (
                  <div className="fl-bar" role="progressbar" aria-label="Installing Lightweaver" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress * 100)}>
                    <div className="fill" style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                )}
              </div>
            </section>
          )}

          {preservingMode && (
            <details className="card install-action-card install-factory-recovery">
              <summary>Factory reset and reinstall</summary>
              <p><strong>Destructive recovery:</strong> this permanently removes Wi-Fi, projects, patterns, wiring, and settings from the card. Preserving update failures never start this automatically.</p>
              {cardState.state === 'ready' && (
                <div className="install-confirm">
                  <label>
                    <input type="checkbox" checked={eraseConfirmed} onChange={(event) => setEraseConfirmed(event.target.checked)} />
                    <span>I understand this factory recovery erases everything currently stored on this card.</span>
                  </label>
                  <button className="btn" type="button" onClick={install} disabled={!eraseConfirmed || installState === 'installing' || installState === 'observing'}>
                    {installState === 'installing' ? `Factory reinstalling… ${Math.round(progress * 100)}%` : 'Erase card and reinstall'}
                  </button>
                </div>
              )}
            </details>
          )}

          {installState === 'observing' && (
            <div className="install-release ready install-observing" role="status">
              Installed. Watching this card restart over USB so Studio knows whether it starts its setup hotspot or rejoins a Wi-Fi network it already had. Keep the USB cable connected.
            </div>
          )}
        </div>
      </div>
    );
  }

  function FlashScreen(props) {
    const installMode = typeof window !== 'undefined' && new URLSearchParams(window.location.hash.slice(1)).get('mode') === 'install';
    return installMode ? <AutomaticInstallScreen {...props} /> : <TechnicianFlashScreen />;
  }

export { AutomaticInstallScreen, FlashScreen, TechnicianFlashScreen };
