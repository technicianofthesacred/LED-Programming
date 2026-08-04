import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    patternIds: job.configuration.config.patterns.map(pattern => pattern.id),
    lookIds: job.configuration.config.looks.map(look => look.id),
    cycleIds: job.configuration.config.controls.encoder.patternCycleIds,
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
  patternIds: ['aurora', 'fire', 'ocean', 'plasma', 'sparkle'],
  lookIds: ['aurora', 'fire', 'ocean', 'plasma', 'sparkle'],
  cycleIds: ['aurora', 'fire', 'ocean', 'plasma', 'sparkle'],
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

test('production schema accepts only optional supported runtime LED protocols', async () => {
  const schema = await readJson('release/production-job.schema.json');
  const runtimeLed = schema.properties.configuration.properties.config.properties.led;
  assert.deepEqual(runtimeLed.properties.type.enum, ['WS2812B', 'WS2815']);
  assert.equal(runtimeLed.required.includes('type'), false, 'legacy production jobs may omit the LED protocol');
});

test('production schema makes source and runtime Kaleidoscope mappings optional and strict', async () => {
  const schema = await readJson('release/production-job.schema.json');
  const strip = schema.$defs.strip;
  const runtimeConfig = schema.properties.configuration.properties.config;
  assert.equal(strip.required.includes('kaleidoscope'), false);
  assert.equal(runtimeConfig.required.includes('kaleidoscopeMappings'), false);
  assert.equal(strip.properties.kaleidoscope.$ref, '#/$defs/kaleidoscope');
  assert.equal(runtimeConfig.properties.kaleidoscopeMappings.items.$ref, '#/$defs/runtimeKaleidoscopeMapping');
  assert.equal(schema.$defs.kaleidoscope.additionalProperties, false);
  assert.equal(schema.$defs.runtimeKaleidoscopeMapping.additionalProperties, false);

  const index = await readJson('lightweaver/public/production/jobs/index.json');
  const entry = index.jobs.find(job => job.jobId === 'bench-fixture-44');
  const artifact = await readJson(`lightweaver/public${entry.url}`);
  assert.equal(Object.hasOwn(artifact.project.restoreSnapshot.layout.strips[0], 'kaleidoscope'), false);
  assert.equal(Object.hasOwn(artifact.configuration.config, 'kaleidoscopeMappings'), false);
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

test('generator and job builder reproduce the committed source, artifact, and index metadata', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'lightweaver-production-job-'));
  try {
    const generatedSourcePath = resolve(temporary, 'bench-fixture-44.json');
    const temporaryPublicRoot = resolve(temporary, 'public');
    execFileSync(process.execPath, [
      resolve(repoRoot, 'release/job-generators/bench-fixture-44.mjs'),
      '--manifest', resolve(repoRoot, 'lightweaver/public/firmware/release-manifest.json'),
      '--output', generatedSourcePath,
    ], { cwd: repoRoot, stdio: 'pipe' });

    const [generatedSource, committedSource] = await Promise.all([
      readFile(generatedSourcePath),
      readFile(resolve(repoRoot, 'release/job-sources/bench-fixture-44.json')),
    ]);
    assert.deepEqual(generatedSource, committedSource, 'committed job source must be exact generator output');

    execFileSync(process.execPath, [
      resolve(repoRoot, 'scripts/build-production-job.mjs'),
      '--input', generatedSourcePath,
      '--public-root', temporaryPublicRoot,
    ], { cwd: repoRoot, stdio: 'pipe' });

    const temporaryIndex = JSON.parse(await readFile(resolve(temporaryPublicRoot, 'production/jobs/index.json'), 'utf8'));
    assert.equal(temporaryIndex.jobs.length, 1);
    const generatedEntry = temporaryIndex.jobs[0];
    assert.equal(generatedEntry.jobId, 'bench-fixture-44');
    assert.equal(generatedEntry.url, `/production/jobs/${generatedEntry.digest}.lwjob.json`);

    const generatedArtifact = await readFile(resolve(temporaryPublicRoot, generatedEntry.url.slice(1)));
    const generatedArtifactJson = JSON.parse(generatedArtifact);
    assert.equal(generatedArtifactJson.digest, generatedEntry.digest);
    assert.equal(generatedEntry.size, generatedArtifact.byteLength);
    assert.equal(generatedEntry.artifactSha256, createHash('sha256').update(generatedArtifact).digest('hex'));

    const committedIndex = await readJson('lightweaver/public/production/jobs/index.json');
    const committedEntry = committedIndex.jobs.find(job => job.jobId === 'bench-fixture-44');
    assert.deepEqual(generatedEntry, committedEntry, 'committed index metadata must be exact builder output');
    const committedArtifact = await readFile(resolve(repoRoot, `lightweaver/public${committedEntry.url}`));
    assert.deepEqual(generatedArtifact, committedArtifact, 'committed artifact must be exact builder output');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('fast Tests workflow exposes one aggregate gate over every focused lane', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/test.yml'), 'utf8');
  assert.match(workflow, /merge_group:/);
  assert.match(workflow, /branches:\s*\n\s*- main/);
  assert.doesNotMatch(workflow, /workflow_call:/);
  for (const job of ['classify', 'source', 'browser', 'cloud', 'production', 'firmware', 'artifact', 'gate']) {
    assert.match(workflow, new RegExp(`^  ${job}:`, 'm'), `Tests workflow must define ${job}`);
  }
  assert.match(workflow, /gate:\s*\n\s*name: gate\s*\n\s*if: \$\{\{ always\(\) \}\}/);
  assert.match(workflow, /needs: \[classify, source, browser, cloud, production, firmware, artifact\]/);
  assert.doesNotMatch(workflow, /npm run launch:(?:source|check)/, 'fast lanes must not rerun the monolithic launch gate');
});

test('protected signer consumes the exact successful Tests revision without an artifact loop', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/build-firmware.yml'), 'utf8');
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \["Tests"\]/);
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /npm run ci:firmware-sensitive/);
  assert.match(workflow, /-f revision="\$SIGNED_SHA"/);
  assert.doesNotMatch(
    workflow,
    /^\s+push:/m,
    'generated signer commits must not retrigger the signer through a push event',
  );
});

