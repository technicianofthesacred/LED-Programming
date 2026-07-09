// Deploy-time check: does LIVE production serve the firmware this repo built?
//
// Production (led.mandalacodes.com) is a MANUAL wrangler deploy of the
// mandalacodes bundle (a different repo) — LED-repo pushes only reach the
// studio preview branch. So the committed factory binary can be perfectly
// fresh against firmware source (factory-bin-freshness.mjs guards that) while
// the live site still flashes an OLD binary. This script closes that gap by
// hashing what production actually serves.
//
// Run manually or after a production publish:
//   npm run check:prod          (from lightweaver/)
//
// Network-optional by design: when the site is unreachable (offline dev,
// sandboxed CI) it prints SKIPPED and exits 0. It only fails when it can see
// production and production is wrong. Do NOT add this to test:core.
//
// Override the URL for staging checks:
//   PROD_FIRMWARE_URL=https://studio.lightweaver-edw.pages.dev/firmware/... npm run check:prod

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ESP_IMAGE_MAGIC = 0xe9;
const here = dirname(fileURLToPath(import.meta.url));
const localBinPath = resolve(here, '../public/firmware/lightweaver-controller-esp32s3-factory.bin');
const url = process.env.PROD_FIRMWARE_URL
  || 'https://led.mandalacodes.com/firmware/lightweaver-controller-esp32s3-factory.bin';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  console.error(`check-prod-freshness FAILED\n${message}`);
  process.exit(1);
}

const local = new Uint8Array(readFileSync(localBinPath));
if (local[0] !== ESP_IMAGE_MAGIC) {
  fail(`Committed binary ${localBinPath} does not start with the ESP image magic byte (0xE9) — the repo copy itself is broken.`);
}
const localHash = sha256(local);

let response;
try {
  response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
} catch (err) {
  // Offline / DNS failure / timeout — a connectivity problem, not a deploy
  // problem. Must not break offline dev or network-less CI.
  console.log(`check-prod-freshness SKIPPED (could not reach ${url}: ${err?.cause?.code ?? err?.name ?? err?.message ?? err})`);
  process.exit(0);
}

if (!response.ok) {
  fail(
    `Production answered HTTP ${response.status} at\n  ${url}\n` +
      'The live site is reachable but not serving the firmware file. Cards cannot be flashed from the website right now.',
  );
}

const remote = new Uint8Array(await response.arrayBuffer());
const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

if (contentType.includes('text/html') || remote[0] !== ESP_IMAGE_MAGIC) {
  fail(
    `Production serves something that is NOT an ESP32 firmware image at\n  ${url}\n` +
      `  content-type: ${contentType || '(none)'}  first byte: 0x${(remote[0] ?? 0).toString(16)}  size: ${remote.length}\n` +
      'This is likely the SPA fallback (index.html with HTTP 200). The Studio flasher refuses this payload, so website flashing is effectively down until the bundle is republished with the binary included.',
  );
}

const remoteHash = sha256(remote);
if (remoteHash !== localHash) {
  fail(
    'Production firmware DRIFTED from this repo:\n' +
      `  live  ${url}\n        sha256 ${remoteHash}  (${remote.length} bytes)\n` +
      `  repo  ${localBinPath}\n        sha256 ${localHash}  (${local.length} bytes)\n` +
      'Cards flashed from the website get different firmware than this checkout expects.\n' +
      'Fix: rebuild + manually publish the mandalacodes bundle (see docs/led-mandalacodes-setup.md, "Deploy").',
  );
}

console.log(
  `check-prod-freshness OK — production serves the committed factory binary\n  sha256 ${localHash}  (${local.length} bytes)\n  ${url}`,
);
