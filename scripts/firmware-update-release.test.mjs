import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..');
const builder = resolve(repoRoot, 'scripts/build-firmware-update-ticket.mjs');
const signer = resolve(repoRoot, 'scripts/sign-release-artifacts.mjs');
const buildId = 'a'.repeat(40);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lightweaver-update-release-'));
  const publicRoot = join(root, 'public');
  await mkdir(publicRoot, { recursive: true });
  const application = Buffer.alloc(4096, 0x31);
  application[0] = 0xe9;
  const table = Buffer.alloc(0x1000, 0xff);
  table.set(Buffer.from('LIGHTWEAVER-RAW-PARTITION-TABLE'));
  const factory = Buffer.alloc(0x10000 + application.byteLength, 0xff);
  table.copy(factory, 0x8000);
  application.copy(factory, 0x10000);
  const applicationPath = join(root, 'firmware.bin');
  const factoryPath = join(root, 'factory.bin');
  await writeFile(applicationPath, application);
  await writeFile(factoryPath, factory);
  return { root, publicRoot, application, applicationPath, factory, factoryPath, table };
}

function runBuilder(value, additions = []) {
  return spawnSync(process.execPath, [
    builder,
    '--application', value.applicationPath,
    '--factory', value.factoryPath,
    '--public-root', value.publicRoot,
    '--firmware-version', '1.2.3',
    '--build-id', buildId,
    '--build-number', '1216',
    '--firmware-api-min', '2',
    '--firmware-api-max', '2',
    '--project-schema-min', '3',
    '--project-schema-max', '3',
    '--minimum-updater-version', '1',
    '--minimum-bootstrap-build', '1198',
    ...additions,
  ], { encoding: 'utf8' });
}

test('builder publishes an immutable app and exact ticket bound to raw 0x8000-0x8fff bytes', async () => {
  const value = await fixture();
  const result = runBuilder(value);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  const ticketBytes = await readFile(output.ticketPath);
  const ticket = JSON.parse(ticketBytes);
  const immutableApplication = await readFile(output.immutableApplicationPath);

  assert.deepEqual(immutableApplication, value.application);
  assert.equal(ticketBytes.toString('utf8'), JSON.stringify(ticket));
  assert.equal(ticket.image.sha256, digest(value.application));
  assert.equal(ticket.image.size, value.application.byteLength);
  assert.equal(ticket.partition.tableSha256, digest(value.factory.subarray(0x8000, 0x9000)));
  assert.equal(ticket.partition.tableSha256, digest(value.table));
  assert.equal(ticket.preservation.dataPartitionsIncluded, false);
});

test('builder refuses an app artifact that is not the exact app0 payload inside the factory image', async () => {
  const value = await fixture();
  value.application[10] ^= 0xff;
  await writeFile(value.applicationPath, value.application);
  const result = runBuilder(value);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact app0 payload/i);
});

test('signer produces an IEEE-P1363 P-256 signature over the ticket file bytes exactly', async () => {
  const value = await fixture();
  const build = runBuilder(value);
  assert.equal(build.status, 0, build.stderr);
  const { ticketPath } = JSON.parse(build.stdout);
  const signaturePath = join(value.root, 'firmware-update-ticket.sig');
  const publicKeyPath = join(value.root, 'release-public.pem');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));

  const signed = spawnSync(process.execPath, [
    signer,
    '--kind', 'ticket',
    '--ticket', ticketPath,
    '--ticket-signature', signaturePath,
    '--public-key', publicKeyPath,
  ], {
    encoding: 'utf8',
    env: { ...process.env, LIGHTWEAVER_RELEASE_SIGNING_KEY: privatePem },
  });
  assert.equal(signed.status, 0, signed.stderr);
  const ticketBytes = await readFile(ticketPath);
  const signatureText = await readFile(signaturePath, 'utf8');
  const signature = Buffer.from(signatureText.trim(), 'base64url');
  assert.equal(signature.byteLength, 64);
  assert.equal(signatureText.length, 87);
  assert.equal(verify('sha256', ticketBytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), true);
  const altered = Buffer.concat([ticketBytes, Buffer.from('\n')]);
  assert.equal(verify('sha256', altered, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), false);
});

