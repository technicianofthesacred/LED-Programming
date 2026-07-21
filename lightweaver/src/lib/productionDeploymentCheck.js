export const DEFAULT_PRODUCTION_ORIGIN = 'https://led.mandalacodes.com';
export const FACTORY_FIRMWARE_PATH = '/firmware/lightweaver-controller-esp32s3-factory.bin';
export const FIRMWARE_MANIFEST_PATH = '/firmware/release-manifest.json';
export const FIRMWARE_SIGNATURE_PATH = '/firmware/release-manifest.sig';
export const FIRMWARE_PROVENANCE_PATH = '/firmware/release-provenance.json';
export const PRODUCTION_JOB_INDEX_PATH = '/production/jobs/index.json';
export const STUDIO_BUILD_GRAPH_PATH = '/studio-build-graph.json';

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const STUDIO_FILE_PATH = /^(?:index\.html|assets\/[A-Za-z0-9._/-]+\.(?:js|css))$/;

function isNormalizedStudioPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\')) return false;
  if (path.includes('?') || path.includes('#') || path.includes('%') || path.includes('://')) return false;
  const segments = path.split('/');
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function describeGraphEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Studio build graph file ${index} must be an object`);
  }
  const keys = Object.keys(entry).sort();
  if (keys.join(',') !== 'bytes,path,sha256') {
    throw new Error(`Studio build graph file ${index} must contain exactly path, bytes, and sha256`);
  }
  if (!isNormalizedStudioPath(entry.path)) {
    throw new Error(`Studio build graph file ${index} must use a normalized root-relative path`);
  }
  if (entry.path === STUDIO_BUILD_GRAPH_PATH.slice(1)) {
    throw new Error('Studio build graph must not list itself');
  }
  if (!STUDIO_FILE_PATH.test(entry.path)) {
    throw new Error(`Studio build graph file ${entry.path} is not index.html or a Vite JavaScript/CSS asset`);
  }
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
    throw new Error(`Studio build graph file ${entry.path} has an invalid byte size`);
  }
  if (typeof entry.sha256 !== 'string' || !LOWERCASE_SHA256.test(entry.sha256)) {
    throw new Error(`Studio build graph file ${entry.path} must have a lowercase SHA-256`);
  }
  return { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 };
}

export function parseStudioBuildGraph(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Studio build graph is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Studio build graph must be an object');
  }
  const keys = Object.keys(parsed).sort();
  if (keys.join(',') !== 'files,schemaVersion') {
    throw new Error('Studio build graph must contain exactly schemaVersion and files');
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error('Studio build graph schemaVersion must be 1');
  }
  if (!Array.isArray(parsed.files)) {
    throw new Error('Studio build graph files must be an array');
  }

  const files = parsed.files.map(describeGraphEntry);
  const paths = files.map(file => file.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('Studio build graph contains a duplicate path');
  }
  const sortedPaths = [...paths].sort();
  if (paths.some((path, index) => path !== sortedPaths[index])) {
    throw new Error('Studio build graph files must be sorted lexicographically');
  }
  if (!paths.includes('index.html')) {
    throw new Error('Studio build graph must include index.html');
  }
  if (!paths.some(path => path.startsWith('assets/') && path.endsWith('.js'))) {
    throw new Error('Studio build graph must include at least one JavaScript asset');
  }
  return { schemaVersion: 1, files };
}

function bytesToHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(cryptoImpl, bytes) {
  if (!cryptoImpl?.subtle?.digest) throw new Error('Web Crypto SHA-256 is unavailable');
  return bytesToHex(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes)));
}

function graphEntrySummary(entry) {
  return entry ? `${entry.bytes} bytes, sha256 ${entry.sha256}` : 'missing';
}

export function assertStudioBuildGraphMatches(expectedInput, actualInput) {
  const expected = parseStudioBuildGraph(typeof expectedInput === 'string' ? expectedInput : JSON.stringify(expectedInput));
  const actual = parseStudioBuildGraph(typeof actualInput === 'string' ? actualInput : JSON.stringify(actualInput));
  const expectedByPath = new Map(expected.files.map(file => [file.path, file]));
  const actualByPath = new Map(actual.files.map(file => [file.path, file]));
  const paths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort();
  for (const path of paths) {
    const expectedEntry = expectedByPath.get(path);
    const actualEntry = actualByPath.get(path);
    if (!expectedEntry || !actualEntry || expectedEntry.bytes !== actualEntry.bytes || expectedEntry.sha256 !== actualEntry.sha256) {
      throw new Error(
        `Production Studio build graph mismatch: ${path}\n` +
        `  expected ${graphEntrySummary(expectedEntry)}\n` +
        `  actual   ${graphEntrySummary(actualEntry)}`,
      );
    }
  }
  return expected;
}

export async function verifyStudioBuildGraph(fetchImpl, cryptoImpl, graphUrl, expectedGraph, rootBytes) {
  if (!(rootBytes instanceof Uint8Array)) {
    throw new Error('Verified Production Studio root bytes are required');
  }
  const parsedGraphUrl = new URL(graphUrl);
  const graphResponse = await fetchImpl(parsedGraphUrl.href, { cache: 'no-store', redirect: 'manual' });
  if (!graphResponse.ok) {
    throw new Error(`Production Studio build graph answered HTTP ${graphResponse.status} at\n  ${parsedGraphUrl.href}`);
  }
  const liveGraph = parseStudioBuildGraph(await graphResponse.text());
  const graph = assertStudioBuildGraphMatches(expectedGraph, liveGraph);
  for (const expected of graph.files) {
    let actualBytes;
    if (expected.path === 'index.html') {
      actualBytes = rootBytes;
    } else {
      const assetUrl = new URL(expected.path, `${parsedGraphUrl.origin}/`);
      if (assetUrl.origin !== parsedGraphUrl.origin) {
        throw new Error(`Studio build graph file escaped its production origin: ${expected.path}`);
      }
      const assetResponse = await fetchImpl(assetUrl.href, { cache: 'no-store', redirect: 'manual' });
      if (!assetResponse.ok) {
        throw new Error(`Production Studio asset ${expected.path} answered HTTP ${assetResponse.status} at\n  ${assetUrl.href}`);
      }
      actualBytes = new Uint8Array(await assetResponse.arrayBuffer());
    }
    const actualHash = await sha256Hex(cryptoImpl, actualBytes);
    if (actualBytes.byteLength !== expected.bytes || actualHash !== expected.sha256) {
      throw new Error(
        `Production Studio asset mismatch: ${expected.path}\n` +
        `  expected ${expected.bytes} bytes, sha256 ${expected.sha256}\n` +
        `  actual   ${actualBytes.byteLength} bytes, sha256 ${actualHash}`,
      );
    }
  }
  return { graph, graphUrl: parsedGraphUrl.href };
}

export function resolveProductionUrls(env = {}) {
  const parsed = new URL(env.PROD_ORIGIN || DEFAULT_PRODUCTION_ORIGIN);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`PROD_ORIGIN must be an HTTP(S) origin, received ${parsed.protocol}`);
  }
  const origin = parsed.origin;
  return {
    studioUrl: `${origin}/`,
    productionSetupUrl: `${origin}/#screen=production`,
    legacyDesignUrl: `${origin}/design`,
    firmwareUrl: `${origin}${FACTORY_FIRMWARE_PATH}`,
    manifestUrl: `${origin}${FIRMWARE_MANIFEST_PATH}`,
    signatureUrl: `${origin}${FIRMWARE_SIGNATURE_PATH}`,
    provenanceUrl: `${origin}${FIRMWARE_PROVENANCE_PATH}`,
    productionJobIndexUrl: `${origin}${PRODUCTION_JOB_INDEX_PATH}`,
    studioBuildGraphUrl: `${origin}${STUDIO_BUILD_GRAPH_PATH}`,
  };
}

