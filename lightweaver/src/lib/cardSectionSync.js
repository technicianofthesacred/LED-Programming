import { CardPushError, pushConfigToCard } from './cardPushClient.js';
import { readCardZonesFromCard } from './cardLiveControl.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function missingCardZoneIds(zonesPayload = {}, requiredZoneIds = []) {
  if (!Array.isArray(zonesPayload?.zones)) return [];
  const available = new Set(
    zonesPayload.zones
      .map(zone => String(zone?.id || ''))
      .filter(Boolean),
  );
  return [...new Set(requiredZoneIds.map(String).filter(Boolean))]
    .filter(zoneId => !available.has(zoneId));
}

export function runtimeZoneIds(runtimePackage = {}) {
  const zones = (runtimePackage.config || runtimePackage)?.zones;
  return Array.isArray(zones)
    ? zones.map(zone => String(zone?.id || '')).filter(Boolean)
    : [];
}

export async function waitForCardZones({
  host,
  requiredZoneIds = [],
  readZones = readCardZonesFromCard,
  sleep = delay,
  attempts = 12,
  intervalMs = 500,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);
    try {
      const payload = await readZones({ host, timeoutMs: 900 });
      if (
        Array.isArray(payload?.zones) &&
        missingCardZoneIds(payload, requiredZoneIds).length === 0
      ) {
        return payload;
      }
    } catch {
      // The card and its page bridge may both disappear briefly during reboot.
    }
  }
  throw new CardPushError(
    'zones-missing',
    'Lightweaver saved the setup, but the card did not expose the required sections after reconnecting.',
  );
}

export async function syncRuntimePackageToCard({
  host,
  runtimePackage,
  requiredZoneIds = runtimeZoneIds(runtimePackage),
  pushConfig = pushConfigToCard,
  readZones = readCardZonesFromCard,
  sleep = delay,
} = {}) {
  const response = await pushConfig(runtimePackage, {
    host,
    timeoutMs: 6000,
    reboot: 'if-needed',
  });
  if (requiredZoneIds.length) {
    await waitForCardZones({
      host,
      requiredZoneIds,
      readZones,
      sleep,
    });
  }
  return response;
}

export async function ensureCardSectionsForPreview({
  host,
  requiredZoneIds = [],
  runtimePackage,
  pushConfig = pushConfigToCard,
  readZones = readCardZonesFromCard,
  sleep = delay,
} = {}) {
  if (!requiredZoneIds.length) return { synced: false, zones: null };
  const zones = await readZones({ host, timeoutMs: 900 });
  const missing = missingCardZoneIds(zones, requiredZoneIds);
  if (!missing.length) return { synced: false, zones };

  const response = await syncRuntimePackageToCard({
    host,
    runtimePackage,
    requiredZoneIds,
    pushConfig,
    readZones,
    sleep,
  });
  return { synced: true, zones: response };
}
