import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateFirmwareManifest } from '../packages/installer-core/src/firmware-release.js';

export const FIRMWARE_RELEASE_BUILD_GRAPH_PATH = 'firmware/release-build-graph.json';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function descriptorPaths(manifest) {
  const paths = [
    '/firmware/release-manifest.json',
    '/firmware/release-manifest.sig',
    '/firmware/release-provenance.json',
    '/firmware/lightweaver-controller-esp32s3-factory.bin',
    manifest.image.url,
  ];
  if (manifest.schemaVersion === 2) {
    paths.push(manifest.update.image.url, manifest.update.ticket.url, manifest.update.signature.url);
  }
  return [...new Set(paths)].sort();
}

function parseGraph(bytes) {
  const graph = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!graph || graph.schemaVersion !== 1 || !Array.isArray(graph.files)) {
    throw new Error('Firmware release build graph is invalid');
  }
  const keys = Object.keys(graph).sort();
  if (keys.join(',') !== 'buildId,buildNumber,files,firmwareVersion,schemaVersion') {
    throw new Error('Firmware release build graph contains unsupported fields');
  }
  let previous = '';
  for (const file of graph.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'path,sha256,size'
      || typeof file.path !== 'string' || !file.path.startsWith('firmware/')
      || file.path <= previous || !Number.isSafeInteger(file.size) || file.size < 1
      || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Firmware release build graph file descriptor is invalid');
    }
    previous = file.path;
  }
  return graph;
}

export async function createFirmwareReleaseBuildGraph(readArtifact) {
  const manifestBytes = await readArtifact('firmware/release-manifest.json');
  const manifest = validateFirmwareManifest(JSON.parse(Buffer.from(manifestBytes).toString('utf8')));
  const files = [];
  for (const path of descriptorPaths(manifest)) {
    const normalized = path.slice(1);
    const bytes = await readArtifact(normalized);
    files.push({ path: normalized, size: bytes.byteLength, sha256: sha256(bytes) });
  }
  for (const [label, descriptor] of Object.entries({
    factory: manifest.image,
    ...(manifest.update ? {
      application: manifest.update.image,
      ticket: manifest.update.ticket,
      ticketSignature: manifest.update.signature,
    } : {}),
  })) {
    const actual = files.find(file => file.path === descriptor.url.slice(1));
    if (!actual || actual.size !== descriptor.size || actual.sha256 !== descriptor.sha256) {
      throw new Error(`Staged firmware ${label} bytes do not match the signed manifest descriptor`);
    }
  }
  return {
    schemaVersion: 1,
    firmwareVersion: manifest.firmwareVersion,
    buildId: manifest.buildId,
    buildNumber: manifest.buildNumber,
    files,
  };
}

export function serializeFirmwareReleaseBuildGraph(graph) {
  return `${JSON.stringify(canonical(parseGraph(Buffer.from(JSON.stringify(graph)))), null, 2)}\n`;
}

export async function createFirmwareReleaseBuildGraphFromRoot(root) {
  const absoluteRoot = resolve(root);
  return createFirmwareReleaseBuildGraph(path => readFile(join(absoluteRoot, ...path.split('/'))));
}

export async function verifyProductionArtifactRoot(root) {
  const absoluteRoot = resolve(root);
  const expected = await createFirmwareReleaseBuildGraphFromRoot(absoluteRoot);
  const actual = parseGraph(await readFile(join(absoluteRoot, ...FIRMWARE_RELEASE_BUILD_GRAPH_PATH.split('/'))));
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error('Staged firmware release build graph does not match its exact artifact bytes');
  }
  return actual;
}

export async function verifyProductionArtifactOrigin(origin, expectedRoot) {
  const expected = await verifyProductionArtifactRoot(expectedRoot);
  const base = new URL(origin);
  const fetchBytes = async path => {
    const url = new URL(path, `${base.origin}/`);
    const response = await fetch(url, { cache: 'no-store', redirect: 'error' });
    if (!response.ok || response.redirected) throw new Error(`Production artifact is unavailable: ${url.href}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const actual = parseGraph(await fetchBytes(FIRMWARE_RELEASE_BUILD_GRAPH_PATH));
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error('Live firmware release build graph does not match the staged release');
  }
  for (const descriptor of actual.files) {
    const bytes = await fetchBytes(descriptor.path);
    if (bytes.byteLength !== descriptor.size || sha256(bytes) !== descriptor.sha256) {
      throw new Error(`Live firmware artifact does not match staged bytes: ${descriptor.path}`);
    }
  }
  return actual;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  if (args.has('--root')) {
    const graph = await verifyProductionArtifactRoot(args.get('--root'));
    console.log(`Verified staged firmware release graph (${graph.files.length} files).`);
  } else if (args.has('--origin') && args.has('--expected-root')) {
    const graph = await verifyProductionArtifactOrigin(args.get('--origin'), args.get('--expected-root'));
    console.log(`Verified live firmware release graph (${graph.files.length} files).`);
  } else {
    throw new Error('Usage: verify-production-artifacts.mjs --root <staged-root> | --origin <url> --expected-root <staged-root>');
  }
}
