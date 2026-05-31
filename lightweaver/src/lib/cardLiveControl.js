import {
  canPushDirectlyToCard,
  cardHostToUrl,
  discoverCardStatus,
  normalizeCardHost,
  readStoredCardHost,
} from './cardConnection.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';
import { CardPushError } from './cardPushClient.js';

function isMixedContentBlocked() {
  return typeof window !== 'undefined' && !canPushDirectlyToCard(window.location.protocol);
}

const COLOR_ORDER_OPTIONS = new Set(['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR']);

export function buildLiveHardwareControlPayload(settings = {}) {
  const colorOrder = String(settings.colorOrder || '').toUpperCase();
  return {
    ...(COLOR_ORDER_OPTIONS.has(colorOrder) ? { colorOrder } : {}),
  };
}

export function buildLivePreviewControlPayload(look = {}) {
  const normalized = normalizeCardVisualLook(look);
  return {
    cancelStream: true,
    ...(look.zone ? { zone: String(look.zone) } : {}),
    ...(typeof look.syncZones === 'boolean' ? { syncZones: look.syncZones } : {}),
    patternId: normalized.patternId,
    brightness: normalized.brightness,
    speed: normalized.speed,
    hueShift: normalized.hueShift,
    hue: normalized.customHue,
    saturation: normalized.customSaturation,
    breathe: normalized.customBreathe,
    drift: normalized.customDrift,
  };
}

async function postControlPayloadToHost(host, payload, options = {}) {
  const url = `${cardHostToUrl(host)}/api/control`;
  const body = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 2500);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CardPushError('http', `card returned ${response.status}: ${text || 'no body'}`);
    }
    return await response.json().catch(() => ({ ok: true }));
  } finally {
    clearTimeout(timer);
  }
}

async function readCardZones(host, timeoutMs = 1200) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${cardHostToUrl(host)}/api/zones`, { signal: ctrl.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

function zoneExists(zonesPayload, zoneId = '') {
  if (!zoneId || !Array.isArray(zonesPayload?.zones)) return false;
  return zonesPayload.zones.some(zone => String(zone?.id || '') === zoneId);
}

function hasCardZones(zonesPayload) {
  return Array.isArray(zonesPayload?.zones) && zonesPayload.zones.length > 0;
}

async function pushLivePreviewToHost(host, look, options = {}) {
  let previewLook = look;
  let previewZoneFallback = null;
  if (options.fallbackMissingZoneToAll && look?.zone) {
    try {
      const zonesPayload = await readCardZones(host, Math.min(options.timeoutMs || 2500, 1200));
      if (hasCardZones(zonesPayload) && !zoneExists(zonesPayload, String(look.zone))) {
        const { zone: requestedZone, ...fallbackLook } = look;
        previewLook = fallbackLook;
        previewZoneFallback = {
          requestedZone: String(requestedZone),
          availableZones: zonesPayload.zones.map(zone => String(zone?.id || '')).filter(Boolean),
        };
      }
    } catch {
      // If the zone probe fails, keep the original targeted request so the
      // normal connection error path can report the real card reachability issue.
    }
  }
  const url = `${cardHostToUrl(host)}/api/control`;
  const body = JSON.stringify(buildLivePreviewControlPayload(previewLook));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 2500);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CardPushError('http', `card returned ${response.status}: ${text || 'no body'}`);
    }
    const json = await response.json().catch(() => ({ ok: true }));
    return previewZoneFallback
      ? { ...json, previewZoneFallback: true, ...previewZoneFallback }
      : json;
  } finally {
    clearTimeout(timer);
  }
}

function normalizedPreviewTargets(targets = []) {
  return Array.isArray(targets)
    ? targets
        .filter(Boolean)
        .map(target => ({
          kind: target.kind || 'section',
          zone: target.kind === 'section' ? String(target.zoneId || target.id || '') : '',
          look: normalizeCardVisualLook(target.look || target),
        }))
    : [];
}

async function pushSectionPreviewToHost(host, targets = [], options = {}) {
  const normalizedTargets = normalizedPreviewTargets(targets);
  const sectionTargets = normalizedTargets.filter(target => target.kind === 'section' && target.zone);
  const allTarget = normalizedTargets.find(target => target.kind === 'all') || normalizedTargets[0];

  if (!sectionTargets.length) {
    return allTarget
      ? pushLivePreviewToHost(host, { ...allTarget.look, syncZones: true }, options)
      : { ok: true, zonesPreviewed: 0 };
  }

  let zonesPayload = null;
  try {
    zonesPayload = await readCardZones(host, Math.min(options.timeoutMs || 2500, 1200));
  } catch {
    zonesPayload = null;
  }

  if (hasCardZones(zonesPayload)) {
    const missingZones = sectionTargets
      .map(target => target.zone)
      .filter(zoneId => !zoneExists(zonesPayload, zoneId));
    if (missingZones.length) {
      const fallback = allTarget || sectionTargets[0];
      const response = await pushLivePreviewToHost(host, { ...fallback.look, syncZones: true }, options);
      return {
        ...response,
        previewZoneFallback: true,
        requestedZones: sectionTargets.map(target => target.zone),
        missingZones,
        availableZones: zonesPayload.zones.map(zone => String(zone?.id || '')).filter(Boolean),
      };
    }
  }

  const results = [];
  for (const target of sectionTargets) {
    results.push(await pushLivePreviewToHost(
      host,
      { ...target.look, zone: target.zone, syncZones: false },
      options,
    ));
  }
  return { ok: true, zonesPreviewed: sectionTargets.length, results };
}

function normalizePreviewError(host, error) {
  if (error instanceof CardPushError) return error;
  if (isMixedContentBlocked()) {
    return new CardPushError(
      'mixed-content',
      'Browser blocked the local card connection. Open the Studio from localhost or copy the config to the card page.',
      error,
    );
  }
  if (error?.name === 'AbortError') {
    return new CardPushError('offline', `Timed out reaching ${cardHostToUrl(host)}`, error);
  }
  return new CardPushError('offline', `Could not reach ${cardHostToUrl(host)}`, error);
}

export async function pushLivePreviewToCard(look, options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    return await pushLivePreviewToHost(host, look, options);
  } catch (error) {
    if (!isMixedContentBlocked() && options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 2500, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await pushLivePreviewToHost(found.host, look, options);
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}

export async function pushLiveHardwareToCard(settings, options = {}) {
  const host = options.host || readStoredCardHost();
  const payload = buildLiveHardwareControlPayload(settings);
  try {
    return await postControlPayloadToHost(host, payload, options);
  } catch (error) {
    if (!isMixedContentBlocked() && options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 2500, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await postControlPayloadToHost(found.host, payload, options);
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}

export async function pushSectionPreviewToCard(targets, options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    return await pushSectionPreviewToHost(host, targets, options);
  } catch (error) {
    if (!isMixedContentBlocked() && options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 2500, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await pushSectionPreviewToHost(found.host, targets, options);
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}
