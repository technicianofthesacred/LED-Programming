import { ESPLoader, Transport } from 'esptool-js';

const WLED_API_URL = 'https://api.github.com/repos/wled/WLED/releases/latest';

export async function connectESP() {
  const port = await navigator.serial.requestPort();
  const transport = new Transport(port, false);

  let logLines = [];
  const loader = new ESPLoader({
    transport,
    baudrate: 921600,
    debugLogging: false,
    terminal: {
      clean: () => { logLines = []; },
      writeLine: line => { logLines.push(line); },
      write: chunk => {
        if (logLines.length === 0) logLines.push('');
        logLines[logLines.length - 1] += chunk;
      },
    },
  });

  const chip = await loader.main('no_reset');
  return { loader, transport, chip };
}

export async function disconnectESP(loader, transport) {
  try {
    if (transport) await transport.disconnect().catch(() => {});
  } catch (_) {}
}

export async function flashFirmware(loader, file, address, eraseAll, onProgress) {
  const data = new Uint8Array(await file.arrayBuffer());
  await loader.writeFlash({
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
