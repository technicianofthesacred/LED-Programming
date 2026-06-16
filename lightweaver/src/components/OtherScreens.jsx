import { useState, useRef, useEffect } from 'react';
import { connectESP, disconnectESP, flashFirmware } from '../lib/flash.js';
import { DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS, DEFAULT_WLED_APP_FLASH_ADDRESS, validateFlashPlan } from '../lib/flashPlan.js';
import { FLASH_COMPLETE_RELEASED_LOG, FLASH_COMPLETE_RELEASED_STATUS, flashFirmwareAndRelease } from '../lib/flashWorkflow.js';

// NOTE: This file previously also exported LayoutScreen and ExportScreen. Those
// were dead (App.jsx imports the live LayoutScreen from LayoutScreen.jsx and
// only pulls FlashScreen from here). The dead LayoutScreen injected imported SVG
// markup via dangerouslySetInnerHTML (an unsanitized XSS sink), so it was
// removed along with its helpers. The live LayoutScreen.jsx reconstructs SVG
// paths through escapeAttr instead of raw innerHTML.

// ── Flash screen ──────────────────────────────────────────────────────
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const LIGHTWEAVER_FIRMWARE_URL = '/firmware/lightweaver-controller-esp32s3-factory.bin';
const LIGHTWEAVER_FIRMWARE_NAME = 'lightweaver-controller-esp32s3-factory.bin';

// ESP32 firmware images begin with the magic byte 0xE9. A factory image is also
// far larger than ~100KB. Cloudflare Pages serves the SPA index.html (HTTP 200)
// for missing asset paths, so a "successful" fetch can quietly return HTML —
// flashing that to an erased chip bricks it. Validate before accepting a binary.
const ESP_IMAGE_MAGIC = 0xe9;
const MIN_FIRMWARE_BYTES = 100 * 1024;

async function assertPlausibleEspImage(blob) {
  if (!blob || blob.size < MIN_FIRMWARE_BYTES) {
    throw new Error(`firmware download looks invalid (only ${fmtSize(blob?.size || 0)}; expected a multi-MB ESP32 image)`);
  }
  const firstByte = new Uint8Array(await blob.slice(0, 1).arrayBuffer())[0];
  if (firstByte !== ESP_IMAGE_MAGIC) {
    throw new Error('firmware download looks invalid (not an ESP32 image — the server may have returned an error page)');
  }
}

function formatFlashResetMode(mode) {
  if (mode === 'default_reset') return 'auto reset';
  if (mode === 'usb_reset') return 'USB reset';
  if (mode === 'no_reset') return 'manual BOOT mode';
  return mode;
}

