import { ESPLoader, Transport } from 'esptool-js';
import {
  connectEspWithResetSequence,
  makeEspConnectTerminal,
} from './flashConnection.js';
import { writeVerifiedFlash } from './flashPlan.js';
import { cardIdFromEspMac } from './cardCommissioningFlow.js';
import { espCanReportFirmwareIdentity, readLightweaverFirmwareIdentity } from './usbFirmwareIdentity.js';

export { espCanReportFirmwareIdentity };

const WLED_API_URL = 'https://api.github.com/repos/wled/WLED/releases/latest';

export async function connectESP({ onAttempt, onLog } = {}) {
  const port = await navigator.serial.requestPort();
  return connectEspWithResetSequence({
    port,
    onAttempt,
    createTransport: selectedPort => new Transport(selectedPort, false),
    createLoader: ({ transport }) => new ESPLoader({
      transport,
      baudrate: 921600,
      debugLogging: false,
      terminal: makeEspConnectTerminal(onLog),
    }),
  });
}

// Identifying the card is three quick register reads. Reading back which
// firmware version it is carrying is a multi-megabyte serial scan, so it is a
// separate call: nothing about connecting, confirming or installing needs the
// version, and making the connect step wait for it turned a two-second action
// into a minute of a button that looked dead.
export async function inspectConnectedESP(loader, chipDescription = '') {
  if (!loader) throw new Error('The connected card could not be inspected');
  const flashSize = await loader.detectFlashSize();
  const mac = await loader.chip?.readMac?.(loader);
  const chipName = String(loader.chip?.CHIP_NAME || '');
  return {
    chipDescription: String(chipDescription || loader.chip?.CHIP_NAME || 'Unknown chip'),
    chipName,
    flashSize,
    mac: String(mac || ''),
    cardId: cardIdFromEspMac(mac),
  };
}

// Runs only against a card already identified by inspectConnectedESP, and only
// while no write is in flight — a read and a write cannot share the serial line.
export async function readConnectedEspFirmwareIdentity(loader, hardware, options = {}) {
  if (!loader || !espCanReportFirmwareIdentity(hardware)) return null;
  return readLightweaverFirmwareIdentity(loader, options);
}

export async function disconnectESP(loader, transport) {
  try {
    if (transport) await transport.disconnect();
    return true;
  } catch (_) {
    return false;
  }
}

export async function flashFirmware(loader, file, address, eraseAll, onProgress) {
  const data = new Uint8Array(await file.arrayBuffer());
  await writeVerifiedFlash(loader, {
    fileArray: [{ data, address }],
    flashMode: 'keep',
    flashFreq: 'keep',
    flashSize: 'keep',
    eraseAll,
    compress: true,
    reportProgress(_fileIndex, written, total) {
      onProgress(total > 0 ? written / total : 0);
    },
  });
  await loader.after('hard_reset');
}

// Preserving bootstrap needs to read back the exact application bytes before
// reset. Keep that bounded write separate from the technician/factory helper,
// which intentionally resets as soon as its write completes.
export async function writeApplicationWithoutReset(loader, data, address, eraseAll, onProgress) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
  if (address !== 0x10000 || eraseAll !== false || bytes.byteLength < 1) {
    throw new Error('Preserving firmware writes are restricted to app0 with erase disabled.');
  }
  await writeVerifiedFlash(loader, {
    fileArray: [{ data: bytes, address }],
    flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', eraseAll: false, compress: true,
    reportProgress(_fileIndex, written, total) {
      onProgress?.(total > 0 ? written / total : 0);
    },
  });
}

export async function fetchLatestWLEDRelease() {
  const res = await fetch(WLED_API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const release = await res.json();

  const bins = release.assets.filter(a => /\.bin$/i.test(a.name));
  const asset =
    bins.find(a => /esp32.?s3/i.test(a.name) && /16mb/i.test(a.name)) ??
    bins.find(a => /esp32.?s3/i.test(a.name)) ??
    null;

  if (!asset) throw new Error(`No ESP32-S3 binary in release ${release.tag_name}`);

  return {
    tagName: release.tag_name,
    date: new Date(release.published_at).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    }),
    asset: {
      name: asset.name,
      size: asset.size,
      downloadUrl: asset.browser_download_url,
    },
  };
}