test('manifest builder emits coherent schema 2 descriptors and signed-update provenance', async () => {
  const value = await fixture();
  const build = runBuilder(value);
  assert.equal(build.status, 0, build.stderr);
  const { immutableApplicationPath, ticketPath } = JSON.parse(build.stdout);
  const ticketSignaturePath = join(dirname(ticketPath), 'firmware-update-ticket.sig');
  const publicKeyPath = join(value.root, 'release-public.pem');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const signed = spawnSync(process.execPath, [
    signer, '--kind', 'ticket', '--ticket', ticketPath,
    '--ticket-signature', ticketSignaturePath, '--public-key', publicKeyPath,
  ], { encoding: 'utf8', env: { ...process.env, LIGHTWEAVER_RELEASE_SIGNING_KEY: privatePem } });
  assert.equal(signed.status, 0, signed.stderr);

  const cardStudioReleasePath = join(value.root, 'card-studio-release.json');
  await writeFile(cardStudioReleasePath, JSON.stringify({
    schemaVersion: 1,
    buildId,
    buildNumber: 1216,
    projectSchema: { min: 3, max: 3 },
    firmwareApi: { min: 2, max: 2 },
    totalSize: 100,
    bundleSha256: 'b'.repeat(64),
    assets: [{
      route: '/studio/',
      brotli: { size: 100, sha256: 'c'.repeat(64) },
    }],
  }));
  const manifestBuilder = resolve(repoRoot, 'scripts/build-firmware-manifest.mjs');
  const result = spawnSync(process.execPath, [
    manifestBuilder,
    '--image', value.factoryPath,
    '--card-studio-release', cardStudioReleasePath,
    '--public-root', value.publicRoot,
    '--firmware-version', '1.2.3',
    '--build-id', buildId,
    '--build-number', '1216',
    '--source-revision', buildId,
    '--config-min', '1',
    '--config-max', '1',
    '--minimum-installer', '1.4.0',
    '--update-application', immutableApplicationPath,
    '--update-ticket', ticketPath,
    '--update-signature', ticketSignaturePath,
    '--public-key', publicKeyPath,
  ], { encoding: 'utf8', env: { ...process.env, GITHUB_RUN_ID: '777' } });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(value.publicRoot, 'firmware/release-manifest.json')));
  const provenance = JSON.parse(await readFile(join(value.publicRoot, 'firmware/release-provenance.json')));
  const ticket = JSON.parse(await readFile(ticketPath));

  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.update.image, ticket.image);
  assert.deepEqual(manifest.update.ticket, {
    url: ticketPath.slice(value.publicRoot.length),
    size: (await readFile(ticketPath)).byteLength,
    sha256: digest(await readFile(ticketPath)),
  });
  assert.deepEqual(manifest.update.signature, {
    url: ticketSignaturePath.slice(value.publicRoot.length),
    size: 87,
    sha256: digest(await readFile(ticketSignaturePath)),
  });
  assert.equal(provenance.schemaVersion, 2);
  assert.equal(provenance.workflowRun, '777');
  assert.deepEqual(provenance.update.partition, ticket.partition);
  assert.deepEqual(provenance.update.image, manifest.update.image);
});

