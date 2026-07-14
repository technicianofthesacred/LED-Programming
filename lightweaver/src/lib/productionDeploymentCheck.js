export const DEFAULT_PRODUCTION_ORIGIN = 'https://led.mandalacodes.com';
export const FACTORY_FIRMWARE_PATH = '/firmware/lightweaver-controller-esp32s3-factory.bin';

export function resolveProductionUrls(env = {}) {
  const parsed = new URL(env.PROD_ORIGIN || DEFAULT_PRODUCTION_ORIGIN);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`PROD_ORIGIN must be an HTTP(S) origin, received ${parsed.protocol}`);
  }
  const origin = parsed.origin;
  return {
    studioUrl: `${origin}/`,
    legacyDesignUrl: `${origin}/design`,
    firmwareUrl: `${origin}${FACTORY_FIRMWARE_PATH}`,
  };
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
