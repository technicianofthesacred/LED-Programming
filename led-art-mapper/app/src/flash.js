/**
 * flash.js — ESP32 firmware flashing via Web Serial API
 *
 * Uses esptool-js 0.6.x to communicate with the ESP32 ROM bootloader.
 * Chrome / Edge 89+ only (Web Serial API).
 *
 * The ESP32-S3 N16R8 is a bare module — no auto-reset circuit. The device
 * must be put into bootloader mode manually before connecting:
 *   1. Hold BOOT (GPIO0)
 *   2. Press + release RESET (EN)
 *   3. Release BOOT
 *
 * We use 'no_reset' mode — skip any reset attempt and sync directly.
 *
 * Public API:
 *   initFlash()  — call once at boot to wire up all flash-tab UI events
 */

import { ESPLoader, Transport } from 'esptool-js';

const WLED_REPO    = 'wled/WLED';
const WLED_API_URL = `https://api.github.com/repos/${WLED_REPO}/releases/latest`;

// ── Module state ──────────────────────────────────────────────────────────────

let _transport    = null;
let _loader       = null;
let _selectedFile = null;   // File from browse OR downloaded from GitHub

// ── Public ────────────────────────────────────────────────────────────────────

export function initFlash() {
  if (!navigator.serial) {
    _setStatus('Web Serial not supported — open in Chrome or Edge', 'error');
    document.getElementById('btn-flash-connect').disabled = true;
    updateFlashButtonState();
    return;
  }

  // Manual file browse
  document.getElementById('btn-flash-browse').addEventListener('click', () => {
    document.getElementById('flash-file-input').click();
  });
  document.getElementById('flash-file-input').addEventListener('change', e => {
    const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
    if (!file) return;
    _setSelectedFile(file);
    _hideReleaseConfirm();
  });

  // GitHub fetch
  document.getElementById('btn-flash-fetch').addEventListener('click', _fetchLatestRelease);
  document.getElementById('btn-flash-confirm-use').addEventListener('click', _downloadConfirmedAsset);
  document.getElementById('btn-flash-confirm-cancel').addEventListener('click', _hideReleaseConfirm);

  // Connect / flash
  document.getElementById('btn-flash-connect').addEventListener('click', _toggleConnect);
  document.getElementById('btn-flash-write').addEventListener('click',   _flash);
}

// ── GitHub release fetch ──────────────────────────────────────────────────────

let _pendingAsset = null;   // asset object waiting for user confirmation