test('focused package scripts compose existing checks without weakening launch contracts', async () => {
  const packageJson = await readJson('lightweaver/package.json');
  for (const name of [
    'ci:source-build',
    'ci:browser-smoke',
    'ci:cloud',
    'ci:production',
    'ci:firmware-sensitive',
    'ci:artifact',
  ]) assert.ok(packageJson.scripts[name], `${name} must exist`);
  assert.match(packageJson.scripts['launch:source'], /test:release-ui/);
  assert.match(packageJson.scripts['launch:check'], /launch:source/);
  assert.match(packageJson.scripts['launch:check'], /firmware:check-bin/);
});

test('deploy workflow explicitly records a credential-skipped publish as not run', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/deploy-site.yml'), 'utf8');
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /revision:/);
  assert.match(workflow, /npm run ci:artifact/);
  assert.match(workflow, /git ls-remote origin refs\/heads\/main/);
  assert.doesNotMatch(workflow, /uses: \.\/\.github\/workflows\/test\.yml/);
  assert.match(workflow, /Production publish: NOT RUN/);
  assert.match(workflow, /is not a deployment and must not be used as shipment evidence/);
  assert.match(workflow, /PROD_CHECK_REQUIRED: '1'/);
});

test('artifact-only Tests completion defers to the signer exact-SHA dispatch', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/deploy-site.yml'), 'utf8');
  assert.match(workflow, /group: deploy-site\s*\n[\s\S]*?cancel-in-progress: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(workflow, /ARTIFACT_ONLY: \$\{\{ steps\.changes\.outputs\.artifact \}\}/);
  assert.match(workflow, /EVENT_NAME" = "workflow_run".*ARTIFACT_ONLY" = "true".*FIRMWARE_SENSITIVE" != "true"/s);
  assert.match(workflow, /Signer artifact commits deploy only through their explicit signed-SHA dispatch/);
  assert.match(workflow, /EVENT_NAME" = "workflow_run".*FIRMWARE_SENSITIVE" = "true"/s);
});

test('deploy allows the Cloudflare asset graph to converge before declaring failure', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/deploy-site.yml'), 'utf8');
  const attempts = workflow.match(/for attempt in \$\(seq 1 (\d+)\); do/);
  assert.ok(attempts, 'live verification must use an explicit bounded retry count');
  assert.ok(Number(attempts[1]) >= 12, 'live verification must allow at least two minutes of edge convergence');
  assert.match(workflow, /sleep 10/);
});
