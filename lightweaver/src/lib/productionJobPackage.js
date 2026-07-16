import { EXPECTED_FIRMWARE_TARGET, MINIMUM_PRODUCTION_FIRMWARE_VERSION } from './firmwareRelease.js';
import { CARD_HARDWARE_CAPABILITIES } from './cardRuntimeContract.js';
import { prepareCardStoragePayload } from './cardStoragePayload.js';
import { fingerprintCommissioningProject } from './cardCommissioningFlow.js';
import { buildCardRuntimePackageFromProject } from './cardRuntimeProject.js';
import { normalizeWiring } from './wiringModel.js';
import { normalizeSavedLooks } from './sectionLookModel.js';
import { normalizeCardPlaylist } from './cardPlaylist.js';

export const PRODUCTION_JOB_SCHEMA_VERSION = 1;
export const PRODUCTION_JOB_FORMAT = 'lightweaver-production-job';
export const MAX_PRODUCTION_JOB_BYTES = 256 * 1024;
export const PRODUCTION_JOB_INDEX_URL = '/production/jobs/index.json';
export const PRODUCTION_JOB_SIGNATURE_ALGORITHM = 'ECDSA-P256-SHA256';
export const PRODUCTION_JOB_TRUST_SET_VERSION = 1;
export const PRODUCTION_JOB_ACTIVE_SIGNING_KEY_ID = 'lightweaver-production-job-2026-01';
export const PRODUCTION_JOB_TRUST_SET = Object.freeze({
  version: PRODUCTION_JOB_TRUST_SET_VERSION,
  keys: Object.freeze([Object.freeze({
    keyId: PRODUCTION_JOB_ACTIVE_SIGNING_KEY_ID,
    algorithm: PRODUCTION_JOB_SIGNATURE_ALGORITHM,
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKfTt4heGB/AB+L+zOf/1VxJmV8nj
LDtwvkBI9ksoQr8pFe3DAYW0lFq93B2LZ7UAgNEE7sBS/6W3+r3rQJmZYA==
-----END PUBLIC KEY-----`,
  })]),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BUILD_PATTERN = /^[a-f0-9]{40}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const TOP_KEYS = ['artwork', 'batch', 'configuration', 'digest', 'expectedOutputs', 'firmware', 'format', 'jobId', 'label', 'project', 'schemaVersion'];
const SOURCE_TOP_KEYS = TOP_KEYS.filter(key => key !== 'digest');
const FIRMWARE_KEYS = ['buildId', 'minimumVersion', 'target', 'version'];
const PROJECT_KEYS = ['fingerprint', 'id', 'restoreSnapshot', 'revision'];
const PACKAGE_KEYS = ['app', 'config', 'format', 'version'];
const CONFIG_KEYS = ['controls', 'led', 'looks', 'mode', 'patterns', 'piece', 'productionJobDigest', 'productionJobId', 'projectFingerprint', 'projectRevision', 'startupPatternId', 'syncZones', 'version', 'zones'];
const OUTPUT_KEYS = ['colorOrder', 'direction', 'id', 'label', 'pin', 'pixels'];
const LED_KEYS = ['brightnessLimit', 'colorOrder', 'outputs', 'pixels'];
const LED_OUTPUT_KEYS = ['id', 'name', 'pin', 'pixels'];
const CONTROL_KEYS = ['blackout', 'brightness', 'encoder', 'next', 'previous', 'statusLed'];
const ENCODER_KEYS = ['a', 'alternatePress', 'b', 'brightnessStep', 'press', 'rotateDirection'];
const ENCODER_OPTIONAL_KEYS = ['patternCycleIds'];
const INDEX_KEYS = ['jobs', 'schemaVersion'];
const INDEX_ENTRY_KEYS = ['artifactSha256', 'digest', 'jobId', 'label', 'size', 'url'];
const SNAPSHOT_KEYS = ['devices', 'id', 'layout', 'name', 'version'];
const SNAPSHOT_LAYOUT_KEYS = ['patchBoard', 'strips', 'wiring'];
const SNAPSHOT_DEVICES_KEYS = ['standaloneController'];
const STRIP_REQUIRED_KEYS = ['id', 'name', 'pixelCount'];
const STRIP_OPTIONAL_KEYS = ['angle', 'brightness', 'closed', 'color', 'emit', 'generatedLayout', 'hueShift', 'layoutRole', 'pathData', 'patternId', 'pixels', 'reversed', 'sourceLayerId', 'sourcePathId', 'speed', 'svgLength', 'visible', 'x', 'y'];
const STANDALONE_KEYS = ['activeLookId', 'controls', 'defaultLook', 'led', 'looks', 'outputs', 'playlist', 'runtimeMode'];
const STANDALONE_OPTIONAL_KEYS = ['activeLookId', 'looks', 'runtimeMode'];
const STANDALONE_REQUIRED_KEYS = STANDALONE_KEYS.filter(key => !STANDALONE_OPTIONAL_KEYS.includes(key));
const STANDALONE_LED_KEYS = ['brightnessLimit', 'colorOrder', 'type'];
const VISUAL_LOOK_KEYS = ['brightness', 'customBreathe', 'customDrift', 'customHue', 'customSaturation', 'hueShift', 'patternId', 'speed'];
const PLAYLIST_PATTERN_KEYS = ['createdAt', 'enabled', 'id', 'label', 'patternId', 'type'];
const PLAYLIST_COMBO_KEYS = ['createdAt', 'enabled', 'id', 'label', 'lookId', 'type'];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer);
}

function clone(value) {
  assertJsonValue(value);
  return JSON.parse(JSON.stringify(value));
}

function assertJsonValue(value, path = 'production job') {
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) throw new Error(`${path} contains a non-canonical number`);
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
  if (Array.isArray(value)) return value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
  if (!isObject(value)) throw new Error(`${path} contains a non-JSON value`);
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_NESTED_KEY.test(key)) throw new Error(`${path} contains unsupported fields`);
    assertJsonValue(nested, `${path}.${key}`);
  }
}

const FORBIDDEN_NESTED_KEY = /(wifi|ssid|password|credential|secret|token|apiKey|privateKey|auth|__proto__|prototype|constructor|serial(path|number)|firmware(bytes|binary)|raw(error|exception)|stack)/i;

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortCanonical(value[key])]));
  }
  return value;
}

// The job digest cannot hash literal copies of itself. Its canonical digest
// projection omits top-level `digest` and replaces the card-bound duplicate
// `configuration.config.productionJobDigest` with 64 ASCII zeroes. All other
// values are canonical key-sorted JSON encoded as UTF-8 without whitespace.
export function canonicalProductionJobBytes(job, { omitDigest = false } = {}) {
  assertJsonValue(job);
  const projected = clone(job);
  if (omitDigest) {
    delete projected.digest;
    if (isObject(projected.configuration?.config) && 'productionJobDigest' in projected.configuration.config) {
      projected.configuration.config.productionJobDigest = '0'.repeat(64);
    }
  }
  return encoder.encode(JSON.stringify(sortCanonical(projected)));
}

function stableJson(value) {
  return JSON.stringify(sortCanonical(value));
}

async function sha256(bytes, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error('Secure SHA-256 verification is unavailable');
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function exactRequiredAndOptionalKeys(value, required, optional, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const keys = Object.keys(value);
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error(`${label} contains unsupported fields or is incomplete`);
  }
}

function parseSemver(value, label) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`${label} must be a semantic version`);
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function requiredText(value, label, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
}

function validateRestoreSnapshot(snapshot) {
  exactKeys(snapshot, SNAPSHOT_KEYS, 'restore snapshot');
  exactKeys(snapshot.layout, SNAPSHOT_LAYOUT_KEYS, 'restore snapshot layout');
  exactKeys(snapshot.devices, SNAPSHOT_DEVICES_KEYS, 'restore snapshot devices');
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) throw new Error('Restore snapshot version is invalid');
  requiredText(snapshot.id, 'Restore snapshot ID', 128);
  requiredText(snapshot.name, 'Restore snapshot name', 160);
  if (!Array.isArray(snapshot.layout.strips) || snapshot.layout.strips.length === 0) throw new Error('Restore snapshot strips are required');
  for (const strip of snapshot.layout.strips) {
    exactRequiredAndOptionalKeys(strip, STRIP_REQUIRED_KEYS, STRIP_OPTIONAL_KEYS, 'restore snapshot strip');
    requiredText(strip.id, 'Restore strip ID', 128);
    requiredText(strip.name, 'Restore strip name', 160);
    if (!Number.isSafeInteger(strip.pixelCount) || strip.pixelCount <= 0) throw new Error('Restore strip pixel count is invalid');
    if (strip.pixels !== undefined && (!Array.isArray(strip.pixels) || strip.pixels.length !== strip.pixelCount)) throw new Error('Restore strip pixels must match pixel count');
  }
  if (snapshot.layout.patchBoard !== null) throw new Error('Canonical production restore snapshot patch board must be null when exact wiring is present');
  const wiring = snapshot.layout.wiring;
  if (!isObject(wiring) || stableJson(normalizeWiring(wiring)) !== stableJson(wiring)) throw new Error('Restore snapshot wiring contains unsupported fields or non-canonical values');
  if (wiring.controllerAnchor !== null) {
    exactKeys(wiring.controllerAnchor, ['x', 'y'], 'restore snapshot controller anchor');
    if (!Number.isFinite(wiring.controllerAnchor.x) || !Number.isFinite(wiring.controllerAnchor.y)) throw new Error('Restore snapshot controller anchor is invalid');
  }
  if (wiring.migrationWarnings.length !== 0) throw new Error('Production restore snapshot cannot contain wiring migration warnings');
  const standalone = snapshot.devices.standaloneController;
  exactRequiredAndOptionalKeys(standalone, STANDALONE_REQUIRED_KEYS, STANDALONE_OPTIONAL_KEYS, 'restore snapshot standalone controller');
  if (!Array.isArray(standalone.outputs) || standalone.outputs.length === 0) throw new Error('Restore snapshot standalone outputs are required');
  standalone.outputs.forEach(output => exactKeys(output, LED_OUTPUT_KEYS, 'restore snapshot standalone output'));
  exactKeys(standalone.controls, CONTROL_KEYS, 'restore snapshot controls');
  exactRequiredAndOptionalKeys(standalone.controls.encoder, ENCODER_KEYS, ENCODER_OPTIONAL_KEYS, 'restore snapshot encoder controls');
  exactKeys(standalone.led, STANDALONE_LED_KEYS, 'restore snapshot LED settings');
  exactKeys(standalone.defaultLook, VISUAL_LOOK_KEYS, 'restore snapshot default look');
  if (!Array.isArray(standalone.looks || []) || stableJson(normalizeSavedLooks(standalone.looks)) !== stableJson(standalone.looks)) throw new Error('Restore snapshot saved looks contain unsupported fields or non-canonical values');
  if (!Array.isArray(standalone.playlist)) throw new Error('Restore snapshot playlist is invalid');
  standalone.playlist.forEach(item => {
    if (item?.type === 'pattern') exactKeys(item, PLAYLIST_PATTERN_KEYS, 'restore snapshot pattern playlist item');
    else if (item?.type === 'combo') exactKeys(item, PLAYLIST_COMBO_KEYS, 'restore snapshot combo playlist item');
    else throw new Error('Restore snapshot playlist item type is invalid');
  });
  if (stableJson(normalizeCardPlaylist(standalone.playlist, { savedLooks: standalone.looks, allowEmpty: true })) !== stableJson(standalone.playlist)) throw new Error('Restore snapshot playlist contains unsupported fields or non-canonical values');
}

function rebuildRuntime(job, productionJobDigest) {
  const snapshot = job.project.restoreSnapshot;
  return buildCardRuntimePackageFromProject({
    projectId: snapshot.id,
    projectName: snapshot.name,
    projectRevision: job.project.revision,
    projectFingerprint: job.project.fingerprint,
    productionJobId: job.jobId,
    productionJobDigest,
    strips: snapshot.layout.strips,
    patchBoard: snapshot.layout.patchBoard,
    wiring: snapshot.layout.wiring,
    standaloneController: snapshot.devices.standaloneController,
  });
}

function assertPackageShape(job, { source = false } = {}) {
  exactKeys(job, source ? SOURCE_TOP_KEYS : TOP_KEYS, 'production job');
  if (job.schemaVersion !== PRODUCTION_JOB_SCHEMA_VERSION) throw new Error('Unsupported production job schema');
  if (job.format !== PRODUCTION_JOB_FORMAT) throw new Error('Production job format is invalid');
  if (!ID_PATTERN.test(job.jobId || '')) throw new Error('Production job ID is invalid');
  requiredText(job.label, 'Production job label');
  requiredText(job.artwork, 'Artwork label');
  requiredText(job.batch, 'Batch label');

  exactKeys(job.firmware, FIRMWARE_KEYS, 'firmware requirement');
  if (job.firmware.target !== EXPECTED_FIRMWARE_TARGET) throw new Error('Production job firmware target is not ESP32-S3 16MB');
  const version = parseSemver(job.firmware.version, 'firmware version');
  const floor = parseSemver(job.firmware.minimumVersion, 'firmware minimum version');
  const trustedFloor = parseSemver(MINIMUM_PRODUCTION_FIRMWARE_VERSION, 'minimum trusted version');
  if (job.firmware.minimumVersion !== MINIMUM_PRODUCTION_FIRMWARE_VERSION || compareSemver(floor, trustedFloor) < 0) {
    throw new Error(`Firmware minimum trusted version must be exactly ${MINIMUM_PRODUCTION_FIRMWARE_VERSION}`);
  }
  if (compareSemver(version, floor) < 0) throw new Error('Required firmware is older than its minimum trusted version');
  if (!BUILD_PATTERN.test(job.firmware.buildId || '')) throw new Error('Firmware build ID must be an exact immutable source revision');

  exactKeys(job.project, PROJECT_KEYS, 'project identity');
  requiredText(job.project.id, 'Project ID', 128);
  if (!Number.isSafeInteger(job.project.revision) || job.project.revision < 0 || job.project.revision > 0xffffffff) {
    throw new Error('Project revision must be exact and non-negative');
  }
  if (!/^[a-f0-9]{16,64}$/.test(job.project.fingerprint || '')) throw new Error('Project fingerprint must be exact lowercase hex');
  if (!isObject(job.project.restoreSnapshot)) throw new Error('Canonical project restore snapshot is required');
  validateRestoreSnapshot(job.project.restoreSnapshot);
  if (job.project.id !== job.project.restoreSnapshot.id) throw new Error('Project ID does not match the restore snapshot');
  if (fingerprintCommissioningProject(job.project.restoreSnapshot) !== job.project.fingerprint) throw new Error('Project restore snapshot fingerprint mismatch');

  exactKeys(job.configuration, PACKAGE_KEYS, 'runtime configuration package');
  if (job.configuration.app !== 'Lightweaver' || job.configuration.format !== 'lightweaver-card-runtime-package' || job.configuration.version !== 1) {
    throw new Error('Runtime configuration package is invalid');
  }
  const config = job.configuration.config;
  if (!isObject(config)) throw new Error('Complete runtime configuration is required');
  exactKeys(config, CONFIG_KEYS, 'runtime configuration');
  if (config.projectRevision !== job.project.revision) throw new Error('Runtime configuration project revision does not match the job');
  if (config.projectFingerprint !== job.project.fingerprint) throw new Error('Runtime configuration project fingerprint does not match the job');
  if (config.productionJobId !== job.jobId) throw new Error('Runtime configuration production job ID does not match the job');
  if (!source && config.productionJobDigest !== job.digest) throw new Error('Production job digest mismatch in runtime configuration');
  if (source && config.productionJobDigest !== '0'.repeat(64) && config.productionJobDigest !== undefined) {
    throw new Error('Source production job digest must be omitted or the documented zero placeholder');
  }

  exactKeys(config.led, LED_KEYS, 'LED configuration');
  if (!Array.isArray(config.led.outputs) || config.led.outputs.length === 0) throw new Error('At least one configured LED output is required');
  config.led.outputs.forEach(output => exactKeys(output, LED_OUTPUT_KEYS, 'configured LED output'));
  try {
    exactKeys(config.controls, CONTROL_KEYS, 'controls');
    exactRequiredAndOptionalKeys(config.controls.encoder, ENCODER_KEYS, ENCODER_OPTIONAL_KEYS, 'encoder controls');
  } catch (error) {
    throw new Error(`Firmware controls must be complete: ${error.message}`);
  }
  for (const key of [...CONTROL_KEYS.filter(key => key !== 'encoder'), ...ENCODER_KEYS]) {
    const value = ENCODER_KEYS.includes(key) ? config.controls.encoder[key] : config.controls[key];
    if (value === undefined || value === null) throw new Error('Firmware controls must be complete');
  }
  CARD_HARDWARE_CAPABILITIES.assertSupported(config);
  const outputPixelTotal = config.led.outputs.reduce((sum, output) => sum + output.pixels, 0);
  if (outputPixelTotal !== config.led.pixels || outputPixelTotal > CARD_HARDWARE_CAPABILITIES.maxPixels) throw new Error('LED pixels must equal the bounded sum of configured outputs');
  prepareCardStoragePayload(job.configuration);
  const expectedDigest = source ? '0'.repeat(64) : job.digest;
  if (stableJson(rebuildRuntime(job, expectedDigest)) !== stableJson(job.configuration)) throw new Error('Production job compiled runtime does not exactly match the restore snapshot');

  if (!Array.isArray(job.expectedOutputs) || job.expectedOutputs.length !== config.led.outputs.length) {
    throw new Error('Every configured output requires one expected output');
  }
  const expectedIds = new Set(job.expectedOutputs.map(output => output?.id));
  if (expectedIds.size !== job.expectedOutputs.length || config.led.outputs.some(output => !expectedIds.has(output.id))) {
    throw new Error('Expected output IDs must be unique and cover every configured output');
  }
  for (const expected of job.expectedOutputs) {
    exactKeys(expected, OUTPUT_KEYS, 'expected output');
    requiredText(expected.id, 'Expected output ID', 64);
    requiredText(expected.label, 'Expected output label', 128);
    if (!['forward', 'reverse'].includes(expected.direction)) throw new Error('Expected output direction is invalid');
    if (!['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'].includes(expected.colorOrder)) throw new Error('Expected output color order is invalid');
    const configured = config.led.outputs.find(output => output.id === expected.id);
    if (!configured || configured.pin !== expected.pin || configured.pixels !== expected.pixels || config.led.colorOrder !== expected.colorOrder) {
      throw new Error(`Expected output ${expected.id} does not exactly match the compiled configuration`);
    }
    const wiringOutput = job.project.restoreSnapshot.layout.wiring.outputs.find(output => output.id === expected.id);
    if (!wiringOutput || wiringOutput.pin !== expected.pin) throw new Error(`Expected output ${expected.id} does not match canonical wiring GPIO`);
    const runs = wiringOutput.runIds.map(runId => job.project.restoreSnapshot.layout.wiring.runs.find(run => run.id === runId)).filter(run => run?.type === 'strip');
    const directions = new Set(runs.map(run => run.physicalDirection === 'source-reverse' ? 'reverse' : 'forward'));
    if (directions.size !== 1 || !directions.has(expected.direction)) throw new Error(`Expected output ${expected.id} does not match canonical wiring direction`);
  }
}

function bytesFromInput(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input === 'string') return encoder.encode(input);
  return canonicalProductionJobBytes(input);
}

function objectFromInput(input, bytes) {
  if (isObject(input)) return clone(input);
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error('Production job is not valid UTF-8 JSON');
  }
}

export async function buildProductionJob(source, { cryptoImpl = globalThis.crypto } = {}) {
  const job = { format: PRODUCTION_JOB_FORMAT, ...clone(source) };
  assertPackageShape(job, { source: true });
  const digest = await sha256(canonicalProductionJobBytes(job, { omitDigest: true }), cryptoImpl);
  job.digest = digest;
  job.configuration.config.productionJobDigest = digest;
  assertPackageShape(job);
  if (canonicalProductionJobBytes(job).byteLength > MAX_PRODUCTION_JOB_BYTES) {
    throw new Error('Production job exceeds the 256 KiB UTF-8 package limit');
  }
  return job;
}

export async function parseProductionJobPackage(input, { trust, cryptoImpl = globalThis.crypto } = {}) {
  const bytes = bytesFromInput(input);
  if (bytes.byteLength > MAX_PRODUCTION_JOB_BYTES) throw new Error('Production job exceeds the 256 KiB UTF-8 package limit');
  const job = objectFromInput(input, bytes);
  assertPackageShape(job);
  if (!DIGEST_PATTERN.test(job.digest || '')) throw new Error('Production job digest is invalid');
  const computed = await sha256(canonicalProductionJobBytes(job, { omitDigest: true }), cryptoImpl);
  if (computed !== job.digest) throw new Error('Production job digest mismatch');

  if (trust?.kind === 'same-origin-index') {
    if (trust.expectedDigest !== job.digest) throw new Error('Production job does not match its trusted index digest');
  } else if (trust?.kind === 'external') {
    if (isObject(input)) throw new Error('External production job signature must bind the exact imported artifact bytes');
    const signature = trust.signature;
    if (!isObject(signature)) throw new Error('External production job requires a detached signature envelope');
    exactKeys(signature, ['algorithm', 'keyId', 'value'], 'production-job signature envelope');
    if (signature.algorithm !== PRODUCTION_JOB_SIGNATURE_ALGORITHM) throw new Error('External production-job signature algorithm is not trusted');
    const verified = await verifyProductionJobSignature(bytes, signature, cryptoImpl, PRODUCTION_JOB_TRUST_SET);
    if (!verified) throw new Error('External production-job signature verification failed');
  } else {
    throw new Error('Production job trust source is required');
  }
  return job;
}

function pemToDer(pem) {
  const base64 = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
  const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Production-job signature encoding is invalid');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function productionJobSignedBytes(artifactBytes, keyId) {
  const body = bytesFromInput(artifactBytes);
  const domain = encoder.encode(`Lightweaver production job signature\0v1\0${keyId}\0`);
  const signed = new Uint8Array(domain.byteLength + body.byteLength);
  signed.set(domain);
  signed.set(body, domain.byteLength);
  return signed;
}

export async function verifyProductionJobSignature(artifactBytes, signature, cryptoImpl = globalThis.crypto, trustSet = PRODUCTION_JOB_TRUST_SET) {
  if (!cryptoImpl?.subtle) throw new Error('Secure production-job signature verification is unavailable');
  if (trustSet?.version !== PRODUCTION_JOB_TRUST_SET_VERSION || !Array.isArray(trustSet.keys)) throw new Error('Production-job trust set is invalid');
  const trusted = trustSet.keys.find(key => key.keyId === signature?.keyId && key.algorithm === signature?.algorithm);
  if (!trusted) throw new Error(`External production-job signature key ID is not trusted by trust set v${PRODUCTION_JOB_TRUST_SET_VERSION}`);
  const signatureBytes = decodeBase64Url(signature.value);
  if (signatureBytes.byteLength !== 64) throw new Error('Production-job signature length is invalid');
  const key = await cryptoImpl.subtle.importKey('spki', pemToDer(trusted.publicKeyPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return cryptoImpl.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, productionJobSignedBytes(artifactBytes, trusted.keyId));
}

function validateIndexEntry(entry) {
  assertJsonValue(entry, 'production job index entry');
  exactKeys(entry, INDEX_ENTRY_KEYS, 'production job index entry');
  if (!ID_PATTERN.test(entry.jobId || '')) throw new Error('Production job index ID is invalid');
  requiredText(entry.label, 'Production job index label');
  if (!DIGEST_PATTERN.test(entry.digest || '') || !DIGEST_PATTERN.test(entry.artifactSha256 || '')) throw new Error('Production job index digest is invalid');
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_PRODUCTION_JOB_BYTES) throw new Error('Production job index size is invalid');
  if (entry.url !== `/production/jobs/${entry.digest}.lwjob.json`) throw new Error('Production job URL digest does not match the index');
}

export async function loadProductionJobIndex(fetchImpl = globalThis.fetch, { url = PRODUCTION_JOB_INDEX_URL } = {}) {
  if (url !== PRODUCTION_JOB_INDEX_URL) throw new Error('Production job index must use the fixed same-origin URL');
  const response = await fetchImpl(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!response?.ok || response.redirected) throw new Error('Unable to load the production job index');
  let index;
  try { index = JSON.parse(await response.text()); } catch { throw new Error('Production job index is not valid JSON'); }
  return validateProductionJobIndex(index);
}

export function validateProductionJobIndex(index) {
  assertJsonValue(index, 'production job index');
  exactKeys(index, INDEX_KEYS, 'production job index');
  if (index.schemaVersion !== 1 || !Array.isArray(index.jobs)) throw new Error('Production job index schema is unsupported');
  index.jobs.forEach(validateIndexEntry);
  const ids = new Set();
  const digests = new Set();
  for (const entry of index.jobs) {
    if (ids.has(entry.jobId) || digests.has(entry.digest)) throw new Error('Production job index contains duplicate job IDs or digests');
    ids.add(entry.jobId); digests.add(entry.digest);
  }
  return index;
}

async function readBoundedArtifact(response, expectedSize) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Production job artifact cannot be read as a bounded stream');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > MAX_PRODUCTION_JOB_BYTES) {
        await reader.cancel?.();
        throw new Error('Production job exceeds the 256 KiB UTF-8 package limit');
      }
      if (total > expectedSize) {
        await reader.cancel?.();
        throw new Error('Production job artifact size mismatch');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  if (total !== expectedSize) throw new Error('Production job artifact size mismatch');
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function loadProductionJobFromIndexEntry(entry, { fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto } = {}) {
  const trustedEntry = clone(entry);
  validateIndexEntry(trustedEntry);
  const response = await fetchImpl(trustedEntry.url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!response?.ok || response.redirected) throw new Error('Unable to load the production job artifact');
  const declared = response.headers?.get?.('content-length');
  const encoded = response.headers?.get?.('content-encoding');
  if (!encoded && declared !== null && declared !== undefined && Number(declared) !== trustedEntry.size) throw new Error('Production job artifact size mismatch');
  const body = await readBoundedArtifact(response, trustedEntry.size);
  if (await sha256(body, cryptoImpl) !== trustedEntry.artifactSha256) throw new Error('Production job artifact body hash mismatch');
  const job = await parseProductionJobPackage(body, { trust: { kind: 'same-origin-index', expectedDigest: trustedEntry.digest }, cryptoImpl });
  if (job.jobId !== trustedEntry.jobId) throw new Error('Production job artifact job ID does not match its index entry');
  if (job.label !== trustedEntry.label) throw new Error('Production job artifact label does not match its index entry');
  return job;
}
