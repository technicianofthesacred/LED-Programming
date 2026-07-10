import {
  canPushDirectlyToCard,
  cardHostToUrl,
  discoverCardStatus,
  normalizeCardHost,
  readStoredCardHost,
} from './cardConnection.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';
import { getCardPatternRuntimeId } from './cardPatternBank.js';
import { DEFAULT_CARD_PATTERN_BANK } from './cardRuntimeContract.js';
import { CardPushError, pushConfigToCard } from './cardPushClient.js';
import { sendCardBridgeRequest } from './cardBridge.js';

function isMixedContentBlocked() {
  return typeof window !== 'undefined' && !canPushDirectlyToCard(window.location.protocol);
}

const COLOR_ORDER_OPTIONS = new Set(['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR']);
const MIRRORED_REPAIR_OUTPUT_PIN = 16;
const MIRRORED_REPAIR_DEFAULT_PIXELS = 44;
const MIRRORED_REPAIR_LOOK_IDS = ['fire', 'ripple', 'warm-white', 'aurora', 'plasma', 'ocean', 'rainbow', 'scanner'];
const latestPreviewQueues = new Map();

function supersededPreviewError() {
  return new CardPushError('superseded', 'Superseded by a newer live preview request.');
}

function latestPreviewQueueKey(host = '') {
  return normalizeCardHost(host || readStoredCardHost());
}

function enqueueLatestPreview(key, task) {
  let queue = latestPreviewQueues.get(key);
  if (!queue) {
    queue = { running: false, pending: null };
    latestPreviewQueues.set(key, queue);
  }

  return new Promise((resolve, reject) => {
    if (queue.pending) {
      queue.pending.reject(supersededPreviewError());
    }
    queue.pending = { task, resolve, reject };
    void drainLatestPreviewQueue(key, queue);
  });
}

async function drainLatestPreviewQueue(key, queue) {
  if (queue.running) return;
  while (queue.pending) {
    const request = queue.pending;
    queue.pending = null;
    queue.running = true;
    try {
      request.resolve(await request.task());
    } catch (error) {
      request.reject(error);
    } finally {
      queue.running = false;
    }
  }
  if (!queue.pending) latestPreviewQueues.delete(key);
}

// Live-preview pushes may fall back from a specific zone to the whole strip
// when the card does not have that zone yet. The resolved response always
// carries `previewZoneFallback` when that happened; callers use this helper so
// the fallback can never pass silently (contract: no silent zone fallback).
export function previewResponseUsedZoneFallback(response) {
  return Boolean(response?.previewZoneFallback);
}

export function buildLiveHardwareControlPayload(settings = {}) {
  const colorOrder = String(settings.colorOrder || '').toUpperCase();
  return {
    ...(COLOR_ORDER_OPTIONS.has(colorOrder) ? { colorOrder } : {}),
  };
}

export function buildLivePreviewControlPayload(look = {}) {
  const normalized = normalizeCardVisualLook(look);
  const runtimePatternId = getCardPatternRuntimeId(normalized.patternId) || normalized.patternId;
  return {
    cancelStream: true,
    ...(look.zone ? { zone: String(look.zone) } : {}),
    ...(typeof look.syncZones === 'boolean' ? { syncZones: look.syncZones } : {}),
    ...(typeof look.blackout === 'boolean' ? { blackout: look.blackout } : {}),
    patternId: runtimePatternId,
    brightness: normalized.brightness,
    speed: normalized.speed,
    hueShift: normalized.hueShift,
    hue: normalized.customHue,
    saturation: normalized.customSaturation,
    breathe: normalized.customBreathe,
    drift: normalized.customDrift,
  };
}