test('published JSON schemas expose manifest v2 and the exact preserving ticket contract', async () => {
  const manifestSchema = JSON.parse(await readFile(resolve(repoRoot, 'release/firmware-manifest.schema.json')));
  const ticketSchema = JSON.parse(await readFile(resolve(repoRoot, 'release/firmware-update-ticket.schema.json')));
  assert.deepEqual(manifestSchema.properties.schemaVersion.enum, [1, 2]);
  assert.deepEqual(manifestSchema.properties.update.required, ['image', 'ticket', 'signature']);
  assert.equal(manifestSchema.properties.update.additionalProperties, false);
  assert.match(JSON.stringify(manifestSchema.allOf), /schemaVersion.*const.*2.*required.*update/);
  assert.deepEqual(ticketSchema.required, [
    'schemaVersion', 'firmwareVersion', 'buildId', 'buildNumber', 'target',
    'image', 'partition', 'compatibility', 'preservation',
  ]);
  assert.equal(ticketSchema.properties.partition.properties.layout.const, 'default_16MB.csv');
  assert.equal(ticketSchema.properties.partition.properties.app0Offset.const, 0x10000);
  assert.equal(ticketSchema.properties.partition.properties.app1Offset.const, 0x650000);
  assert.equal(ticketSchema.properties.partition.properties.slotSize.const, 0x640000);
  assert.equal(ticketSchema.properties.preservation.properties.dataPartitionsIncluded.const, false);
});

test('CI builds, signs, verifies, commits, and uploads the complete preserving release chain in order', async () => {
  const signerWorkflow = await readFile(resolve(repoRoot, '.github/workflows/build-firmware.yml'), 'utf8');
  const testsWorkflow = await readFile(resolve(repoRoot, '.github/workflows/test.yml'), 'utf8');
  const deployWorkflow = await readFile(resolve(repoRoot, '.github/workflows/deploy-site.yml'), 'utf8');
  const buildTicket = signerWorkflow.indexOf('node scripts/build-firmware-update-ticket.mjs');
  const signTicket = signerWorkflow.indexOf('--kind ticket');
  const buildManifest = signerWorkflow.indexOf('node scripts/build-firmware-manifest.mjs');
  const signManifest = signerWorkflow.indexOf('--kind manifest');
  assert.ok(buildTicket >= 0 && buildTicket < signTicket);
  assert.ok(signTicket < buildManifest);
  assert.ok(buildManifest < signManifest);
  for (const path of [
    'lightweaver-controller-esp32s3-app.bin',
    'firmware-update-ticket.json',
    'firmware-update-ticket.sig',
    'release-manifest.json',
    'release-manifest.sig',
    'release-provenance.json',
  ]) assert.match(signerWorkflow, new RegExp(path.replaceAll('.', '\\.')));
  assert.match(testsWorkflow, /node --test scripts\/firmware-update-release\.test\.mjs/);
  assert.match(deployWorkflow, /verify-production-artifacts\.mjs --root/);
  assert.match(deployWorkflow, /verify-production-artifacts\.mjs --origin https:\/\/led\.mandalacodes\.com/);
});

