#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const REQUEST_TIMEOUT_MS = 8_000;
const CARD_ID_PATTERN = /^lw-[a-z0-9-]{4,64}$/i;
const BUILD_ID_PATTERN = /^[a-f0-9]{40}$/i;

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

async function readCardJson(baseUrl, pathname, fetchImpl, timeoutMs) {
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
  if (payload.app !== 'Lightweaver') throw new Error(`${pathname} did not identify a Lightweaver card.`);
  return payload;
}

function assertIdentity(label, payload, expected) {
  if (payload.cardId !== expected.cardId) {
    throw new Error(`${label} card ID ${payload.cardId || '(missing)'} did not match expected ${expected.cardId}.`);
  }
  const actualBuildId = String(payload.buildId || '').toLowerCase();
  if (actualBuildId !== expected.buildId) {
    throw new Error(`${label} build ID ${actualBuildId || '(missing)'} did not match expected ${expected.buildId}.`);
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
  for (const field of ['led', 'limits', 'wifi', 'outputs', 'outputColor']) {
    if (status[field] !== undefined) readback[field] = status[field];
  }
  return readback;
}

export async function runRealCardCommissioning({
  cardHost,
  expectedCardId,
  expectedBuildId,
  allowMutation = false,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const expected = exactExpectedIdentity(expectedCardId, expectedBuildId);
  const baseUrl = cardBaseUrl(cardHost);
  if (allowMutation) throw new Error('Mutation operations are not implemented in this harness. --allow-mutation grants no capability in this pass.');
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch-compatible runtime is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('timeoutMs must be between 1 and 60000.');

  const firmware = await readCardJson(baseUrl, '/api/firmware-info', fetchImpl, timeoutMs);
  assertIdentity('Firmware', firmware, expected);
  const status = await readCardJson(baseUrl, '/api/status', fetchImpl, timeoutMs);
  assertIdentity('Status', status, expected);
  if (status.firmwareVersion !== firmware.firmwareVersion) throw new Error('Status firmware version did not match firmware-info read-back.');
  if (status.buildNumber !== undefined && firmware.buildNumber !== undefined && status.buildNumber !== firmware.buildNumber) {
    throw new Error('Status build number did not match firmware-info read-back.');
  }

  return {
    mode: 'safe-read-only',
    verified: true,
    cardUrl: baseUrl.origin,
    identity: {
      cardId: firmware.cardId,
      firmwareVersion: firmware.firmwareVersion,
      buildId: String(firmware.buildId).toLowerCase(),
      ...(firmware.buildNumber !== undefined ? { buildNumber: firmware.buildNumber } : {}),
    },
    status: statusReadback(status),
    requests: ['/api/firmware-info', '/api/status'],
  };
}

function cliOptions(argv, env) {
  const unknown = argv.filter(argument => argument !== '--allow-mutation');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  return {
    cardHost: env.CARD_HOST,
    expectedCardId: env.EXPECTED_CARD_ID,
    expectedBuildId: env.EXPECTED_BUILD_ID,
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
