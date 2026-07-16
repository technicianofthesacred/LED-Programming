import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import {
  MAX_PRODUCTION_JOB_BYTES,
  PRODUCTION_JOB_SIGNATURE_ALGORITHM,
  PRODUCTION_JOB_TRUST_SET,
  buildProductionJob,
  canonicalProductionJobBytes,
  loadProductionJobIndex,
  loadProductionJobFromIndexEntry,
  parseProductionJobPackage,
  productionJobSignedBytes,
  verifyProductionJobSignature,
} from './productionJobPackage.js';
import { fingerprintCommissioningProject } from './cardCommissioningFlow.js';
import { buildCardRuntimePackageFromProject } from './cardRuntimeProject.js';

const hex = (value, length) => value.repeat(length);

function source(overrides = {}) {
  const standaloneController = {
    outputs: [{ id: 'out1', name: 'Outer ring', pin: 16, pixels: 8 }],
    led: { type: 'WS2815', colorOrder: 'GRB', brightnessLimit: 0.35 },
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
    id: 'moon-01',
    name: 'Moon',
    layout: {
      strips: [{ id: 'strip-1', name: 'Outer ring', pixelCount: 8 }],
      patchBoard: null,
      wiring: {
        version: 1,
        locked: true,
        verified: true,
        controllerAnchor: null,
        migrationWarnings: [],
        outputs: [{ id: 'out1', name: 'Outer ring', pin: 16, runIds: ['run-strip-1'] }],
        runs: [{
          id: 'run-strip-1', type: 'strip', verified: true,
          source: { stripId: 'strip-1', from: 0, to: 7 },
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
    projectRevision: 12,
    projectFingerprint: fingerprint,
    productionJobId: 'moon-batch-7',
    productionJobDigest: hex('0', 64),
    strips: restoreSnapshot.layout.strips,
    patchBoard: restoreSnapshot.layout.patchBoard,
    wiring: restoreSnapshot.layout.wiring,
    standaloneController,
  });
  return {
    schemaVersion: 1,
    jobId: 'moon-batch-7',
    label: 'Moon · batch 7',
    artwork: 'Moon',
    batch: '7',
    firmware: {
      target: 'esp32-s3-n16r8',
      version: '1.2.3',
      buildId: hex('b', 40),
      minimumVersion: '1.0.0',
    },
    project: {
      id: 'moon-01',
      revision: 12,
      fingerprint,
      restoreSnapshot,
    },
    configuration,
    expectedOutputs: [{ id: 'out1', label: 'Outer ring', pin: 16, pixels: 8, direction: 'forward', colorOrder: 'GRB' }],
    ...overrides,
  };
}

async function validPackage(overrides) {
  return buildProductionJob(source(overrides), { cryptoImpl: webcrypto });
}

function schemaErrors(schema, value, path = '$', root = schema) {
  if (schema === false) return [`${path}: forbidden`];
  if (schema === true) return [];
  const errors = [];
  if (schema.$ref) schema = schema.$ref.split('/').slice(1).reduce((cursor, part) => cursor[part.replaceAll('~1', '/').replaceAll('~0', '~')], root);
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: enum`);
  const types = schema.type == null ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [`${path}: type`];
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: minLength`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) errors.push(`${path}: noncanonical number`);
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: minimum`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: minItems`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: maxItems`);
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${path}[${index}]`, root)));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key}: required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) errors.push(`${path}.${key}: additional`);
    for (const [key, nested] of Object.entries(schema.properties || {})) if (key in value) errors.push(...schemaErrors(nested, value[key], `${path}.${key}`, root));
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) errors.push(...schemaErrors(schema.additionalProperties, value[key], `${path}.${key}`, root));
    }
  }
  for (const branch of schema.allOf || []) errors.push(...schemaErrors(branch, value, path, root));
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(branch => schemaErrors(branch, value, path, root).length === 0);
    if (matches.length !== 1) errors.push(`${path}: oneOf`);
  }
  return errors;
}

test('builds a deterministic digest over canonical UTF-8 bytes with digest omitted', async () => {
  const left = await validPackage();
  const reordered = Object.fromEntries(Object.entries(source()).reverse());
  const right = await buildProductionJob(reordered, { cryptoImpl: webcrypto });
  assert.equal(left.digest, right.digest);
  assert.equal(left.digest, createHash('sha256').update(canonicalProductionJobBytes(left, { omitDigest: true })).digest('hex'));
  assert.equal(new TextDecoder().decode(canonicalProductionJobBytes(left)).includes(`"digest":"${left.digest}"`), true);
});

