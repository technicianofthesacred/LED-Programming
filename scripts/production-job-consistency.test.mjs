import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..');

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(repoRoot, relativePath), 'utf8'));
}

function fixtureFacts(job) {
  const controller = job.project.restoreSnapshot.devices.standaloneController;
  const wiringOutput = job.project.restoreSnapshot.layout.wiring.outputs[0];
  const runtimeOutput = job.configuration.config.led.outputs[0];
  const expectedOutput = job.expectedOutputs[0];
  return {
    controllerPin: controller.outputs[0].pin,
    wiringPin: wiringOutput.pin,
    runtimePin: runtimeOutput.pin,
    expectedPin: expectedOutput.pin,
    controllerPixels: controller.outputs[0].pixels,
    runtimePixels: job.configuration.config.led.pixels,
    outputPixels: runtimeOutput.pixels,
    expectedPixels: expectedOutput.pixels,
    colorOrder: job.configuration.config.led.colorOrder,
    expectedColorOrder: expectedOutput.colorOrder,
    brightnessLimit: job.configuration.config.led.brightnessLimit,
    maxMilliamps: job.configuration.config.led.maxMilliamps,
    startupPatternId: job.configuration.config.startupPatternId,
  };
}

const expectedFixture = {
  controllerPin: 18,
  wiringPin: 18,
  runtimePin: 18,
  expectedPin: 18,
  controllerPixels: 44,
  runtimePixels: 44,
  outputPixels: 44,
  expectedPixels: 44,
  colorOrder: 'GRB',
  expectedColorOrder: 'GRB',
  brightnessLimit: 0.35,
  maxMilliamps: 1500,
  startupPatternId: 'aurora',
};

test('canonical bench source cannot drift from the physical GPIO 18 fixture', async () => {
  const source = await readJson('release/job-sources/bench-fixture-44.json');
  assert.equal(source.jobId, 'bench-fixture-44');
  assert.deepEqual(fixtureFacts(source), expectedFixture);
});

test('canonical bench generator names GPIO 18 as its only data-pin source', async () => {
  const generator = await readFile(resolve(repoRoot, 'release/job-generators/bench-fixture-44.mjs'), 'utf8');
  assert.match(generator, /const DATA_PIN = 18;/);
  assert.match(generator, /const MAX_MILLIAMPS = 1500;/);
  assert.doesNotMatch(generator, /pin:\s*16\b/);
  assert.equal((generator.match(/pin:\s*DATA_PIN/g) || []).length, 3);
});

test('published bench artifact and index match the canonical source', async () => {
  const index = await readJson('lightweaver/public/production/jobs/index.json');
  const entry = index.jobs.find(job => job.jobId === 'bench-fixture-44');
  assert.ok(entry, 'bench-fixture-44 must be present in the public production index');

  const artifact = await readJson(`lightweaver/public${entry.url}`);
  assert.equal(artifact.digest, entry.digest);
  assert.equal(artifact.jobId, 'bench-fixture-44');
  assert.deepEqual(fixtureFacts(artifact), expectedFixture);
});

test('always-on tests watch every production-job and signing input', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/test.yml'), 'utf8');
  for (const path of [
    'release/job-generators/**',
    'release/job-sources/**',
    'release/firmware-manifest.schema.json',
    'release/production-job.schema.json',
    'release/production-job-signing.md',
    'scripts/build-firmware-manifest.mjs',
    'scripts/build-production-job.mjs',
    'scripts/rebuild-production-jobs.mjs',
    'scripts/sign-release-artifacts.mjs',
    'scripts/production-job-consistency.test.mjs',
    'docs/card-provisioning-audit.md',
    'docs/card-provisioning-checklist.md',
    'docs/card-provisioning-fixes.md',
    'docs/new-card-checklist.md',
    'docs/deployment-checklist.md',
    'docs/worker-flash-runbook.md',
    'docs/worker-job-card.md',
    'docs/roadmap.md',
    '.github/workflows/**',
  ]) {
    const occurrences = workflow.split(`'${path}'`).length - 1;
    assert.equal(occurrences, 2, `${path} must trigger both push and pull_request tests`);
  }
});

test('protected release rebuild watches job inputs without an artifact commit loop', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/build-firmware.yml'), 'utf8');
  for (const path of [
    'release/job-generators/**',
    'release/job-sources/**',
    'release/production-job.schema.json',
    'scripts/build-production-job.mjs',
    'scripts/rebuild-production-jobs.mjs',
    'lightweaver/src/lib/productionJobPackage.js',
  ]) {
    assert.ok(workflow.includes(`'${path}'`), `${path} must trigger the protected release rebuild`);
  }
  assert.doesNotMatch(
    workflow,
    /^\s+- 'lightweaver\/public\/production\/jobs\/\*\*'$/m,
    'generated production artifacts must not retrigger the signer',
  );
});

test('deploy workflow explicitly records a credential-skipped publish as not run', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/deploy-site.yml'), 'utf8');
  assert.match(workflow, /Production publish: NOT RUN/);
  assert.match(workflow, /is not a deployment and must not be used as shipment evidence/);
  assert.match(workflow, /PROD_CHECK_REQUIRED: '1'/);
});
