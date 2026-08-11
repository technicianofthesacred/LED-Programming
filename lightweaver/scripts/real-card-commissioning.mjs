#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const REQUEST_TIMEOUT_MS = 8_000;
const CARD_ID_PATTERN = /^lw-[a-z0-9-]{4,64}$/i;
const BUILD_ID_PATTERN = /^[a-f0-9]{40}$/i;
const EXPECTED_PATTERNS = [
  { id: 'aurora', label: 'Aurora' },
  { id: 'fire', label: 'Fire' },
  { id: 'ocean', label: 'Ocean' },
];
const UPDATE_STATUS_FIELDS = [
  'phase', 'receivedBytes', 'expectedBytes', 'expectedBuildId', 'activeSlot',
  'pendingSlot', 'lastError', 'rollbackReason', 'rebootCorrelation',
  'restoredFirmwareVersion', 'restoredBuildId', 'restoredBuildNumber',
];

function requiredText(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function cardBaseUrl(cardHost) {
  const host = requiredText(cardHost, 'CARD_HOST');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('CARD_HOST must use HTTP or HTTPS.');
  if (url.username || url.password || url.search || url.hash) throw new Error('CARD_HOST must be a plain card host or base URL.');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

function exactExpectedIdentity(expectedCardId, expectedBuildId) {
  const cardId = requiredText(expectedCardId, 'EXPECTED_CARD_ID');
  const buildId = requiredText(expectedBuildId, 'EXPECTED_BUILD_ID').toLowerCase();
  if (!CARD_ID_PATTERN.test(cardId)) throw new Error('EXPECTED_CARD_ID is not a valid Lightweaver card ID.');
  if (!BUILD_ID_PATTERN.test(buildId)) throw new Error('EXPECTED_BUILD_ID must be the exact 40-character firmware build ID.');
  return { cardId, buildId };
}

function requiredInteger(value, name, minimum, maximum) {
  const normalized = requiredText(value, name);
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function exactExpectedHardware(expectedOutputPin, expectedPixels, expectedChipset, expectedColorOrder) {
  const outputPin = requiredInteger(expectedOutputPin, 'EXPECTED_OUTPUT_PIN', 0, 255);
  const pixels = requiredInteger(expectedPixels, 'EXPECTED_PIXELS', 1, 65_535);
  const chipset = requiredText(expectedChipset, 'EXPECTED_CHIPSET');
  const colorOrder = requiredText(expectedColorOrder, 'EXPECTED_COLOR_ORDER');
  if (!/^[a-z0-9][a-z0-9+._-]{1,31}$/i.test(chipset)) {
    throw new Error('EXPECTED_CHIPSET is not a valid LED chipset name.');
  }
  if (!['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR'].includes(colorOrder)) {
    throw new Error('EXPECTED_COLOR_ORDER must be a supported three-channel color order.');
  }
  return { outputPin, pixels, chipset, colorOrder };
}

function exactExpectedProject(expectedProjectId, expectedProjectFingerprint) {
  const projectId = requiredText(expectedProjectId, 'EXPECTED_PROJECT_ID');
  const projectFingerprint = requiredText(
    expectedProjectFingerprint, 'EXPECTED_PROJECT_FINGERPRINT',
  );
  if (projectId.length > 96) throw new Error('EXPECTED_PROJECT_ID must be at most 96 characters.');
  if (!/^[a-f0-9]{16,64}$/.test(projectFingerprint)) {
    throw new Error('EXPECTED_PROJECT_FINGERPRINT must be 16 to 64 lowercase hex characters.');
  }
  return { projectId, projectFingerprint };
}

async function readCardJson(baseUrl, pathname, fetchImpl, timeoutMs, { requireApp = true } = {}) {
  const url = new URL(pathname, baseUrl);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error(`${pathname} did not return JSON.`);
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`${pathname} returned an invalid JSON object.`);
  if ((requireApp || payload.app !== undefined) && payload.app !== 'Lightweaver') {
    throw new Error(`${pathname} did not identify a Lightweaver card.`);
  }
  return payload;
}

function assertIdentity(label, payload, expected, { required = true } = {}) {
  if ((required || payload.cardId !== undefined) && payload.cardId !== expected.cardId) {
    throw new Error(`${label} card ID ${payload.cardId || '(missing)'} did not match expected ${expected.cardId}.`);
  }
  const actualBuildId = payload.buildId === undefined ? '' : String(payload.buildId).toLowerCase();
  if ((required || payload.buildId !== undefined) && actualBuildId !== expected.buildId) {
    throw new Error(`${label} build ID ${actualBuildId || '(missing)'} did not match expected ${expected.buildId}.`);
  }
}

function assertFirmwareMetadata(firmware, status) {
  if (typeof firmware.bootId !== 'string' || !firmware.bootId.trim()) {
    throw new Error('/api/firmware-info bootId is required.');
  }
  if (typeof status.bootId !== 'string' || !status.bootId.trim()) {
    throw new Error('/api/status bootId is required.');
  }
  if (typeof firmware.firmwareVersion !== 'string' || !firmware.firmwareVersion.trim()) {
    throw new Error('/api/firmware-info firmwareVersion is required.');
  }
  if (typeof status.firmwareVersion !== 'string' || !status.firmwareVersion.trim()) {
    throw new Error('/api/status firmwareVersion is required.');
  }
  if (!Number.isSafeInteger(firmware.buildNumber) || firmware.buildNumber < 0) {
    throw new Error('/api/firmware-info buildNumber is required.');
  }
  if (!Number.isSafeInteger(status.buildNumber) || status.buildNumber < 0) {
    throw new Error('/api/status buildNumber is required.');
  }
  if (status.firmwareVersion !== firmware.firmwareVersion) {
    throw new Error('Status firmware version did not match firmware-info read-back.');
  }
  if (status.buildNumber !== firmware.buildNumber) {
    throw new Error('Status build number did not match firmware-info read-back.');
  }
  if (status.bootId !== firmware.bootId) {
    throw new Error('Status boot ID did not match firmware-info read-back.');
  }
}

function assertExpectedHardware(status, expected) {
  if (!Array.isArray(status.outputs) || status.outputs.length !== 1) {
    throw new Error('Card hardware must report exactly one configured output.');
  }
  const output = status.outputs[0] || {};
  if (output.pin !== undefined && output.gpio !== undefined
    && Number(output.pin) !== Number(output.gpio)) {
    throw new Error('Card output pin aliases disagree.');
  }
  const pixelAliases = [output.pixels, output.pixelCount, output.count]
    .filter(value => value !== undefined).map(Number);
  if (pixelAliases.some(value => value !== pixelAliases[0])) {
    throw new Error('Card output pixel aliases disagree.');
  }
  const led = status.led && typeof status.led === 'object' && !Array.isArray(status.led)
    ? status.led : {};
  const actual = {
    outputPin: Number(output.pin ?? output.gpio),
    pixels: Number(output.pixels ?? output.pixelCount ?? output.count),
    chipset: String(led.type ?? ''),
    colorOrder: String(led.colorOrder ?? ''),
  };
  if (actual.outputPin !== expected.outputPin || actual.pixels !== expected.pixels
    || actual.chipset !== expected.chipset || actual.colorOrder !== expected.colorOrder) {
    throw new Error(`Card hardware read-back changed: ${JSON.stringify(actual)}`);
  }
  const ledPixels = Number(led.pixels);
  const flatPixels = status.pixels === undefined ? expected.pixels : Number(status.pixels);
  const flatPin = status.outputPin === undefined ? expected.outputPin : Number(status.outputPin);
  const flatColorOrder = status.colorOrder === undefined ? expected.colorOrder : String(status.colorOrder);
  if (ledPixels !== expected.pixels || flatPixels !== expected.pixels
    || flatPin !== expected.outputPin || flatColorOrder !== expected.colorOrder) {
    throw new Error(`Card aggregate pixel read-back changed: ${JSON.stringify({
      outputPixels: actual.pixels, ledPixels, statusPixels: flatPixels,
    })}`);
  }
  return actual;
}

function assertExpectedProject(status, expected) {
  if (status.projectId !== expected.projectId) {
    throw new Error(`Status project ID ${status.projectId || '(missing)'} did not match expected ${expected.projectId}.`);
  }
  if (status.projectFingerprint !== expected.projectFingerprint) {
    throw new Error(`Status project fingerprint ${status.projectFingerprint || '(missing)'} did not match expected ${expected.projectFingerprint}.`);
  }
}

function assertRuntimeAcceptance(status) {
  if (status.ok !== true) throw new Error('Status did not report ok=true.');
  if (status.runtimePhase !== 'ready') throw new Error('Status runtime phase was not ready.');
  if (status.knownGoodProject !== true) throw new Error('Status did not report a known-good project.');
  if (status.commandReady !== true) throw new Error('Status did not report command ready.');
  if (status.playbackReady !== true) throw new Error('Status did not report playback ready.');
  if (status.outputReady !== true) throw new Error('Status did not report output ready.');
}

function assertWiringAcceptance(wiring, expectedHardware) {
  if (wiring.ok !== true) throw new Error('Wiring status did not report ok=true.');
  if (wiring.state !== 'known-good') throw new Error('Wiring status was not known-good.');
  if (wiring.hasKnownGood !== true) throw new Error('Wiring status did not report hasKnownGood=true.');
  if (wiring.outputsReady !== true) throw new Error('Wiring status did not report outputsReady=true.');
  if (wiring.testing !== false) throw new Error('Wiring status did not report testing=false; a wiring test is still active.');
  if (wiring.hasCandidate !== false) throw new Error('Wiring status did not report hasCandidate=false; a wiring candidate is still present.');
  if (wiring.candidateState !== 'none') throw new Error('Wiring status did not report candidateState=none.');
  if (wiring.activationId !== undefined
    || (Array.isArray(wiring.candidateOutputs) && wiring.candidateOutputs.length)) {
    throw new Error('Wiring status contained stale candidate evidence.');
  }
  if (wiring.bootedCandidate !== false) throw new Error('Wiring status did not report bootedCandidate=false.');
  if (wiring.discoveryActive !== false) throw new Error('Wiring status did not report discoveryActive=false.');
  if (wiring.discovery !== undefined) throw new Error('Wiring status contained stale discovery evidence.');
  if (wiring.remainingProbationMs !== 0) throw new Error('Wiring status did not report remainingProbationMs=0.');
  if (wiring.colorOrder !== expectedHardware.colorOrder) {
    throw new Error(`Wiring color order did not match expected ${expectedHardware.colorOrder}.`);
  }
  const currentOutputs = wiring.currentOutputs;
  if (!Array.isArray(currentOutputs) || currentOutputs.length !== 1
    || Number(currentOutputs[0]?.pin) !== expectedHardware.outputPin
    || Number(currentOutputs[0]?.pixels) !== expectedHardware.pixels) {
    throw new Error(`Wiring current outputs did not report exactly GPIO ${expectedHardware.outputPin} with ${expectedHardware.pixels} pixels.`);
  }
}

function requiredArray(payload, field, pathname) {
  if (!Array.isArray(payload[field])) throw new Error(`${pathname} did not return a ${field} array.`);
  return payload[field];
}

function assertZoneCoverage(zones, expectedPixels) {
  const covered = Array(expectedPixels).fill(false);
  let valid = true;
  for (const zone of zones) {
    if (!Array.isArray(zone?.ranges) || !zone.ranges.length) {
      valid = false;
      continue;
    }
    for (const range of zone.ranges) {
      const start = Number(range?.start);
      const count = Number(range?.count);
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count)
        || count < 1 || start + count > expectedPixels) {
        valid = false;
        continue;
      }
      for (let pixel = start; pixel < start + count; pixel += 1) {
        if (covered[pixel]) valid = false;
        covered[pixel] = true;
      }
    }
  }
  if (!valid || covered.some(value => !value)) {
    throw new Error(`Zone ranges did not cover exactly ${expectedPixels} pixels.`);
  }
}