export async function assertReleaseProvenance(response, manifest, url) {
  if (!response.ok) throw new Error(`Production firmware provenance answered HTTP ${response.status} at\n  ${url}`);
  let provenance;
  try { provenance = JSON.parse(await response.text()); } catch { throw new Error(`Production firmware provenance is not valid JSON at\n  ${url}`); }
  const expected = {
    sourceRevision: manifest?.provenance?.sourceRevision,
    buildId: manifest?.buildId,
    firmwareVersion: manifest?.firmwareVersion,
    target: manifest?.target,
    image: manifest?.image,
    toolchain: manifest?.provenance,
  };
  const actual = {
    sourceRevision: provenance?.sourceRevision,
    buildId: provenance?.buildId,
    firmwareVersion: provenance?.firmwareVersion,
    target: provenance?.target,
    image: provenance?.image,
    toolchain: provenance?.toolchain,
  };
  const canonical = value => value && typeof value === 'object'
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`Production firmware provenance does not match the signed manifest at\n  ${url}`);
  }
}

export async function assertStudioRoot(response, url) {
  if (!response.ok) {
    throw new Error(`Production Studio root answered HTTP ${response.status} at\n  ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const html = new TextDecoder().decode(bytes);
  if (!/id=["']root["']/.test(html)) {
    throw new Error(`Production root does not contain the Lightweaver Studio shell at\n  ${url}`);
  }
  return bytes;
}

export async function assertLegacyRouteRemoved(response, url) {
  if (response.status !== 404) {
    throw new Error(
      `Legacy Studio route is still live or unhealthy: expected HTTP 404, received ${response.status} at\n  ${url}`,
    );
  }
  const html = await response.text();
  if (!/Page not found/i.test(html) || !/Lightweaver/i.test(html)) {
    throw new Error(
      `Legacy route returned HTTP 404, but the response is not the Lightweaver 404 at\n  ${url}`,
    );
  }
}
