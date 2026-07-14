// Deploy-time check: does LIVE production serve the firmware this repo built?
//
// Production (led.mandalacodes.com) is the root artifact deployed by this
// repository. The committed factory binary can still be fresh against firmware
// source while a failed or stale Pages deploy serves an older image. This
// script closes that gap by hashing what production actually serves.
//
// Run manually or after a production publish:
//   npm run check:prod          (from lightweaver/)
//
// Network-optional by design: when the site is unreachable (offline dev,
// sandboxed CI) it prints SKIPPED and exits 0. It only fails when it can see
// production and production is wrong. Do NOT add this to test:core.
//
// Override one origin for staging checks; all checked paths stay coherent:
//   PROD_ORIGIN=https://studio.lightweaver-edw.pages.dev npm run check:prod

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The flasher's own validation (pure ESM, dependency-free): ESP magic byte +
// HTML/SPA-fallback detection live in one place instead of being re-implemented.
import { ESP_IMAGE_MAGIC, validateFirmwareImage } from '../src/lib/flashPlan.js';
import {
  assertLegacyRouteRemoved,
  assertStudioRoot,
  resolveProductionUrls,
} from '../src/lib/productionDeploymentCheck.js';

const here = dirname(fileURLToPath(import.meta.url));
const localBinPath = resolve(here, '../public/firmware/lightweaver-controller-esp32s3-factory.bin');
const { studioUrl, legacyDesignUrl, firmwareUrl: url } = resolveProductionUrls(process.env);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  console.error(`check-prod-freshness FAILED\n${message}`);
  process.exit(1);
}

const local = new Uint8Array(readFileSync(localBinPath));
try {
  validateFirmwareImage({ bytes: local });
} catch (err) {
  fail(
    `Committed binary ${localBinPath} is not a flashable ESP32 image (magic byte 0x${ESP_IMAGE_MAGIC.toString(16).toUpperCase()}) — the repo copy itself is broken.\n  ${err.message}`,
  );
}
const localHash = sha256(local);

let studioResponse;
try {
  studioResponse = await fetch(studioUrl, {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
} catch (err) {
  console.log(`check-prod-freshness SKIPPED (could not reach ${studioUrl}: ${err?.cause?.code ?? err?.name ?? err?.message ?? err})`);
  process.exit(0);
}

try {
  await assertStudioRoot(studioResponse, studioUrl);
} catch (err) {
  fail(err.message);
}

let legacyResponse;
try {
  legacyResponse = await fetch(legacyDesignUrl, {
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
} catch (err) {
  fail(`Production root is reachable, but the removed route could not be checked at\n  ${legacyDesignUrl}\n  ${err?.cause?.code ?? err?.name ?? err?.message ?? err}`);
}
try {
  await assertLegacyRouteRemoved(legacyResponse, legacyDesignUrl);
} catch (err) {
  fail(`${err.message}\nThe production artifact must contain a top-level 404.html and no wildcard Studio rewrite.`);
}

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

try {
  validateFirmwareImage({ bytes: remote, contentType });
} catch (err) {
  fail(
    `Production serves something that is NOT an ESP32 firmware image at\n  ${url}\n` +
      `  content-type: ${contentType || '(none)'}  first byte: 0x${(remote[0] ?? 0).toString(16)}  size: ${remote.length}\n` +
      `  ${err.message}\n` +
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
      'Fix: rebuild and deploy this repository\'s root Pages artifact (see docs/led-mandalacodes-setup.md, "Deploy").',
  );
}

console.log(
  `check-prod-freshness OK — production serves the committed factory binary\n  sha256 ${localHash}  (${local.length} bytes)\n  ${url}`,
);