function assertPatternAcceptance(payload, patterns) {
  if (payload.currentId !== 'aurora') {
    throw new Error('Card current pattern was not restored to aurora.');
  }
  const exact = patterns.length === EXPECTED_PATTERNS.length
    && patterns.every((pattern, index) => pattern?.id === EXPECTED_PATTERNS[index].id
      && pattern?.label === EXPECTED_PATTERNS[index].label);
  if (!exact) throw new Error('Installed patterns did not exactly match Aurora, Fire, Ocean.');
}

function assertZoneState(zones) {
  if (zones.length !== 1) throw new Error('Card must report exactly one zone.');
  const zone = zones[0];
  if (zone.patternId !== 'aurora') throw new Error('Zone pattern was not restored to aurora.');
  if (zone.hueShift !== 0 || zone.customHue !== 32 || zone.customSaturation !== 230
    || zone.blackout !== false) {
    throw new Error('Zone color was not restored to the expected Aurora state.');
  }
}

function assertUpdateCorrelation(status, update) {
  const embedded = status.firmwareUpdate;
  if (!embedded || typeof embedded !== 'object' || Array.isArray(embedded)) {
    throw new Error('Status firmwareUpdate evidence is required.');
  }
  for (const field of UPDATE_STATUS_FIELDS) {
    if (!Object.hasOwn(embedded, field) || !Object.hasOwn(update, field)
      || embedded[field] !== update[field]) {
      throw new Error(`Update status ${field} did not match status firmwareUpdate evidence.`);
    }
  }
}