test('rejects unsupported schema, mutable projects, unknown fields, digest mismatch, and oversize UTF-8 packages', async () => {
  const job = await validPackage();
  for (const [label, changed, reason] of [
    ['schema', { ...job, schemaVersion: 2 }, /schema/i],
    ['mutable project', { ...job, mutableProject: true }, /unsupported fields/i],
    ['unknown nested field', { ...job, firmware: { ...job.firmware, channel: 'latest' } }, /unsupported fields/i],
    ['unknown configuration field', { ...job, configuration: { ...job.configuration, config: { ...job.configuration.config, wifiPassword: 'never' } } }, /unsupported fields/i],
    ['digest', { ...job, digest: hex('f', 64) }, /digest mismatch/i],
  ]) {
    await assert.rejects(parseProductionJobPackage(changed, { trust: { kind: 'same-origin-index', expectedDigest: changed.digest }, cryptoImpl: webcrypto }), reason, label);
  }
  const huge = { ...job, label: '界'.repeat(MAX_PRODUCTION_JOB_BYTES) };
  await assert.rejects(parseProductionJobPackage(huge, { trust: { kind: 'same-origin-index', expectedDigest: job.digest }, cryptoImpl: webcrypto }), /256 KiB/i);
});

test('requires exact firmware target/floor and exact project revision/fingerprint identity', async () => {
  for (const [changed, reason] of [
    [{ firmware: { ...source().firmware, target: 'esp32-s3' } }, /target/i],
    [{ firmware: { ...source().firmware, minimumVersion: '0.9.9' } }, /minimum trusted/i],
    [{ project: { ...source().project, revision: 13 } }, /project revision/i],
    [{ project: { ...source().project, fingerprint: hex('c', 64) } }, /fingerprint/i],
  ]) {
    await assert.rejects(buildProductionJob(source(changed), { cryptoImpl: webcrypto }), reason);
  }
});

test('requires complete controls and outputs and rejects GPIO conflicts before USB', async () => {
  const missingControls = source();
  delete missingControls.configuration.config.controls.encoder.alternatePress;
  await assert.rejects(buildProductionJob(missingControls, { cryptoImpl: webcrypto }), /controls.*complete/i);

  const missingOutput = source({ expectedOutputs: [] });
  await assert.rejects(buildProductionJob(missingOutput, { cryptoImpl: webcrypto }), /expected output/i);

  const conflict = source();
  conflict.configuration.config.controls.next = 16;
  await assert.rejects(buildProductionJob(conflict, { cryptoImpl: webcrypto }), /GPIO 16/i);

});

test('preflights the compact firmware configuration against the 3968-byte capacity', async () => {
  const oversized = source();
  oversized.configuration.config.looks[0].label = '界'.repeat(4000);
  await assert.rejects(buildProductionJob(oversized, { cryptoImpl: webcrypto }), /3968-byte|flash storage limit/i);
});

test('external imports fail closed without a complete envelope or trusted key ID', async () => {
  const job = await validPackage();
  const bytes = canonicalProductionJobBytes(job);
  const signature = {
    keyId: 'isolated-test-key',
    algorithm: PRODUCTION_JOB_SIGNATURE_ALGORITHM,
    value: 'ZZOFJb74yOp_K5t91kYiNjEaCthksjtHhqPjQjmRWRI0enR34fWZ9NlZAOys1trICB9odRN8Mz_daNg0OWFbRg',
  };
  await assert.rejects(parseProductionJobPackage(bytes, { trust: { kind: 'external' }, cryptoImpl: webcrypto }), /signature/i);
  await assert.rejects(parseProductionJobPackage(bytes, {
    trust: { kind: 'external', signature: 'detached', verifySignature: async () => true }, cryptoImpl: webcrypto,
  }), /signature envelope/i);
  await assert.rejects(parseProductionJobPackage(bytes, {
    trust: { kind: 'external', signature: { keyId: 'firmware-release', algorithm: PRODUCTION_JOB_SIGNATURE_ALGORITHM, value: 'AA' } }, cryptoImpl: webcrypto,
  }), /unavailable|key ID/i);
  await assert.rejects(parseProductionJobPackage(bytes, { trust: { kind: 'external', signature }, cryptoImpl: webcrypto }), /key ID.*not trusted/i);
  assert.equal(PRODUCTION_JOB_TRUST_SET.version, 1);
});

