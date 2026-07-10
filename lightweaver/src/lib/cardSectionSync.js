import { CardPushError, pushConfigToCard } from './cardPushClient.js';
import { readCardZonesFromCard } from './cardLiveControl.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const previewSectionSyncs = new Map();

function uniqueZoneIds(zoneIds = []) {
  return [...new Set(zoneIds.map(String).filter(Boolean))];
}

function previewSectionSyncKey(host, runtimePackage) {
  return `${String(host || '').trim().toLowerCase()}|${runtimeZoneIds(runtimePackage).sort().join(',')}`;
}

export function missingCardZoneIds(zonesPayload = {}, requiredZoneIds = []) {
  const required = uniqueZoneIds(requiredZoneIds);
  if (!Array.isArray(zonesPayload?.zones)) return required;
  const available = new Set(
    zonesPayload.zones
      .map(zone => String(zone?.id || ''))
      .filter(Boolean),
  );
  return required.filter(zoneId => !available.has(zoneId));
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
  attempts = 20,
  intervalMs = 600,
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
  let verifiedZones = null;
  if (requiredZoneIds.length) {
    verifiedZones = await waitForCardZones({
      host,
      requiredZoneIds,
      readZones,
      sleep,
    });
  }
  return {
    ...(response && typeof response === 'object' ? response : { ok: true }),
    verifiedZones,
  };
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

  const syncKey = previewSectionSyncKey(host, runtimePackage);
  let pendingSync = previewSectionSyncs.get(syncKey);
  if (!pendingSync) {
    pendingSync = syncRuntimePackageToCard({
      host,
      runtimePackage,
      requiredZoneIds: runtimeZoneIds(runtimePackage),
      pushConfig,
      readZones,
      sleep,
    });
    previewSectionSyncs.set(syncKey, pendingSync);
    void pendingSync.finally(() => {
      if (previewSectionSyncs.get(syncKey) === pendingSync) previewSectionSyncs.delete(syncKey);
    }).catch(() => {});
  }
  const response = await pendingSync;
  return { synced: true, zones: response.verifiedZones, response };
}