test('staged firmware release graph pins every published byte and detects artifact drift', async t => {
  const verifier = await import('./verify-production-artifacts.mjs');
  const root = await mkdtemp(join(tmpdir(), 'lightweaver-staged-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(resolve(repoRoot, 'lightweaver/public/firmware'), join(root, 'firmware'), { recursive: true });
  const graph = await verifier.createFirmwareReleaseBuildGraphFromRoot(root);
  const graphPath = join(root, ...verifier.FIRMWARE_RELEASE_BUILD_GRAPH_PATH.split('/'));
  await mkdir(dirname(graphPath), { recursive: true });
  await writeFile(graphPath, verifier.serializeFirmwareReleaseBuildGraph(graph));
  assert.deepEqual(await verifier.verifyProductionArtifactRoot(root), graph);

  const immutableFactory = graph.files.find(file => /releases\/.+factory\.bin$/.test(file.path));
  await writeFile(join(root, ...immutableFactory.path.split('/')), Buffer.from('tampered'));
  await assert.rejects(verifier.verifyProductionArtifactRoot(root), /factory bytes|graph does not match/i);
});

test('protected card build fixes firmware API 2 to the compiled capabilities version', async () => {
  const { resolveCardStudioReleaseIdentity } = await import('../lightweaver/scripts/build-card-studio.mjs');
  const resolved = resolveCardStudioReleaseIdentity({
    sourceRevision: 'a'.repeat(40),
    buildNumber: 1216,
  }, {});
  assert.deepEqual(resolved.firmwareApi, { min: 2, max: 2 });
  const cardBuilder = await readFile(resolve(repoRoot, 'lightweaver/scripts/build-card-studio.mjs'), 'utf8');
  const platform = await readFile(resolve(repoRoot, 'firmware/lightweaver-controller/platformio.ini'), 'utf8');
  const signerWorkflow = await readFile(resolve(repoRoot, '.github/workflows/build-firmware.yml'), 'utf8');
  assert.match(platform, /-DLW_CAPABILITIES_VERSION=2/);
  assert.match(cardBuilder, /CARD_STUDIO_FIRMWARE_API = Object\.freeze\(\{ min: 2, max: 2 \}\)/);
  assert.doesNotMatch(cardBuilder, /process\.env\.LW_FIRMWARE_API_/);
  const cardBuildStep = signerWorkflow.slice(
    signerWorkflow.indexOf('- name: Build the exact card-local Studio'),
    signerWorkflow.indexOf('- name: Rebuild tested factory binary'),
  );
  assert.match(cardBuildStep, /LW_FIRMWARE_API_MIN:\s*2/);
  assert.match(cardBuildStep, /LW_FIRMWARE_API_MAX:\s*2/);
});

test('required CI lanes run every preserving updater unit, browser, firmware, and boot contract', async () => {
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'lightweaver/package.json')));
  const testsWorkflow = await readFile(resolve(repoRoot, '.github/workflows/test.yml'), 'utf8');
  const unit = packageJson.scripts['test:firmware-update:unit'];
  const firmware = packageJson.scripts['test:firmware-update:firmware'];
  const browser = packageJson.scripts['test:firmware-update:browser'];
  for (const file of [
    'firmwareUpdateRelease.test.js', 'cardFirmwareUpdater.test.js', 'preservingUsbBootstrap.test.js',
  ]) assert.match(unit, new RegExp(file.replaceAll('.', '\\.')));
  for (const file of [
    'firmware-update-ticket.mjs', 'firmware-update-state.mjs',
    'firmware-update-web-contract.mjs', 'firmware-boot-health.mjs',
  ]) assert.match(firmware, new RegExp(file.replaceAll('.', '\\.')));
  assert.match(browser, /preserving-firmware-update\.spec\.ts/);
  assert.match(packageJson.scripts['ci:firmware-sensitive'], /test:firmware-update:unit/);
  assert.match(packageJson.scripts['ci:firmware-sensitive'], /test:firmware-update:firmware/);
  const browserJob = testsWorkflow.slice(
    testsWorkflow.indexOf('\n  browser:\n'),
    testsWorkflow.indexOf('\n  cloud:\n'),
  );
  assert.match(browserJob, /npm run test:firmware-update:browser/);
  assert.doesNotMatch(browserJob, /test:firmware-update:firmware/);
});

test('live firmware graph verification shares the bounded production convergence retry', async () => {
  const deployWorkflow = await readFile(resolve(repoRoot, '.github/workflows/deploy-site.yml'), 'utf8');
  const step = deployWorkflow.slice(
    deployWorkflow.indexOf('- name: Verify the live Production Setup release'),
    deployWorkflow.indexOf('- name: Resolve the published build numbers'),
  );
  const loop = step.indexOf('for attempt in $(seq 1 12)');
  const firmwareGraph = step.indexOf('verify-production-artifacts.mjs --origin');
  const studioCheck = step.indexOf('npm run check:prod');
  assert.ok(loop >= 0 && loop < firmwareGraph && firmwareGraph < studioCheck);
  assert.match(step, /if node \.\.\/scripts\/verify-production-artifacts\.mjs[\s\S]*&& npm run check:prod; then/);
});
