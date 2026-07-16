export const DEFAULT_PRODUCTION_ORIGIN = 'https://led.mandalacodes.com';
export const FACTORY_FIRMWARE_PATH = '/firmware/lightweaver-controller-esp32s3-factory.bin';
export const FIRMWARE_MANIFEST_PATH = '/firmware/release-manifest.json';
export const FIRMWARE_SIGNATURE_PATH = '/firmware/release-manifest.sig';
export const FIRMWARE_PROVENANCE_PATH = '/firmware/release-provenance.json';
export const PRODUCTION_JOB_INDEX_PATH = '/production/jobs/index.json';

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
  const html = await response.text();
  if (!/id=["']root["']/.test(html)) {
    throw new Error(`Production root does not contain the Lightweaver Studio shell at\n  ${url}`);
  }
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