function buildRecoverLightsPayload(look = {}) {
  const normalized = normalizeCardVisualLook(look);
  const runtimePatternId = getCardPatternRuntimeId(normalized.patternId) || normalized.patternId;
  return {
    patternId: runtimePatternId,
    brightness: normalized.brightness,
    ...(typeof look.syncZones === 'boolean' ? { syncZones: look.syncZones } : {}),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function sumOutputPixels(outputs = []) {
  return Array.isArray(outputs)
    ? outputs.reduce((sum, output) => sum + Math.max(0, Math.floor(Number(output?.pixels ?? output?.pixelCount) || 0)), 0)
    : 0;
}

function defaultRepairPatterns() {
  return DEFAULT_CARD_PATTERN_BANK.map(pattern => ({
    id: pattern.id,
    label: pattern.label,
    mode: pattern.mode || (pattern.id === 'warm-white' ? 'preset' : 'procedural'),
    ...(pattern.preset ? { preset: pattern.preset } : {}),
  }));
}

function defaultRepairLooks() {
  return MIRRORED_REPAIR_LOOK_IDS.map(id => {
    const pattern = DEFAULT_CARD_PATTERN_BANK.find(item => item.id === id) || { id, label: id };
    return {
      id,
      label: pattern.label || id,
      mode: id === 'warm-white' ? 'preset' : 'procedural',
      preset: id,
      brightness: 1,
    };
  });
}

export function buildMirroredLedRepairPackage(runtimePackage = {}, options = {}) {
  const sourcePackage = runtimePackage?.config ? runtimePackage : { config: runtimePackage };
  const sourceConfig = cloneJson(sourcePackage.config || {});
  const configuredOutputPixels = sumOutputPixels(sourceConfig.led?.outputs || sourceConfig.outputs);
  const pixelCount = Math.max(
    1,
    Math.floor(Number(options.pixels || configuredOutputPixels || sourceConfig.led?.pixels || MIRRORED_REPAIR_DEFAULT_PIXELS) || MIRRORED_REPAIR_DEFAULT_PIXELS),
  );
  const patterns = Array.isArray(sourceConfig.patterns) && sourceConfig.patterns.length
    ? sourceConfig.patterns
    : defaultRepairPatterns();
  const looks = Array.isArray(sourceConfig.looks) && sourceConfig.looks.length
    ? sourceConfig.looks
    : defaultRepairLooks();
  const startupPatternId = sourceConfig.startupPatternId || looks[0]?.id || 'fire';
  const zones = Array.isArray(sourceConfig.zones) && sourceConfig.zones.length
    ? sourceConfig.zones
    : [{
        id: 'full-piece',
        label: 'Full piece',
        patternId: startupPatternId,
        brightness: 1,
        speed: 1,
        hueShift: 0,
        customHue: 32,
        customSaturation: 230,
        ranges: [{ start: 0, count: pixelCount }],
      }];

  return {
    app: sourcePackage.app || 'Lightweaver',
    format: sourcePackage.format || 'lightweaver-card-runtime-package',
    version: sourcePackage.version || 1,
    config: {
      ...sourceConfig,
      version: sourceConfig.version || 1,
      mode: sourceConfig.mode || 'website-flash',
      piece: {
        id: sourceConfig.piece?.id || sourceConfig.projectId || 'lightweaver-repair',
        name: options.projectName || sourceConfig.piece?.name || sourceConfig.projectName || 'Lightweaver repair',
      },
      led: {
        ...(sourceConfig.led || {}),
        pixels: pixelCount,
        colorOrder: sourceConfig.led?.colorOrder || 'RGB',
        brightnessLimit: Number.isFinite(Number(sourceConfig.led?.brightnessLimit))
          ? Number(sourceConfig.led.brightnessLimit)
          : 0.65,
        outputs: [{
          id: 'out1',
          name: 'Output 1 mirrored',
          pin: MIRRORED_REPAIR_OUTPUT_PIN,
          pixels: pixelCount,
        }],
      },
      controls: sourceConfig.controls || {},
      patterns,
      looks,
      startupPatternId,
      zones,
      syncZones: true,
    },
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

async function postRecoverLightsToHost(host, payload, options = {}) {
  const url = `${cardHostToUrl(host)}/api/recover-lights`;
  const body = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 3000);
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

async function postIdentifyToHost(host, options = {}) {
  const url = `${cardHostToUrl(host)}/api/identify`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 1200);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
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
  if (isMixedContentBlocked()) {
    return sendCardBridgeRequest('zones', {}, { host, timeoutMs });
  }
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

export async function readCardZonesFromCard(options = {}) {
  const host = options.host || readStoredCardHost();
  return readCardZones(host, options.timeoutMs || 1200);
}

function zoneExists(zonesPayload, zoneId = '') {
  if (!zoneId || !Array.isArray(zonesPayload?.zones)) return false;
  return zonesPayload.zones.some(zone => String(zone?.id || '') === zoneId);
}

function hasCardZones(zonesPayload) {
  return Array.isArray(zonesPayload?.zones) && zonesPayload.zones.length > 0;
}

function liveLookFromZone(zone = {}, fallbackLook = {}) {
  return {
    ...normalizeCardVisualLook({
      ...fallbackLook,
      ...(zone.patternId ? { patternId: zone.patternId } : {}),
      ...(Number.isFinite(Number(zone.brightness)) ? { brightness: Number(zone.brightness) } : {}),
      ...(Number.isFinite(Number(zone.speed)) ? { speed: Number(zone.speed) } : {}),
      ...(Number.isFinite(Number(zone.hueShift)) ? { hueShift: Number(zone.hueShift) } : {}),
      ...(Number.isFinite(Number(zone.customHue)) ? { customHue: Number(zone.customHue) } : {}),
      ...(Number.isFinite(Number(zone.customSaturation)) ? { customSaturation: Number(zone.customSaturation) } : {}),
      ...(typeof zone.customBreathe === 'boolean' ? { customBreathe: zone.customBreathe } : {}),
      ...(typeof zone.customDrift === 'boolean' ? { customDrift: zone.customDrift } : {}),
    }),
    blackout: false,
  };
}

function liveTargetsFromZones(zonesPayload = {}, fallbackLook = {}) {
  return hasCardZones(zonesPayload)
    ? zonesPayload.zones
        .filter(zone => zone?.id)
        .map(zone => ({
          kind: 'section',
          zone: String(zone.id),
          look: liveLookFromZone(zone, fallbackLook),
        }))
    : [];
}

async function pushLivePreviewToHost(host, look, options = {}) {
  if (isMixedContentBlocked()) {
    return pushLivePreviewToBridge(host, look, options);
  }
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

async function pushLivePreviewToBridge(host, look, options = {}) {
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
      // Keep the original request so the bridge error path can report the
      // actual handoff problem if the card page is not open or not updated.
    }
  }
  const json = await sendCardBridgeRequest(
    'control',
    buildLivePreviewControlPayload(previewLook),
    { host, timeoutMs: options.timeoutMs || 2500 },
  );
  return previewZoneFallback
    ? { ...json, previewZoneFallback: true, ...previewZoneFallback }
    : json;
}

function normalizedPreviewTargets(targets = []) {
  return Array.isArray(targets)
    ? targets
        .filter(Boolean)
        .map(target => {
          const sourceLook = target.look || target;
          return {
            kind: target.kind || 'section',
            zone: target.kind === 'section' ? String(target.zoneId || target.id || '') : '',
            look: {
              ...normalizeCardVisualLook(sourceLook),
              ...(typeof sourceLook.blackout === 'boolean' ? { blackout: sourceLook.blackout } : {}),
            },
          };
        })
    : [];
}

async function pushSectionPreviewToHost(host, targets = [], options = {}) {
  if (isMixedContentBlocked()) {
    return pushSectionPreviewToBridge(host, targets, options);
  }
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

async function pushSectionPreviewToBridge(host, targets = [], options = {}) {
  const normalizedTargets = normalizedPreviewTargets(targets);
  const sectionTargets = normalizedTargets.filter(target => target.kind === 'section' && target.zone);
  const allTarget = normalizedTargets.find(target => target.kind === 'all') || normalizedTargets[0];

  if (!sectionTargets.length) {
    return allTarget
      ? pushLivePreviewToBridge(host, { ...allTarget.look, syncZones: true }, options)
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
      const response = await pushLivePreviewToBridge(host, { ...fallback.look, syncZones: true }, options);
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
    results.push(await pushLivePreviewToBridge(
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
      error?.reason === 'bridge-missing' || error?.reason === 'bridge-timeout'
        ? 'Open the card page once by clicking Card disconnected, then return to Studio so it can use the card as a local bridge.'
        : 'Browser blocked the local card connection. Open the Studio from localhost or copy the config to the card page.',
      error,
    );
  }
  if (error?.name === 'AbortError') {
    return new CardPushError('offline', `Timed out reaching ${cardHostToUrl(host)}`, error);
  }
  return new CardPushError('offline', `Could not reach ${cardHostToUrl(host)}`, error);
}

async function sendLivePreviewToCard(look, options = {}) {
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

export async function pushLivePreviewToCard(look, options = {}) {
  const host = options.host || readStoredCardHost();
  if (options.latestOnly === false) {
    return sendLivePreviewToCard(look, options);
  }
  return enqueueLatestPreview(
    latestPreviewQueueKey(host),
    () => sendLivePreviewToCard(look, options),
  );
}

export async function pushLiveHardwareToCard(settings, options = {}) {
  const host = options.host || readStoredCardHost();
  const payload = buildLiveHardwareControlPayload(settings);
  if (isMixedContentBlocked()) {
    try {
      return await sendCardBridgeRequest('control', payload, { host, timeoutMs: options.timeoutMs || 2500 });
    } catch (error) {
      throw normalizePreviewError(host, error);
    }
  }
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

export async function identifyCardLights(options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    return await postIdentifyToHost(host, options);
  } catch (error) {
    if (!isMixedContentBlocked() && options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 1200, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await postIdentifyToHost(found.host, options);
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}

export async function recoverCardLights(look = {}, options = {}) {
  const host = options.host || readStoredCardHost();
  const payload = buildRecoverLightsPayload(look);
  if (isMixedContentBlocked()) {
    try {
      return await sendCardBridgeRequest('recover-lights', payload, { host, timeoutMs: options.timeoutMs || 3000 });
    } catch (error) {
      throw normalizePreviewError(host, error);
    }
  }
  try {
    return await postRecoverLightsToHost(host, payload, options);
  } catch (error) {
    if (options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 3000, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await postRecoverLightsToHost(found.host, payload, options);
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

export async function resetLiveOutputOnCard(fallbackLook = {}, options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    const zonesPayload = await readCardZones(host, Math.min(options.timeoutMs || 3000, 1400)).catch(() => null);
    const targets = liveTargetsFromZones(zonesPayload, fallbackLook);
    if (targets.length) {
      const results = [];
      for (const target of targets) {
        results.push(await pushLivePreviewToHost(host, {
          ...target.look,
          zone: target.zone,
          syncZones: false,
          blackout: false,
        }, options));
      }
      return {
        ok: true,
        source: 'zones',
        zonesPreviewed: targets.length,
        results,
      };
    }

    const response = await pushLivePreviewToHost(host, {
      ...normalizeCardVisualLook(fallbackLook),
      syncZones: true,
      blackout: false,
    }, options);
    return {
      ...response,
      source: 'fallback',
    };
  } catch (error) {
    if (!isMixedContentBlocked() && options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 3000, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await resetLiveOutputOnCard(fallbackLook, {
            ...options,
            host: found.host,
            autoDiscover: false,
          });
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}

export async function repairMirroredLedOutputOnCard(runtimePackage = {}, options = {}) {
  const host = options.host || readStoredCardHost();
  const repairPackage = buildMirroredLedRepairPackage(runtimePackage, options);
  const response = await pushConfigToCard(repairPackage, {
    ...options,
    host,
    timeoutMs: options.timeoutMs || 6000,
    reboot: options.reboot || 'if-needed',
    allowLayoutChange: true,
  });
  return {
    ...response,
    repairPackage,
    outputPin: MIRRORED_REPAIR_OUTPUT_PIN,
    pixels: repairPackage.config.led.pixels,
  };
}