export function FlashScreen() {
  const hasWebSerial = typeof navigator !== 'undefined' && 'serial' in navigator;

  const [connected, setConnected]     = useState(false);
  const [connecting, setConnecting]   = useState(false);
  const [flashing, setFlashing]       = useState(false);
  const [progress, setProgress]       = useState(0);
  const [status, setStatus]           = useState('');
  const [statusKind, setStatusKind]   = useState('');
  const [log, setLog]                 = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [address, setAddress]         = useState(DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS);
  const [eraseAll, setEraseAll]       = useState(true);
  const [loadingBundledFirmware, setLoadingBundledFirmware] = useState(false);

  const loaderRef    = useRef(null);
  const transportRef = useRef(null);
  const fileInputRef = useRef(null);
  const logRef       = useRef(null);

  const appendLog = (line) => {
    setLog(prev => prev + line + '\n');
    setTimeout(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, 0);
  };

  const setStatusMsg = (msg, kind = '') => {
    setStatus(msg);
    setStatusKind(kind);
  };

  // Serial lifecycle: reflect physical USB unplug in the UI, and release the
  // port if the component unmounts while still connected.
  useEffect(() => {
    if (!hasWebSerial || !navigator.serial?.addEventListener) return undefined;
    const handleSerialDisconnect = (event) => {
      // Only react to the port we're actually using (if we can tell).
      const ourPort = transportRef.current?.device || transportRef.current?.port;
      if (ourPort && event?.target && event.target !== ourPort) return;
      loaderRef.current = null;
      transportRef.current = null;
      setConnected(false);
      setConnecting(false);
      setStatusMsg('✕ USB device disconnected', 'error');
      appendLog('USB device unplugged — reconnect and press Connect.');
    };
    navigator.serial.addEventListener('disconnect', handleSerialDisconnect);
    return () => {
      navigator.serial.removeEventListener?.('disconnect', handleSerialDisconnect);
    };
  }, [hasWebSerial]);

  // Release the serial port on unmount so it isn't left held open.
  useEffect(() => {
    return () => {
      const loader = loaderRef.current;
      const transport = transportRef.current;
      loaderRef.current = null;
      transportRef.current = null;
      if (transport) {
        Promise.resolve(disconnectESP(loader, transport)).catch(() => {});
      }
    };
  }, []);

  const handleConnect = async () => {
    if (connected) {
      setConnecting(true);
      try {
        await disconnectESP(loaderRef.current, transportRef.current);
      } finally {
        // Even if disconnectESP rejects, drop the refs and clear the spinner so
        // the UI can't get stuck in a permanent "connecting" state.
        loaderRef.current = null;
        transportRef.current = null;
        setConnected(false);
        setConnecting(false);
        setStatusMsg('Disconnected');
      }
      return;
    }
    setConnecting(true);
    setStatusMsg('Select serial port…');
    try {
      const { loader, transport, chip, resetMode } = await connectESP({
        onAttempt: ({ mode }) => {
          const label = formatFlashResetMode(mode);
          setStatusMsg(`Trying ${label}…`);
          appendLog(`Trying ${label} (${mode})…`);
        },
      });
      loaderRef.current    = loader;
      transportRef.current = transport;
      setConnected(true);
      setStatusMsg(`● ${chip}`, 'connected');
      appendLog(`Connected: ${chip} via ${formatFlashResetMode(resetMode)}`);
    } catch (err) {
      const msg = err.message ?? String(err);
      setStatusMsg(`✕ ${msg}`, 'error');
      appendLog(`Connection failed: ${msg}`);
      if (msg.includes('Failed to connect') || msg.includes('sync')) {
        appendLog('→ Close other serial monitors/flasher tabs, unplug/replug USB, then try again.');
        appendLog('→ If it still fails: hold BOOT, press+release RESET, release BOOT, then Connect.');
      }
      loaderRef.current = null;
      transportRef.current = null;
    } finally {
      setConnecting(false);
    }
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await assertPlausibleEspImage(file);
    } catch (err) {
      setSelectedFile(null);
      setStatusMsg(`✕ ${err.message}`, 'error');
      appendLog(`Rejected ${file.name}: ${err.message}`);
      return;
    }
    setSelectedFile(file);
  };

  const handleSelectBundledFirmware = async () => {
    setLoadingBundledFirmware(true);
    setStatusMsg('Loading Lightweaver firmware…');
    try {
      const response = await fetch(LIGHTWEAVER_FIRMWARE_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error(`firmware file ${response.status}`);
      const blob = await response.blob();
      await assertPlausibleEspImage(blob);
      const file = new File([blob], LIGHTWEAVER_FIRMWARE_NAME, { type: 'application/octet-stream' });
      setSelectedFile(file);
      setAddress(DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS);
      setEraseAll(true);
      setStatusMsg('Lightweaver firmware selected.', 'connected');
      appendLog(`Selected ${LIGHTWEAVER_FIRMWARE_NAME} (${fmtSize(file.size)})`);
    } catch (err) {
      setStatusMsg(`✕ Could not load bundled firmware: ${err.message}`, 'error');
      appendLog(`Bundled firmware failed: ${err.message}`);
    } finally {
      setLoadingBundledFirmware(false);
    }
  };

  const handleFlash = async () => {
    if (!selectedFile || !loaderRef.current) return;
    let addr;
    try {
      ({ address: addr } = validateFlashPlan({ address, eraseAll }));
    } catch (err) {
      setStatusMsg(`✕ ${err.message ?? err}`, 'error');
      appendLog(`Flash blocked: ${err.message ?? err}`);
      return;
    }

    setFlashing(true);
    setProgress(0);
    setStatusMsg(eraseAll ? 'Erasing flash…' : 'Flashing…');
    appendLog(`Flashing ${fmtSize(selectedFile.size)} @ 0x${addr.toString(16).toUpperCase()}${eraseAll ? '  [erase all]' : ''}…`);
    if (eraseAll) appendLog('Erasing flash — this takes ~15 s…');

    try {
      await flashFirmwareAndRelease({
        loader: loaderRef.current,
        transport: transportRef.current,
        file: selectedFile,
        address: addr,
        eraseAll,
        flashFirmware,
        disconnectESP,
        onProgress: (pct) => {
          setProgress(pct);
          setStatusMsg(`Flashing… ${Math.round(pct * 100)}%`);
        },
      });
      loaderRef.current = null;
      transportRef.current = null;
      setConnected(false);
      setProgress(1);
      setStatusMsg(FLASH_COMPLETE_RELEASED_STATUS, 'connected');
      appendLog(FLASH_COMPLETE_RELEASED_LOG);
    } catch (err) {
      setStatusMsg(`✕ Flash failed: ${err.message ?? err}`, 'error');
      appendLog(`Error: ${err.message ?? err}`);
    } finally {
      setFlashing(false);
    }
  };

  const statusColor = statusKind === 'connected'
    ? 'oklch(72% 0.18 155)'
    : statusKind === 'error'
      ? 'oklch(72% 0.15 30)'
      : 'var(--text-3)';

  const canConnect = hasWebSerial && !connecting && !flashing;
  const canFlash   = connected && !!selectedFile && !flashing;

  return (
    <div style={{ padding: 40, maxWidth: 680, margin: '0 auto', height: '100%', overflow: 'auto' }}>

      {!hasWebSerial && (
        <div style={{ padding: '10px 14px', marginBottom: 20, background: 'oklch(28% 0.04 30)', border: '1px solid oklch(45% 0.12 30)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-sm)', color: 'oklch(72% 0.15 30)' }}>
          Web Serial requires Chrome or Edge. In-browser flashing is not available in your current browser.
        </div>
      )}

      <div className="lw-sec-header"><span>Connection mode</span><span className="meta">auto first, manual fallback</span></div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
        {[
          { step: 1, label: 'Click Connect', sub: 'the installer tries auto reset first' },
          { step: 2, label: 'Pick the USB port', sub: 'close other serial tabs first' },
          { step: 3, label: 'Manual fallback', sub: 'hold BOOT, tap RESET, retry' },
        ].map(({ step, label, sub }) => (
          <div key={step} style={{ flex: 1, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
            <div style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>STEP {step}</div>
            <div style={{ fontSize: 'var(--fs-md)', marginTop: 4, fontWeight: 500 }}>{label}</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)', marginTop: 3 }}>{sub}</div>
          </div>
        ))}
      </div>

      <div className="lw-sec-header"><span>Lightweaver firmware</span></div>
      <div style={{ padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 20 }}>
        <p style={{ margin: '0 0 12px', color: 'var(--text-3)', fontSize: 'var(--fs-sm)', lineHeight: 1.5 }}>
          Use the bundled Lightweaver factory firmware for sellable cards and blank ESP32-S3 boards. Only browse for a file if Adrian gave you a specific replacement binary.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={handleSelectBundledFirmware} disabled={loadingBundledFirmware}>
            {loadingBundledFirmware ? 'Loading…' : 'Use Lightweaver firmware'}
          </button>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-4)' }}>or</span>
          <button className="btn" onClick={() => fileInputRef.current?.click()}>Browse .bin</button>
          <input ref={fileInputRef} type="file" accept=".bin" style={{ display: 'none' }} onChange={handleFileChange}/>
        </div>

        {selectedFile && (
          <div style={{ fontSize: 'var(--fs-sm)', fontFamily: 'var(--mono-font)', color: 'var(--text-2)', padding: '6px 0' }}>
            {selectedFile.name} ({fmtSize(selectedFile.size)})
          </div>
        )}
      </div>

      <div className="lw-sec-header"><span>Flash options</span></div>
      <div style={{ padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '8px 12px', alignItems: 'center', fontSize: 'var(--fs-sm)' }}>
          <span style={{ color: 'var(--text-3)' }}>Address</span>
          <input
            type="text" value={address}
            onChange={e => setAddress(e.target.value)}
            style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-sm)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 8px', width: 90 }}
          />
          <span></span>
          <span style={{ color: 'var(--text-4)', fontSize: 'var(--fs-xs)' }}>
            Bundled Lightweaver factory firmware flashes at {DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS} and can erase the chip first. App-only replacement binaries usually flash at {DEFAULT_WLED_APP_FLASH_ADDRESS} with Erase all off.
          </span>
          <span style={{ color: 'var(--text-3)' }}>Erase all</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={eraseAll} onChange={e => setEraseAll(e.target.checked)}/>
            <span style={{ color: 'var(--text-4)', fontSize: 'var(--fs-xs)' }}>takes ~15 s</span>
          </label>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button
          className={`btn ${connected ? '' : 'btn-primary'}`}
          onClick={handleConnect}
          disabled={!canConnect}
        >
          {connecting ? (connected ? 'Disconnecting…' : 'Connecting…') : connected ? 'Disconnect' : 'Connect'}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleFlash}
          disabled={!canFlash}
          title={!connected ? 'Connect device first' : !selectedFile ? 'Select firmware first' : 'Flash firmware'}
        >
          Flash firmware
        </button>
        {status && (
          <span style={{ fontSize: 'var(--fs-sm)', fontFamily: 'var(--mono-font)', color: statusColor, flex: 1 }}>
            {status}
          </span>
        )}
      </div>

      <div style={{ marginBottom: 16, height: 6, background: 'var(--surface)', borderRadius: 99, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <div style={{ height: '100%', width: `${Math.round(progress * 100)}%`, background: 'var(--accent)', borderRadius: 99, transition: 'width 0.15s' }}/>
      </div>

      <div className="lw-sec-header"><span>Log</span><span className="meta">{Math.round(progress * 100)}%</span></div>
      <textarea
        ref={logRef}
        readOnly
        value={log}
        style={{
          width: '100%', height: 180, resize: 'vertical', boxSizing: 'border-box',
          fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', lineHeight: 1.6,
          background: 'var(--bg)', color: 'var(--text-2)',
          border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px',
        }}
      />
    </div>
  );
}
