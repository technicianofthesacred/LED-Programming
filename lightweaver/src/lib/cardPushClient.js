// Client for pushing a runtime config from the designer to a live Lightweaver
// card. Mirrors the firmware's /api/config POST endpoint.
//
// Hostname resolution: the designer remembers the most recently used card.
// Mixed-content is a real concern when the designer runs on HTTPS (it does at
// led.mandalacodes.com) - fetches to plain HTTP local hosts will
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
import { guardDirectCardMutation, normalizeCardProjectEvidence } from './cardIdentity.js';
import {
  CardConfigCapacityError,
  prepareCardStoragePayload,
} from './cardStoragePayload.js';
import { stageCardWiringCandidate } from './cardWiringSafety.js';

export function getCardHostname() {
  return readStoredCardHost();
}

export function setCardHostname(host) {
  return writeStoredCardHost(host);
}

export function encodeCardConfigHandoffPayload(runtimePackage = {}) {
  const text = cardStorageJson(runtimePackage);
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

export function cardStorageJson(runtimePackage = {}) {
  return prepareCardStoragePayload(runtimePackage).json;
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
  const body = options.preparedPayload?.json || cardStorageJson(runtimePackage);
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
      json?.requiresReboot === true ||
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

function targetRuntimePiece(runtimePackage = {}) {
  return (runtimePackage.config || runtimePackage)?.piece || {};
}

function normalizePieceId(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function cardConfigNeedsRebootFromInfo(current = {}, runtimePackage = {}) {
  const targetOutputs = targetRuntimeOutputs(runtimePackage);
  if (!targetOutputs.length) return false;
  return !outputsMatch(current?.outputs, targetOutputs);
}

function cardConfigProjectMismatchFromInfo(current = {}, runtimePackage = {}) {
  const currentPieceId = normalizePieceId(current?.piece?.id);
  const targetPieceId = normalizePieceId(targetRuntimePiece(runtimePackage)?.id);
  return Boolean(currentPieceId && targetPieceId && currentPieceId !== targetPieceId);
}

function summarizeOutputs(outputs = []) {
  const normalized = normalizeOutputsForCompare(outputs);
  const total = normalized.reduce((sum, output) => sum + output.pixels, 0);
  return `${total} LEDs / ${normalized.length || 0} output${normalized.length === 1 ? '' : 's'}`;
}

function layoutMismatchError(current = {}, runtimePackage = {}) {
  const targetOutputs = targetRuntimeOutputs(runtimePackage);
  const currentSummary = summarizeOutputs(current?.outputs);
  const targetSummary = summarizeOutputs(targetOutputs);
  const err = new CardPushError(
    'layout-mismatch',
    `Stopped before saving: this would change the card output layout from ${currentSummary} to ${targetSummary}. Use Settings or Send split preview when you intentionally want to change LED wiring.`,
  );
  err.layout = { current: currentSummary, target: targetSummary };
  return err;
}

function projectMismatchError(current = {}, runtimePackage = {}) {
  const currentPiece = current?.piece || {};
  const targetPiece = targetRuntimePiece(runtimePackage);
  const currentName = currentPiece.name || currentPiece.id || 'another Studio project';
  const targetName = targetPiece.name || targetPiece.id || 'this Studio project';
  const err = new CardPushError(
    'project-mismatch',
    `Stopped before saving: this card is paired with ${currentName}, but the open Studio project is ${targetName}. Open the matching project or intentionally recommission the card from Settings.`,
  );
  err.pieces = { current: currentName, target: targetName };
  return err;
}

async function readFirmwareInfoToHost(host, timeoutMs = 1200, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${cardHostToUrl(host)}/api/firmware-info`, { method: 'GET', cache: 'no-store', signal: ctrl.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readCardProjectEvidence({ host, timeoutMs = 3000, transport, fetchImpl = fetch } = {}) {
  if (transport === 'bridge' || (transport !== 'direct' && isMixedContentBlocked())) {
    const response = await sendCardBridgeRequest('firmware-info', { cache: 'no-store', nonce: Date.now() }, { host, timeoutMs, retryOnTimeout: true });
    return normalizeCardProjectEvidence(response);
  }
  const result = await readFirmwareInfoToHost(host, timeoutMs, fetchImpl);
  if (!result) throw new CardPushError('readback', 'The card did not return independent firmware and project evidence.');
  return normalizeCardProjectEvidence(result);
}

async function cardNeedsConfigReboot(host, runtimePackage, options = {}) {
  const current = await readFirmwareInfoToHost(host, Math.min(options.timeoutMs || 6000, 1200));
  return current ? cardConfigNeedsRebootFromInfo(current, runtimePackage) : false;
}

async function resolveConfigRebootForCard(host, runtimePackage, options = {}) {
  const timeoutMs = Math.min(options.timeoutMs || 6000, 1200);
  const current = isMixedContentBlocked()
    ? await sendCardBridgeRequest('firmware-info', {}, {
        host,
        timeoutMs,
        retryOnTimeout: true,
      }).catch(() => null)
    : await readFirmwareInfoToHost(host, timeoutMs);
  const layoutChanged = current ? cardConfigNeedsRebootFromInfo(current, runtimePackage) : false;
  const projectChanged = current ? cardConfigProjectMismatchFromInfo(current, runtimePackage) : false;
  const reboot = options.reboot === true ||
    (options.reboot === 'if-needed' && layoutChanged);
  return { reboot, current, layoutChanged, projectChanged };
}

export async function requestCardReboot(host, options = {}) {
  await guardDirectCardMutation(host, { fetchImpl: options.fetchImpl, timeoutMs: Math.min(options.timeoutMs || 6000, 1200) });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(options.timeoutMs || 6000, 1200));
  try {
    const response = await fetch(`${cardHostToUrl(host)}/api/reboot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CardPushError('http', `card returned ${response.status}: ${text || 'reboot was rejected'}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function normalizeConfigPushError(host, err) {
  if (err instanceof CardConfigCapacityError) return err;
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
  // Prepare before discovery, bridge messaging, or direct HTTP so an
  // over-capacity configuration never causes an external side effect.
  const preparedPayload = prepareCardStoragePayload(runtimePackage);
  const host = options.host || getCardHostname();
  if (!isMixedContentBlocked()) {
    await guardDirectCardMutation(host, { fetchImpl: options.fetchImpl, timeoutMs: Math.min(options.timeoutMs || 6000, 1500) });
  }
  const rebootPlan = await resolveConfigRebootForCard(host, runtimePackage, options);
  if (rebootPlan.projectChanged && options.allowProjectChange !== true) {
    throw projectMismatchError(rebootPlan.current, runtimePackage);
  }
  if (rebootPlan.layoutChanged && options.allowLayoutChange !== true) {
    throw layoutMismatchError(rebootPlan.current, runtimePackage);
  }
  // Physical output changes are never written over the running/known-good
  // layout. The card owns a separate candidate slot and issues the activation
  // identifier that the UI must use for test, confirmation, or rollback.
  if (rebootPlan.layoutChanged) {
    try {
      return await stageCardWiringCandidate(preparedPayload.config, {
        host,
        timeoutMs: options.timeoutMs || 6000,
      });
    } catch (err) {
      throw normalizeConfigPushError(host, err);
    }
  }
  const pushOptions = {
    ...options,
    reboot: options.reboot === 'if-needed' ? rebootPlan.reboot : options.reboot,
    preparedPayload,
  };
  if (isMixedContentBlocked()) {
    try {
      return await sendCardBridgeRequest(
        'config',
        preparedPayload.config,
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
          await guardDirectCardMutation(found.host, { fetchImpl: options.fetchImpl, timeoutMs: Math.min(options.timeoutMs || 6000, 1500) });
          const retryRebootPlan = await resolveConfigRebootForCard(found.host, runtimePackage, options);
          if (retryRebootPlan.projectChanged && options.allowProjectChange !== true) {
            throw projectMismatchError(retryRebootPlan.current, runtimePackage);
          }
          if (retryRebootPlan.layoutChanged && options.allowLayoutChange !== true) {
            throw layoutMismatchError(retryRebootPlan.current, runtimePackage);
          }
          const retryOptions = {
            ...options,
            reboot: options.reboot === 'if-needed' ? retryRebootPlan.reboot : options.reboot,
            preparedPayload,
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
