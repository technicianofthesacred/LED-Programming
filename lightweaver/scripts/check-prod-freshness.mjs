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

import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The flasher's own validation (pure ESM, dependency-free): ESP magic byte +
// HTML/SPA-fallback detection live in one place instead of being re-implemented.
import { ESP_IMAGE_MAGIC, validateFirmwareImage } from '../src/lib/flashPlan.js';
import { verifyProductionCachePolicies, verifyProductionReleaseSet } from '../src/lib/productionReleaseGate.js';
import {
  assertLegacyRouteRemoved,
  assertStudioRoot,
  resolveProductionUrls,
  verifyStudioBuildGraph,
} from '../src/lib/productionDeploymentCheck.js';

const here = dirname(fileURLToPath(import.meta.url));
const localBinPath = resolve(here, '../public/firmware/lightweaver-controller-esp32s3-factory.bin');
const {
  studioUrl,
  legacyDesignUrl,
  firmwareUrl: legacyAliasUrl,
  manifestUrl,
  signatureUrl,
  provenanceUrl,
  productionJobIndexUrl,
  productionSetupUrl,
  studioBuildGraphUrl,
} = resolveProductionUrls(process.env);
const productionOrigin = new URL(studioUrl).origin;
const productionFetch = (input, init = {}) => fetch(new URL(String(input), productionOrigin), {
  ...init,
  signal: AbortSignal.timeout(20_000),
});

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
  if (process.env.PROD_CHECK_REQUIRED === '1') {
    fail(`Production is required but could not be reached at\n  ${studioUrl}\n  ${err?.cause?.code ?? err?.name ?? err?.message ?? err}`);
  }
  console.log(`check-prod-freshness SKIPPED (could not reach ${studioUrl}: ${err?.cause?.code ?? err?.name ?? err?.message ?? err})`);
  process.exit(0);
}

try {
  await assertStudioRoot(studioResponse, studioUrl);
} catch (err) {
  fail(err.message);
}

let studioBuildFileCount = 0;
try {
  const verifiedStudio = await verifyStudioBuildGraph(productionFetch, webcrypto, studioBuildGraphUrl);
  studioBuildFileCount = verifiedStudio.graph.files.length;
} catch (err) {
  fail(
    `Production root is reachable, but its Studio build graph is unavailable or does not match the deployed bytes.\n` +
      `  graph: ${studioBuildGraphUrl}\n  ${err?.message ?? err}`,
  );
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

let release;
let productionJobCount = 0;
try {
  const verified = await verifyProductionReleaseSet(productionFetch, webcrypto);
  release = verified.release;
  productionJobCount = verified.jobIndex.jobs.length;
  await verifyProductionCachePolicies(productionFetch, verified);
} catch (err) {
  fail(
    `Production's signed firmware/job release set is unavailable or invalid. The website must not flash or load it.\n` +
      `  manifest: ${manifestUrl}\n  signature: ${signatureUrl}\n  provenance: ${provenanceUrl}\n  jobs: ${productionJobIndexUrl}\n  ${err?.message ?? err}`,
  );
}

const remote = release.bytes;
validateFirmwareImage({ bytes: remote });
const remoteHash = sha256(remote);
if (remoteHash !== localHash) {
  fail(
    'Production signed firmware DRIFTED from this repo:\n' +
      `  live  ${new URL(release.manifest.image.url, productionOrigin)}\n        sha256 ${remoteHash}  (${remote.length} bytes)\n` +
      `  repo  ${localBinPath}\n        sha256 ${localHash}  (${local.length} bytes)\n` +
      'The signed website installer would flash different firmware than this checkout expects.\n' +
      'Fix: rebuild and deploy this repository\'s root Pages artifact (see docs/led-mandalacodes-setup.md, "Deploy").',
  );
}

console.log(
  `check-prod-freshness OK — production serves the signed committed factory binary\n  sha256 ${localHash}  (${local.length} bytes)\n  ${new URL(release.manifest.image.url, productionOrigin)}\n  legacy alias: ${legacyAliasUrl}`,
  `\n  Studio build graph: ${studioBuildFileCount} verified files\n  ${studioBuildGraphUrl}`,
  `\n  Production Setup: ${productionSetupUrl}\n  verified production jobs: ${productionJobCount}\n  job index: ${productionJobIndexUrl}`,
);