test('accepts an exact artifact signed by the pinned production-job key', async () => {
  const job = await validPackage();
  const bytes = canonicalProductionJobBytes(job);
  const signature = {
    keyId: 'lightweaver-production-job-2026-01',
    algorithm: PRODUCTION_JOB_SIGNATURE_ALGORITHM,
    value: 'FeKGXb9xeK3f9mj1YJJwW-y8-FyjmoZoHDqDbqjEzYgDicNo6a9vBCr-ZiQPAGAxMRmKx28uEmrKUtFSyeomRg',
  };
  assert.equal(PRODUCTION_JOB_TRUST_SET.keys.length, 1);
  assert.equal(PRODUCTION_JOB_TRUST_SET.keys[0].keyId, signature.keyId);
  assert.equal((await parseProductionJobPackage(bytes, { trust: { kind: 'external', signature }, cryptoImpl: webcrypto })).digest, job.digest);
});

test('isolated verifier binds algorithm, key ID, domain, and exact artifact bytes', async () => {
  const keyId = 'isolated-test-key';
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64').match(/.{1,64}/g).join('\n');
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----`;
  const bytes = new TextEncoder().encode('{"immutable":true}');
  const value = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, productionJobSignedBytes(bytes, keyId))).toString('base64url');
  const envelope = { keyId, algorithm: PRODUCTION_JOB_SIGNATURE_ALGORITHM, value };
  const trustSet = { version: 1, keys: [{ keyId, algorithm: PRODUCTION_JOB_SIGNATURE_ALGORITHM, publicKeyPem }] };
  assert.equal(await verifyProductionJobSignature(bytes, envelope, webcrypto, trustSet), true);
  assert.equal(await verifyProductionJobSignature(new Uint8Array([...bytes, 0x20]), envelope, webcrypto, trustSet), false);
});

test('binds the exact restore fingerprint, normalized runtime, and physical wiring direction', async () => {
  const badFingerprint = source();
  badFingerprint.project.fingerprint = 'c'.repeat(16);
  badFingerprint.configuration.config.projectFingerprint = badFingerprint.project.fingerprint;
  await assert.rejects(buildProductionJob(badFingerprint, { cryptoImpl: webcrypto }), /restore snapshot fingerprint/i);

  const badRuntime = source();
  badRuntime.configuration.config.controls.encoder.rotateDirection = 'sideways';
  await assert.rejects(buildProductionJob(badRuntime, { cryptoImpl: webcrypto }), /compiled runtime/i);

  const unknownPattern = source();
  unknownPattern.configuration.config.patterns[0].wifiPassword = 'secret';
  await assert.rejects(buildProductionJob(unknownPattern, { cryptoImpl: webcrypto }), /compiled runtime|unsupported fields/i);

  const wrongDirection = source();
  wrongDirection.expectedOutputs[0].direction = 'reverse';
  await assert.rejects(buildProductionJob(wrongDirection, { cryptoImpl: webcrypto }), /wiring direction/i);

  const unknownSnapshot = source();
  unknownSnapshot.project.restoreSnapshot.layout.wifiPassword = 'secret';
  await assert.rejects(buildProductionJob(unknownSnapshot, { cryptoImpl: webcrypto }), /restore snapshot|unsupported fields/i);

  for (const dangerousKey of ['token', 'apiKey', 'privateKey', 'auth', '__proto__', 'prototype', 'constructor']) {
    const dangerous = source();
    Object.defineProperty(dangerous.project.restoreSnapshot.layout.strips[0], dangerousKey, { value: 'forbidden', enumerable: true });
    await assert.rejects(buildProductionJob(dangerous, { cryptoImpl: webcrypto }), /unsupported fields/i, dangerousKey);
  }
});

test('rejects non-canonical numbers and invalid compiled limits before hashing', async () => {
  for (const number of [NaN, Infinity, -Infinity, -0]) {
    const invalid = source();
    invalid.configuration.config.led.brightnessLimit = number;
    await assert.rejects(buildProductionJob(invalid, { cryptoImpl: webcrypto }), /non-canonical number/i);
  }
  const fractionalPin = source();
  fractionalPin.configuration.config.led.outputs[0].pin = 16.5;
  await assert.rejects(buildProductionJob(fractionalPin, { cryptoImpl: webcrypto }), /unsupported|compiled runtime/i);
  const wrongSum = source();
  wrongSum.configuration.config.led.pixels = 9;
  await assert.rejects(buildProductionJob(wrongSum, { cryptoImpl: webcrypto }), /sum|compiled runtime/i);
});

test('published schema is nested-strict and accepts exactly the runtime-valid package', async () => {
  const schema = JSON.parse(await readFile(resolve(process.cwd(), '../release/production-job.schema.json'), 'utf8'));
  const job = await validPackage();
  assert.deepEqual(schemaErrors(schema, job), []);
  const deref = value => value?.$ref ? value.$ref.split('/').slice(1).reduce((cursor, part) => cursor[part], schema) : value;
  const strictPaths = [
    schema.properties.project.properties.restoreSnapshot.properties.layout.properties.strips.items,
    deref(schema.properties.project.properties.restoreSnapshot.properties.layout.properties.strips.items).properties.pixels.items,
    schema.properties.project.properties.restoreSnapshot.properties.layout.properties.wiring,
    deref(schema.properties.project.properties.restoreSnapshot.properties.layout.properties.wiring).properties.controllerAnchor.oneOf[1],
    schema.properties.project.properties.restoreSnapshot.properties.devices.properties.standaloneController,
    schema.properties.configuration.properties.config.properties.led.properties.outputs.items,
    deref(schema.properties.configuration.properties.config.properties.looks.items).properties.zones.items,
    schema.properties.configuration.properties.config.properties.zones.items,
  ];
  for (const nested of strictPaths) assert.equal(deref(nested)?.additionalProperties, false);
  for (const runVariant of deref(deref(schema.properties.project.properties.restoreSnapshot.properties.layout.properties.wiring).properties.runs.items).oneOf) {
    assert.equal(runVariant.additionalProperties, false);
  }

  for (const mutate of [
    value => { value.project.restoreSnapshot.layout.strips[0].wifiPassword = 'secret'; },
    value => { value.project.restoreSnapshot.layout.wiring.outputs[0].pin = '16'; },
    value => { value.configuration.config.led.outputs[0].pixels = 2.5; },
    value => { value.configuration.config.looks[0].zones = [{ id: 'z', unknown: true }]; },
  ]) {
    const invalid = structuredClone(job);
    mutate(invalid);
    assert.notDeepEqual(schemaErrors(schema, invalid), []);
    await assert.rejects(parseProductionJobPackage(invalid, { trust: { kind: 'same-origin-index', expectedDigest: invalid.digest }, cryptoImpl: webcrypto }));
  }
});

test('builds and parses a canonical combo playlist production job', async () => {
  const combo = source();
  combo.project.restoreSnapshot.devices.standaloneController.looks = [{
    id: 'moon-look',
    type: 'compound-pattern',
    label: 'Moon split',
    defaultLook: { patternId: 'aurora', brightness: 1, speed: 1, hueShift: 0, customHue: 32, customSaturation: 230, customBreathe: false, customDrift: false },
    sectionLooks: {},
    updatedAt: 0,
  }];
  combo.project.restoreSnapshot.devices.standaloneController.playlist = [{
    id: 'combo-moon-look', type: 'combo', lookId: 'moon-look', label: 'Moon split', enabled: true, createdAt: 0,
  }];
  combo.project.fingerprint = fingerprintCommissioningProject(combo.project.restoreSnapshot);
  combo.configuration = buildCardRuntimePackageFromProject({
    projectId: combo.project.id, projectName: combo.project.restoreSnapshot.name,
    projectRevision: combo.project.revision, projectFingerprint: combo.project.fingerprint,
    productionJobId: combo.jobId, productionJobDigest: '0'.repeat(64),
    strips: combo.project.restoreSnapshot.layout.strips, patchBoard: null,
    wiring: combo.project.restoreSnapshot.layout.wiring,
    standaloneController: combo.project.restoreSnapshot.devices.standaloneController,
  });
  const job = await buildProductionJob(combo, { cryptoImpl: webcrypto });
  assert.equal(job.configuration.config.looks[0].mode, 'combo');
  assert.equal((await parseProductionJobPackage(job, { trust: { kind: 'same-origin-index', expectedDigest: job.digest }, cryptoImpl: webcrypto })).digest, job.digest);
});

test('accepts an empty strict same-origin production index', async () => {
  const response = { ok: true, redirected: false, text: async () => JSON.stringify({ schemaVersion: 1, jobs: [] }) };
  assert.deepEqual(await loadProductionJobIndex(async () => response), { schemaVersion: 1, jobs: [] });
});

test('rejects duplicate index identities and artifact metadata mismatches', async () => {
  const job = await validPackage();
  const body = canonicalProductionJobBytes(job);
  const entry = { jobId: job.jobId, label: job.label, digest: job.digest, artifactSha256: createHash('sha256').update(body).digest('hex'), size: body.byteLength, url: `/production/jobs/${job.digest}.lwjob.json` };
  const indexResponse = { ok: true, redirected: false, text: async () => JSON.stringify({ schemaVersion: 1, jobs: [entry, entry] }) };
  await assert.rejects(loadProductionJobIndex(async () => indexResponse), /duplicate/i);

  const response = {
    ok: true, redirected: false,
    headers: { get: () => null },
    body: { getReader: () => { let served = false; return { read: async () => served ? { done: true } : (served = true, { done: false, value: body }), releaseLock() {} }; } },
  };
  await assert.rejects(loadProductionJobFromIndexEntry({ ...entry, jobId: 'other-job' }, { fetchImpl: async () => response, cryptoImpl: webcrypto }), /job ID/i);
  await assert.rejects(loadProductionJobFromIndexEntry({ ...entry, label: 'Other label' }, { fetchImpl: async () => response, cryptoImpl: webcrypto }), /label/i);
});

test('content encoding ignores encoded Content-Length and trusts bounded decoded bytes', async () => {
  const job = await validPackage();
  const body = canonicalProductionJobBytes(job);
  const entry = { jobId: job.jobId, label: job.label, digest: job.digest, artifactSha256: createHash('sha256').update(body).digest('hex'), size: body.byteLength, url: `/production/jobs/${job.digest}.lwjob.json` };
  const response = {
    ok: true, redirected: false,
    headers: { get: name => name === 'content-encoding' ? 'br' : name === 'content-length' ? '17' : null },
    body: { getReader: () => { let served = false; return { read: async () => served ? { done: true } : (served = true, { done: false, value: body }), releaseLock() {} }; } },
  };
  assert.equal((await loadProductionJobFromIndexEntry(entry, { fetchImpl: async () => response, cryptoImpl: webcrypto })).digest, job.digest);
});

test('same-origin artifact loading verifies URL digest and raw response body hash', async () => {
  const job = await validPackage();
  const body = canonicalProductionJobBytes(job);
  const artifactSha256 = createHash('sha256').update(body).digest('hex');
  const entry = {
    jobId: job.jobId,
    label: job.label,
    digest: job.digest,
    artifactSha256,
    size: body.byteLength,
    url: `/production/jobs/${job.digest}.lwjob.json`,
  };
  const response = {
    ok: true,
    redirected: false,
    headers: { get: name => name === 'content-length' ? String(body.byteLength) : null },
    body: { getReader: () => {
      let served = false;
      return {
        read: async () => served ? { done: true } : (served = true, { done: false, value: body }),
        releaseLock() {},
      };
    } },
  };
  assert.equal((await loadProductionJobFromIndexEntry(entry, { fetchImpl: async () => response, cryptoImpl: webcrypto })).digest, job.digest);
  await assert.rejects(loadProductionJobFromIndexEntry({ ...entry, artifactSha256: hex('f', 64) }, { fetchImpl: async () => response, cryptoImpl: webcrypto }), /body hash/i);
  await assert.rejects(loadProductionJobFromIndexEntry({ ...entry, url: '/production/jobs/wrong.lwjob.json' }, { fetchImpl: async () => response, cryptoImpl: webcrypto }), /URL digest/i);
});

test('same-origin artifact loading cancels an undeclared stream beyond 256 KiB', async () => {
  const job = await validPackage();
  const entry = {
    jobId: job.jobId,
    label: job.label,
    digest: job.digest,
    artifactSha256: 'f'.repeat(64),
    size: 1,
    url: `/production/jobs/${job.digest}.lwjob.json`,
  };
  let cancelled = false;
  const response = {
    ok: true,
    redirected: false,
    headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => ({ done: false, value: new Uint8Array(MAX_PRODUCTION_JOB_BYTES + 1) }),
      cancel: async () => { cancelled = true; },
      releaseLock() {},
    }) },
  };
  await assert.rejects(loadProductionJobFromIndexEntry(entry, { fetchImpl: async () => response, cryptoImpl: webcrypto }), /256 KiB/i);
  assert.equal(cancelled, true);
});

test('CLI builder writes a deterministic content-addressed artifact and strict sorted index', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lw-production-job-'));
  const input = join(directory, 'source.json');
  const publicRoot = join(directory, 'public');
  await writeFile(input, JSON.stringify(source()));
  const script = resolve(process.cwd(), '../scripts/build-production-job.mjs');
  const run = () => promisify(execFile)(process.execPath, [script, '--input', input, '--public-root', publicRoot]);
  const first = JSON.parse((await run()).stdout);
  const second = JSON.parse((await run()).stdout);
  assert.equal(first.digest, second.digest);
  const artifact = await readFile(first.artifactPath);
  assert.equal(createHash('sha256').update(artifact).digest('hex'), first.artifactSha256);
  const index = JSON.parse(await readFile(join(publicRoot, 'production/jobs/index.json'), 'utf8'));
  assert.deepEqual(index.jobs, [{
    jobId: 'moon-batch-7',
    label: 'Moon · batch 7',
    digest: first.digest,
    artifactSha256: first.artifactSha256,
    size: artifact.byteLength,
    url: `/production/jobs/${first.digest}.lwjob.json`,
  }]);

  const concurrentInputs = [];
  for (let number = 1; number <= 5; number += 1) {
    const next = source();
    next.jobId = `moon-batch-${number + 7}`;
    next.label = `Moon · batch ${number + 7}`;
    next.batch = String(number + 7);
    next.configuration.config.productionJobId = next.jobId;
    const path = join(directory, `source-${number}.json`);
    await writeFile(path, JSON.stringify(next));
    concurrentInputs.push(path);
  }
  await Promise.all(concurrentInputs.map(path => promisify(execFile)(process.execPath, [script, '--input', path, '--public-root', publicRoot])));
  const concurrentIndex = JSON.parse(await readFile(join(publicRoot, 'production/jobs/index.json'), 'utf8'));
  assert.equal(concurrentIndex.jobs.length, 6);
  assert.deepEqual(concurrentIndex.jobs.map(job => job.jobId), [...concurrentIndex.jobs.map(job => job.jobId)].sort());

  const lockPath = join(publicRoot, 'production/jobs/index.json.lock');
  await mkdir(lockPath);
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ version: 1, pid: 2147483647, createdAt: 0, nonce: 'a'.repeat(32) }));
  assert.equal(JSON.parse((await run()).stdout).digest, first.digest);

  await mkdir(lockPath);
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ version: 1, pid: process.pid, createdAt: 0, nonce: 'b'.repeat(32) }));
  await assert.rejects(promisify(execFile)(process.execPath, [script, '--input', input, '--public-root', publicRoot], {
    env: { ...process.env, LW_JOB_LOCK_ATTEMPTS: '2', LW_JOB_LOCK_RETRY_MS: '1' },
  }), /locked by another builder/i);
  await rm(lockPath, { recursive: true, force: true });
});

test('CLI builder emits a detached exact-byte signature without exposing its private key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lw-production-job-signing-'));
  const input = join(directory, 'source.json');
  const publicRoot = join(directory, 'public');
  const privateKeyPath = join(directory, 'signing-key.pem');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await writeFile(input, JSON.stringify(source()));
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const script = resolve(process.cwd(), '../scripts/build-production-job.mjs');
  const result = JSON.parse((await promisify(execFile)(process.execPath, [
    script, '--input', input, '--public-root', publicRoot,
    '--signing-key', privateKeyPath, '--signing-key-id', 'isolated-builder-key',
  ])).stdout);
  const artifact = await readFile(result.artifactPath);
  const envelope = JSON.parse(await readFile(result.signaturePath, 'utf8'));
  assert.deepEqual(Object.keys(envelope).sort(), ['algorithm', 'keyId', 'value']);
  assert.equal(envelope.keyId, 'isolated-builder-key');
  assert.equal(await verifyProductionJobSignature(artifact, envelope, webcrypto, {
    version: 1,
    keys: [{ keyId: envelope.keyId, algorithm: envelope.algorithm, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) }],
  }), true);
  assert.doesNotMatch(JSON.stringify(result), /BEGIN (?:EC |)PRIVATE KEY|signing-key\.pem/);
});
