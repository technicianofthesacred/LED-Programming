#!/usr/bin/env node
// Generates the canonical BENCH FIXTURE production-job source.
//
// This is the job a workshop worker uses for the rehearsal and for bench
// acceptance of freshly built cards: one output on GPIO 18 driving the
// physical 44-LED bench strip, a
// conservative brightness limit, and the standard control pinout. Real
// artwork jobs are generated the same way with the artwork's own layout.
//
// The fingerprint and configuration package must be computed by the real
// libraries (they are content-addressed), so the source is generated rather
// than hand-written. Regenerate + rebuild with:
//
//   node scripts/rebuild-production-jobs.mjs
//
// (which runs every generator in release/job-generators/ and rebuilds every
// source in release/job-sources/ against the CURRENT signed manifest — CI
// does this automatically whenever it signs a new firmware release)
//
// Same-origin index jobs need no detached signature (see
// release/production-job-signing.md); add one with --signing-key when the
// external-file lane must import this job offline.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintCommissioningProject } from '../../lightweaver/src/lib/cardCommissioningFlow.js';
import { buildCardRuntimePackageFromProject } from '../../lightweaver/src/lib/cardRuntimeProject.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parsePaths(values) {
  const paths = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!['--manifest', '--output'].includes(flag) || !value) {
      throw new Error(`Usage: ${process.argv[1]} [--manifest PATH --output PATH]`);
    }
    paths.set(flag.slice(2), resolve(value));
  }
  return paths;
}

const paths = parsePaths(process.argv.slice(2));
const manifestPath = paths.get('manifest') || resolve(repoRoot, 'lightweaver/public/firmware/release-manifest.json');
const outPath = paths.get('output') || resolve(repoRoot, 'release/job-sources/bench-fixture-44.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const PIXELS = 44;
const DATA_PIN = 18;
const MAX_MILLIAMPS = 1500;
const JOB_ID = 'bench-fixture-44';

const standaloneController = {
  outputs: [{ id: 'out1', name: 'Bench strip', pin: DATA_PIN, pixels: PIXELS }],
  led: { type: 'WS2815', colorOrder: 'GRB', brightnessLimit: 0.35, maxMilliamps: MAX_MILLIAMPS },
  controls: {
    encoder: { a: 4, b: 5, press: 0, alternatePress: 6, rotateDirection: 'clockwise-brighter', brightnessStep: 18 },
    previous: 7,
    next: 8,
    blackout: 9,
    brightness: -1,
    statusLed: 2,
  },
  defaultLook: { patternId: 'aurora', brightness: 1, speed: 1, hueShift: 0, customHue: 32, customSaturation: 230, customBreathe: false, customDrift: false },
  looks: [],
  playlist: [{ id: 'aurora', type: 'pattern', patternId: 'aurora', label: 'Aurora', enabled: true, createdAt: 0 }],
};

const restoreSnapshot = {
  version: 4,
  id: 'bench-fixture',
  name: 'Bench fixture',
  layout: {
    strips: [{ id: 'strip-1', name: 'Bench strip', pixelCount: PIXELS }],
    patchBoard: null,
    wiring: {
      version: 1,
      locked: true,
      verified: true,
      controllerAnchor: null,
      migrationWarnings: [],
      outputs: [{ id: 'out1', name: 'Bench strip', pin: DATA_PIN, runIds: ['run-strip-1'] }],
      runs: [{
        id: 'run-strip-1', type: 'strip', verified: true,
        source: { stripId: 'strip-1', from: 0, to: PIXELS - 1 },
        directionPolicy: 'flexible', physicalDirection: 'source-forward', seamLed: null,
      }],
    },
  },
  devices: { standaloneController },
};

const fingerprint = fingerprintCommissioningProject(restoreSnapshot);
const configuration = buildCardRuntimePackageFromProject({
  projectId: restoreSnapshot.id,
  projectName: restoreSnapshot.name,
  projectRevision: 1,
  projectFingerprint: fingerprint,
  productionJobId: JOB_ID,
  productionJobDigest: '0'.repeat(64),
  strips: restoreSnapshot.layout.strips,
  patchBoard: restoreSnapshot.layout.patchBoard,
  wiring: restoreSnapshot.layout.wiring,
  standaloneController,
});

const source = {
  schemaVersion: 1,
  jobId: JOB_ID,
  label: 'Bench fixture · 44 LEDs',
  artwork: 'Bench fixture',
  batch: 'rehearsal',
  firmware: {
    target: manifest.target,
    version: manifest.firmwareVersion,
    buildId: manifest.buildId,
    minimumVersion: manifest.firmwareVersion,
  },
  project: {
    id: restoreSnapshot.id,
    revision: 1,
    fingerprint,
    restoreSnapshot,
  },
  configuration,
  expectedOutputs: [{ id: 'out1', label: 'Bench strip', pin: DATA_PIN, pixels: PIXELS, direction: 'forward', colorOrder: 'GRB' }],
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(source, null, 2)}\n`);
console.log(JSON.stringify({ manifestPath, outPath, jobId: JOB_ID, firmware: source.firmware }, null, 2));