function statusReadback(status) {
  const fields = [
    'bootId', 'runtimePhase', 'knownGoodProject', 'commandReady', 'playbackReady',
    'outputReady', 'projectId', 'projectRevision', 'projectFingerprint', 'pixels',
    'allocatedPixels', 'requestedPixels', 'maxMilliamps', 'colorOrder', 'wiringRevision',
    'wiringDigest', 'productionJobId', 'productionJobDigest',
  ];
  const readback = Object.fromEntries(fields.filter(field => status[field] !== undefined).map(field => [field, status[field]]));
  for (const field of ['led', 'limits', 'wifi', 'outputs', 'outputColor', 'firmwareUpdate']) {
    if (status[field] !== undefined) readback[field] = status[field];
  }
  return readback;
}

export async function runRealCardCommissioning({
  cardHost,
  expectedCardId,
  expectedBuildId,
  expectedOutputPin,
  expectedPixels,
  expectedChipset,
  expectedColorOrder,
  expectedProjectId,
  expectedProjectFingerprint,
  allowMutation = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const expected = exactExpectedIdentity(expectedCardId, expectedBuildId);
  const expectedHardware = exactExpectedHardware(
    expectedOutputPin, expectedPixels, expectedChipset, expectedColorOrder,
  );
  const expectedProject = exactExpectedProject(expectedProjectId, expectedProjectFingerprint);
  const baseUrl = cardBaseUrl(cardHost);
  if (allowMutation) throw new Error('Mutation operations are not implemented in this harness. --allow-mutation grants no capability in this pass.');
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch-compatible runtime is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('timeoutMs must be between 1 and 60000.');

  const firmware = await readCardJson(baseUrl, '/api/firmware-info', fetchImpl, timeoutMs);
  assertIdentity('Firmware', firmware, expected);
  const status = await readCardJson(baseUrl, '/api/status', fetchImpl, timeoutMs);
  assertIdentity('Status', status, expected);
  assertFirmwareMetadata(firmware, status);
  assertExpectedProject(status, expectedProject);
  assertRuntimeAcceptance(status);
  const hardware = assertExpectedHardware(status, expectedHardware);

  const wiring = await readCardJson(baseUrl, '/api/wiring/status', fetchImpl, timeoutMs, { requireApp: false });
  assertIdentity('Wiring status', wiring, expected, { required: false });
  assertWiringAcceptance(wiring, expectedHardware);
  const patternsPayload = await readCardJson(baseUrl, '/api/patterns', fetchImpl, timeoutMs, { requireApp: false });
  assertIdentity('Patterns', patternsPayload, expected, { required: false });
  const zonesPayload = await readCardJson(baseUrl, '/api/zones', fetchImpl, timeoutMs, { requireApp: false });
  assertIdentity('Zones', zonesPayload, expected, { required: false });
  const update = await readCardJson(baseUrl, '/api/update/status', fetchImpl, timeoutMs, { requireApp: false });
  assertIdentity('Update status', update, expected, { required: false });
  assertUpdateCorrelation(status, update);
  const patterns = requiredArray(patternsPayload, 'patterns', '/api/patterns');
  const zones = requiredArray(zonesPayload, 'zones', '/api/zones');
  if (!patterns.length) throw new Error('/api/patterns must report at least one installed pattern.');
  if (!zones.length) throw new Error('/api/zones must report at least one configured zone.');
  assertPatternAcceptance(patternsPayload, patterns);
  assertZoneCoverage(zones, expectedHardware.pixels);
  assertZoneState(zones);
  if (update.ok !== true) throw new Error('Firmware updater did not report healthy status.');
  if (update.phase !== 'idle') throw new Error(`Firmware updater phase ${update.phase || '(missing)'} was not idle.`);

  return {
    mode: 'safe-read-only',
    verified: true,
    cardUrl: baseUrl.origin,
    identity: {
      cardId: firmware.cardId,
      firmwareVersion: firmware.firmwareVersion,
      buildId: String(firmware.buildId).toLowerCase(),
      buildNumber: firmware.buildNumber,
      bootId: firmware.bootId,
    },
    status: statusReadback(status),
    hardware,
    wiring,
    patterns,
    zones,
    update,
    requests: [
      '/api/firmware-info', '/api/status', '/api/wiring/status',
      '/api/patterns', '/api/zones', '/api/update/status',
    ],
  };
}

function cliOptions(argv, env) {
  const unknown = argv.filter(argument => argument !== '--allow-mutation');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  return {
    cardHost: env.CARD_HOST,
    expectedCardId: env.EXPECTED_CARD_ID,
    expectedBuildId: env.EXPECTED_BUILD_ID,
    expectedOutputPin: env.EXPECTED_OUTPUT_PIN,
    expectedPixels: env.EXPECTED_PIXELS,
    expectedChipset: env.EXPECTED_CHIPSET,
    expectedColorOrder: env.EXPECTED_COLOR_ORDER,
    expectedProjectId: env.EXPECTED_PROJECT_ID,
    expectedProjectFingerprint: env.EXPECTED_PROJECT_FINGERPRINT,
    allowMutation: argv.includes('--allow-mutation'),
  };
}

async function main() {
  try {
    const result = await runRealCardCommissioning(cliOptions(process.argv.slice(2), process.env));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Lightweaver real-card check failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