async function _fetchLatestRelease() {
  const btn = document.getElementById('btn-flash-fetch');
  btn.disabled = true;
  _setStatus('Checking GitHub…', '');
  _hideReleaseConfirm();

  try {
    const res = await fetch(WLED_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const release = await res.json();

    // Prefer an exact ESP32-S3 16MB match, fall back to any ESP32-S3 bin
    const assets = release.assets.filter(a => /\.bin$/i.test(a.name));
    const best =
      assets.find(a => /esp32.?s3/i.test(a.name) && /16mb/i.test(a.name)) ??
      assets.find(a => /esp32.?s3/i.test(a.name)) ??
      null;

    if (!best) {
      _setStatus('No ESP32-S3 binary found in latest release', 'error');
      _log(`Release ${release.tag_name} assets:\n${assets.map(a => '  ' + a.name).join('\n')}`);
      return;
    }

    _pendingAsset = best;
    _showReleaseConfirm(release.tag_name, release.published_at, best);
    _setStatus(`Found ${release.tag_name}`, '');
  } catch (err) {
    _setStatus(`✕ ${err.message}`, 'error');
    _log(`GitHub fetch failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function _downloadConfirmedAsset() {
  if (!_pendingAsset) return;
  const asset = _pendingAsset;
  // GitHub release asset URLs redirect through github.com without CORS headers,
  // so browser fetch always fails. Open the download in a new tab instead, then
  // the user selects the saved file with Browse.
  window.open(asset.browser_download_url, '_blank');
  _log(`Opening download for ${asset.name} — save the file, then use Browse to select it.`);
  _setStatus('Save the downloaded file, then use Browse ↑', '');
  _hideReleaseConfirm();
}

function _showReleaseConfirm(tag, publishedAt, asset) {
  const date = new Date(publishedAt).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
  document.getElementById('flash-confirm-version').textContent  = tag;
  document.getElementById('flash-confirm-date').textContent     = date;
  document.getElementById('flash-confirm-filename').textContent = asset.name;
  document.getElementById('flash-confirm-size').textContent     = _fmtSize(asset.size);
  document.getElementById('btn-flash-confirm-use').textContent  = 'Download & use Browse';
  document.getElementById('btn-flash-confirm-use').disabled     = false;
  document.getElementById('flash-release-confirm').classList.remove('hidden');
}

function _hideReleaseConfirm() {
  document.getElementById('flash-release-confirm').classList.add('hidden');
  _pendingAsset = null;
}

function _setSelectedFile(file) {
  _selectedFile = file;
  document.getElementById('flash-filename').textContent =
    `${file.name} (${_fmtSize(file.size)})`;
  updateFlashButtonState();
}

// ── Connect / disconnect ──────────────────────────────────────────────────────

async function _toggleConnect() {
  if (_loader) {
    await _disconnect();
  } else {
    await _connect();
  }
}

async function _connect() {
  const connectBtn = document.getElementById('btn-flash-connect');
  connectBtn.disabled = true;
  _setStatus('Select serial port…', '');

  try {
    const port = await navigator.serial.requestPort();
    const { usbVendorId, usbProductId } = port.getInfo();
    _log(`Port: VID 0x${usbVendorId?.toString(16) ?? '?'} PID 0x${usbProductId?.toString(16) ?? '?'}`);

    _transport = new Transport(port, false);

    const loader = new ESPLoader({
      transport:    _transport,
      baudrate:     921600,
      debugLogging: false,
      terminal: {
        clean:     ()    => { document.getElementById('flash-log').textContent = ''; },
        writeLine: line  => _log(line),
        write:     chunk => _logInline(chunk),
      },
    });

    _setStatus('Syncing with bootloader…', '');
    _log('Syncing (no_reset — device must already be in bootloader mode)…');
    const chip = await loader.main('no_reset');

    _loader = loader;
    _setStatus(`● ${chip}`, 'connected');
    _log(`Connected: ${chip}`);
    connectBtn.textContent = 'Disconnect';
    updateFlashButtonState();
  } catch (err) {
    const msg = err.message ?? String(err);
    _log(`Connection failed: ${msg}`);
    if (msg.includes('Failed to connect') || msg.includes('sync')) {
      _log('→ Hold BOOT → press+release RESET → release BOOT → then Connect');
    }
    _setStatus(`✕ ${msg}`, 'error');
    if (_transport) {
      await _transport.disconnect().catch(() => {});
      _transport = null;
    }
  } finally {
    connectBtn.disabled = false;
  }
}

async function _disconnect() {
  const connectBtn = document.getElementById('btn-flash-connect');
  connectBtn.disabled = true;
  try {
    if (_transport) await _transport.disconnect().catch(() => {});
  } finally {
    _transport = null;
    _loader    = null;
    connectBtn.textContent = 'Connect';
    connectBtn.disabled    = false;
    updateFlashButtonState();
    _setStatus('Disconnected', '');
  }
}

// ── Flash ─────────────────────────────────────────────────────────────────────

async function _flash() {
  // Use downloaded file first, fall back to file-picker selection
  const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('flash-file-input'));
  const file      = _selectedFile ?? fileInput.files?.[0] ?? null;
  const addrInput = /** @type {HTMLInputElement} */ (document.getElementById('flash-address'));

  if (!file)    { _setStatus('No firmware file selected', 'error'); return; }
  if (!_loader) { _setStatus('Not connected', 'error'); return; }

  const address = parseInt(addrInput.value, 16);
  if (isNaN(address)) { _setStatus('Invalid flash address', 'error'); return; }

  document.getElementById('btn-flash-write').disabled   = true; // locked during flash
  document.getElementById('btn-flash-connect').disabled = true;
  _setProgress(0);
  _setStatus('Reading firmware…', '');
  _log(`Reading ${file.name}…`);

  let data;
  try {
    data = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    _setStatus(`✕ Could not read file: ${err.message}`, 'error');
    _resetButtons();
    return;
  }

  const eraseAll = /** @type {HTMLInputElement} */ (
    document.getElementById('flash-erase-all')
  ).checked;

  _log(`Flashing ${_fmtSize(data.byteLength)} @ 0x${address.toString(16).toUpperCase()}${eraseAll ? '  [erase all]' : ''}…`);
  if (eraseAll) _log('Erasing flash — this takes ~15 s…');
  _setStatus(eraseAll ? 'Erasing flash…' : 'Flashing…', '');

  try {
    await _loader.writeFlash({
      fileArray: [{ data, address }],
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'keep',
      eraseAll,
      compress:  true,
      reportProgress(fileIndex, written, total) {
        const pct = total > 0 ? written / total : 0;
        _setProgress(pct);
        _setStatus(
          `Flashing… ${Math.round(pct * 100)}%  (${_fmtSize(written)} / ${_fmtSize(total)})`,
          '',
        );
      },
    });

    _setProgress(1);
    _log('Flash complete. Resetting device…');
    _setStatus('Resetting…', '');
    await _loader.after('hard_reset');

    _setStatus('● Flash complete — WLED is booting', 'connected');
    _log('Done. WLED should start in a few seconds.');
  } catch (err) {
    _setStatus(`✕ Flash failed: ${err.message ?? err}`, 'error');
    _log(`Error: ${err.message ?? err}`);
  } finally {
    _resetButtons();
  }
}

// ── Flash button state helper ─────────────────────────────────────────────────

function updateFlashButtonState() {
  const btn = document.getElementById('btn-flash-write');
  if (!btn) return;
  const hasFirmware  = !!_selectedFile;
  const isConnected  = !!_loader;
  btn.disabled = !(hasFirmware && isConnected);
  if (!hasFirmware && !isConnected) {
    btn.title = 'Select firmware and connect device first';
  } else if (hasFirmware && !isConnected) {
    btn.title = 'Connect device first';
  } else if (!hasFirmware && isConnected) {
    btn.title = 'Select firmware first';
  } else {
    btn.title = 'Flash firmware to connected device';
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _setStatus(msg, modifier) {
  const el = document.getElementById('flash-status');
  el.textContent = msg;
  el.className   = 'flash-status' + (modifier ? ` flash-status--${modifier}` : '');
}

function _setProgress(frac) {
  const pct = Math.round(frac * 100);
  document.getElementById('flash-progress-bar').style.width = `${pct}%`;
  document.getElementById('flash-progress-pct').textContent = `${pct}%`;
}

function _log(line) {
  const el = document.getElementById('flash-log');
  el.textContent += line + '\n';
  el.scrollTop    = el.scrollHeight;
}

function _logInline(chunk) {
  const el = document.getElementById('flash-log');
  el.textContent += chunk;
  el.scrollTop    = el.scrollHeight;
}

function _resetButtons() {
  updateFlashButtonState();
  document.getElementById('btn-flash-connect').disabled = false;
}

function _fmtSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
