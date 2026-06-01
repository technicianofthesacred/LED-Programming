// Client for pushing a runtime config from the designer to a live Lightweaver
// card. Mirrors the firmware's /api/config POST endpoint.
//
// Hostname resolution: the designer remembers the most recently used card.
// Mixed-content is a real concern when the designer runs on HTTPS (it does,
// at led.mandalacodes.com/design) - fetches to plain HTTP local hosts will
// be blocked by the browser. The client surfaces that as a typed error the
// UI handles by showing a copy-paste fallback.

import {
  canPushDirectlyToCard,
  cardHostToUrl,
  discoverCardStatus,
  normalizeCardHost,
  readStoredCardHost,
  writeStoredCardHost,
} from './cardConnection.js';
import { sendCardBridgeRequest } from './cardBridge.js';

export function getCardHostname() {
  return readStoredCardHost();
}

export function setCardHostname(host) {
  return writeStoredCardHost(host);
}

export function encodeCardConfigHandoffPayload(runtimePackage = {}) {
  const text = JSON.stringify(runtimePackage.config || runtimePackage);
  if (typeof TextEncoder !== 'undefined' && typeof btoa === 'function') {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function decodeCardConfigHandoffPayload(payload = '') {
  const normalized = String(payload || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  if (typeof atob === 'function' && typeof TextDecoder !== 'undefined') {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function buildCardConfigHandoffUrl(host, runtimePackage = {}, { reboot = true } = {}) {
  const encoded = encodeCardConfigHandoffPayload(runtimePackage);
  const params = new URLSearchParams({ lwconfig: encoded });
  if (reboot) params.set('reboot', '1');
  return `${cardHostToUrl(host)}/#${params.toString()}`;
}

export class CardPushError extends Error {
  constructor(reason, message, cause) {
    super(message);
    this.reason = reason; // 'mixed-content' | 'offline' | 'http' | 'unknown'
    if (cause instanceof Error) this.cause = cause;
  }
}

function isMixedContentBlocked() {
  return typeof window !== 'undefined' && !canPushDirectlyToCard(window.location.protocol);
}

async function postConfigToHost(host, runtimePackage, options = {}) {
  const url = `${cardHostToUrl(host)}/api/config`;
  const body = JSON.stringify(runtimePackage.config || runtimePackage);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 6000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new CardPushError('http', `card returned ${r.status}: ${text || 'no body'}`);
    }
    const json = await r.json().catch(() => ({ ok: true }));
    const shouldReboot = options.reboot === true ||
      (options.reboot === 'if-needed' && await cardNeedsConfigReboot(host, runtimePackage, options));
    if (shouldReboot) {
      await requestCardReboot(host, options);
      return { ...json, rebooting: true };
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOutputsForCompare(outputs = []) {
  return Array.isArray(outputs)
    ? outputs.map(output => ({
        pin: Number(output?.pin),
        pixels: Number(output?.pixels ?? output?.pixelCount),
      }))
    : [];
}

function outputsMatch(a = [], b = []) {
  const left = normalizeOutputsForCompare(a);
  const right = normalizeOutputsForCompare(b);
  if (left.length !== right.length) return false;
  return left.every((output, index) => (
    output.pin === right[index]?.pin &&
    output.pixels === right[index]?.pixels
  ));
}

function targetRuntimeOutputs(runtimePackage = {}) {
  return normalizeOutputsForCompare((runtimePackage.config || runtimePackage)?.led?.outputs);
}

export function cardConfigNeedsRebootFromInfo(current = {}, runtimePackage = {}) {
  const targetOutputs = targetRuntimeOutputs(runtimePackage);
  if (!targetOutputs.length) return false;
  return !outputsMatch(current?.outputs, targetOutputs);
}

function summarizeOutputs(outputs = []) {
  const normalized = normalizeOutputsForCompare(outputs);
  const total = normalized.reduce((sum, output) => sum + output.pixels, 0);
  return `${total} LEDs / ${normalized.length || 0} output${normalized.length === 1 ? '' : 's'}`;
}

function layoutMismatchError(current = {}, runtimePackage = {}) {
  const targetOutputs = targetRuntimeOutputs(runtimePackage);
  return new CardPushError(
    'layout-mismatch',
    `Stopped before saving: this would change the card output layout from ${summarizeOutputs(current?.outputs)} to ${summarizeOutputs(targetOutputs)}. Use Settings or Send split preview when you intentionally want to change LED wiring.`,
  );
}

async function readFirmwareInfoToHost(host, timeoutMs = 1200) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${cardHostToUrl(host)}/api/firmware-info`, { signal: ctrl.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function cardNeedsConfigReboot(host, runtimePackage, options = {}) {
  const current = await readFirmwareInfoToHost(host, Math.min(options.timeoutMs || 6000, 1200));
  return current ? cardConfigNeedsRebootFromInfo(current, runtimePackage) : false;
}

async function resolveConfigRebootForCard(host, runtimePackage, options = {}) {
  if (options.reboot !== 'if-needed') {
    return { reboot: options.reboot === true, current: null, layoutChanged: false };
  }
  const timeoutMs = Math.min(options.timeoutMs || 6000, 1200);
  const current = isMixedContentBlocked()
    ? await sendCardBridgeRequest('firmware-info', {}, {
        host,
        timeoutMs,
        retryOnTimeout: true,
      }).catch(() => null)
    : await readFirmwareInfoToHost(host, timeoutMs);
  const layoutChanged = current ? cardConfigNeedsRebootFromInfo(current, runtimePackage) : false;
  return { reboot: layoutChanged, current, layoutChanged };
}

async function requestCardReboot(host, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(options.timeoutMs || 6000, 1200));
  try {
    await fetch(`${cardHostToUrl(host)}/api/reboot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctrl.signal,
    });
  } catch {
    // The card may close the HTTP connection as it reboots; the config is
    // already saved, so treat this as an accepted reboot request.
  } finally {
    clearTimeout(timer);
  }
}

function normalizeConfigPushError(host, err) {
  if (err instanceof CardPushError) return err;
  if (isMixedContentBlocked()) {
    return new CardPushError(
      'mixed-content',
      'Browser blocked the connection (mixed content). Use the copy-paste fallback or open the designer over plain HTTP.',
      err,
    );
  }
  if (err && err.name === 'AbortError') {
    return new CardPushError('offline', `Timed out reaching ${cardHostToUrl(host)}`, err);
  }
  return new CardPushError('offline', `Could not reach ${cardHostToUrl(host)}`, err);
}

// POST the runtime config to the card. Returns the parsed JSON echo on
// success; throws CardPushError on failure with a typed reason.
export async function pushConfigToCard(runtimePackage, options = {}) {
  const host = options.host || getCardHostname();
  const rebootPlan = await resolveConfigRebootForCard(host, runtimePackage, options);
  if (rebootPlan.layoutChanged && options.allowLayoutChange !== true) {
    throw layoutMismatchError(rebootPlan.current, runtimePackage);
  }
  const pushOptions = {
    ...options,
    reboot: options.reboot === 'if-needed' ? rebootPlan.reboot : options.reboot,
  };
  if (isMixedContentBlocked()) {
    try {
      return await sendCardBridgeRequest(
        'config',
        runtimePackage.config || runtimePackage,
        { host, timeoutMs: options.timeoutMs || 6000, reboot: pushOptions.reboot },
      );
    } catch (err) {
      if (err instanceof CardPushError) throw err;
      throw new CardPushError(
        'mixed-content',
        err?.reason === 'bridge-missing' || err?.reason === 'bridge-timeout'
          ? 'Open the card page once by clicking Card disconnected, then return to Studio so it can save through the local bridge.'
          : 'Browser blocked the connection (mixed content). Use the local card installer handoff.',
        err,
      );
    }
  }
  try {
    return await postConfigToHost(host, runtimePackage, pushOptions);
  } catch (err) {
    if (options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 6000, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          const retryRebootPlan = await resolveConfigRebootForCard(found.host, runtimePackage, options);
          if (retryRebootPlan.layoutChanged && options.allowLayoutChange !== true) {
            throw layoutMismatchError(retryRebootPlan.current, runtimePackage);
          }
          const retryOptions = {
            ...options,
            reboot: options.reboot === 'if-needed' ? retryRebootPlan.reboot : options.reboot,
          };
          return await postConfigToHost(found.host, runtimePackage, retryOptions);
        } catch (retryErr) {
          if (retryErr instanceof CardPushError) throw retryErr;
          throw normalizeConfigPushError(found.host, retryErr);
        }
      }
    }
    throw normalizeConfigPushError(host, err);
  }
}
