import { normalizeCardHost, isLocalCardHost } from './cardConnection.js';
import { normalizeCardIdentity } from './cardIdentity.js';
import { classifyCardReadiness, normalizeCardReadiness } from './cardReadiness.js';

const UINT32_MAX = 0xffffffff;

const CARD_ID_PATTERN = /^lw-[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const VERSION_BUILD_BOOT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;

function exactText(value, maxLength, pattern = VERSION_BUILD_BOOT_PATTERN) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
    || (pattern && !pattern.test(value))
  ) {
    return '';
  }
  return value;
}

function isUint32(value, { allowZero = true } = {}) {
  return Number.isInteger(value)
    && value >= (allowZero ? 0 : 1)
    && value <= UINT32_MAX;
}

// Handoff targets are deliberately stricter than general card hosts. The
// normal bridge may use mDNS and legacy recovery addresses, but a WiFi
// migration may grant authority only to the literal RFC1918 address reported
// by the exact card. Loopback, link-local, setup AP, and public/multicast space
// are never valid station targets.
export function normalizeWifiHandoffHost(rawHost = '') {
  if (typeof rawHost !== 'string') return '';
  const text = rawHost.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return '';
  const parts = text.split('.');
  const octets = parts.map(Number);
  if (octets.some((value, index) => value > 255 || String(value) !== parts[index])) return '';
  const [a, b] = octets;
  const privateAddress = a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
  if (!privateAddress || text === '192.168.4.1') return '';
  const host = normalizeCardHost(text);
  return host === text && isLocalCardHost(host) ? host : '';
}

export function normalizeWifiHandoffCorrelation(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const host = normalizeWifiHandoffHost(raw.host ?? raw.stationIp);
  const expectedCardId = exactText(raw.expectedCardId ?? raw.cardId, 64, CARD_ID_PATTERN);
  const expectedFirmwareVersion = exactText(raw.expectedFirmwareVersion ?? raw.firmwareVersion, 48);
  const expectedBuildId = exactText(raw.expectedBuildId ?? raw.buildId, 96);
  const expectedBootId = exactText(raw.expectedBootId ?? raw.bootId, 96);
  if (!expectedCardId || !expectedFirmwareVersion || !expectedBuildId || !expectedBootId) return null;
  const expected = normalizeCardIdentity({
    cardId: expectedCardId,
    firmwareVersion: expectedFirmwareVersion,
    buildId: expectedBuildId,
  });
  const handoffGeneration = raw.handoffGeneration;
  if (
    !host
    || expected.id !== expectedCardId
    || expected.firmwareVersion !== expectedFirmwareVersion
    || expected.buildId !== expectedBuildId
    || !isUint32(handoffGeneration, { allowZero: false })
  ) {
    return null;
  }
  return Object.freeze({
    host,
    expectedCardId: expected.id,
    expectedFirmwareVersion: expected.firmwareVersion,
    expectedBuildId: expected.buildId,
    expectedBootId,
    handoffGeneration,
  });
}

function expectedIdentity(options = {}) {
  const source = options.expectedCard || {};
  const id = exactText(source.id ?? source.cardId ?? options.expectedCardId, 64, CARD_ID_PATTERN);
  const firmwareVersion = exactText(source.firmwareVersion ?? options.expectedFirmwareVersion, 48);
  const buildId = exactText(
    source.buildId ?? source.firmwareBuild ?? source.build ?? options.expectedBuildId,
    96,
  );
  if (!id || !firmwareVersion || !buildId) return null;
  const normalized = normalizeCardIdentity({
    cardId: id,
    firmwareVersion,
    buildId,
  });
  return normalized.id === id
      && normalized.firmwareVersion === firmwareVersion
      && normalized.buildId === buildId
    ? normalized
    : null;
}

function readinessMatches(status, expected, expectedBootId) {
  if (!expected) return false;
  const rawCardId = exactText(status?.cardId ?? status?.id, 64, CARD_ID_PATTERN);
  const rawFirmwareVersion = exactText(status?.firmwareVersion, 48);
  const rawBuildId = exactText(status?.buildId, 96);
  const rawBootId = exactText(status?.bootId, 96);
  if (
    rawCardId !== expected.id
    || rawFirmwareVersion !== expected.firmwareVersion
    || rawBuildId !== expected.buildId
    || rawBootId !== expectedBootId
  ) {
    return false;
  }
  const normalized = normalizeCardReadiness(status);
  if (!normalized.contractSupported || !normalized.identityValid) return false;
  if (
    normalized.knownGoodProject === null
    || normalized.commandReady === null
    || normalized.outputReady === null
    || normalized.bootId !== expectedBootId
  ) {
    return false;
  }
  const readiness = classifyCardReadiness(status, {
    expectedCard: expected,
    previousBootId: expectedBootId,
  });
  return !['checking', 'identity-mismatch', 'revalidating'].includes(readiness.state);
}

export function acceptWifiHandoff(options = {}) {
  const status = options.status;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  const expected = expectedIdentity(options);
  const expectedBootId = exactText(options.expectedBootId, 96);
  const lastGeneration = options.lastGeneration ?? 0;
  if (
    !expected
    || !expectedBootId
    || !isUint32(lastGeneration)
    || !readinessMatches(status, expected, expectedBootId)
  ) {
    return null;
  }

  const wifi = status.wifi;
  if (
    !wifi
    || typeof wifi !== 'object'
    || Array.isArray(wifi)
    || wifi.transition !== 'handoff-ready'
    || wifi.transitionPending !== true
    || wifi.apActive !== true
    || !isUint32(wifi.handoffGeneration, { allowZero: false })
    || wifi.handoffGeneration <= lastGeneration
  ) {
    return null;
  }

  const host = normalizeWifiHandoffHost(wifi.stationIp);
  if (!host) return null;
  return normalizeWifiHandoffCorrelation({
    host,
    expectedCardId: expected.id,
    expectedFirmwareVersion: expected.firmwareVersion,
    expectedBuildId: expected.buildId,
    expectedBootId,
    handoffGeneration: wifi.handoffGeneration,
  });
}

export function isFinalStationHandoff({ status, correlation } = {}) {
  const expected = normalizeWifiHandoffCorrelation(correlation);
  if (!expected || !status || typeof status !== 'object' || Array.isArray(status)) return false;
  if (status.commandReady !== true) return false;
  const identity = {
    id: expected.expectedCardId,
    firmwareVersion: expected.expectedFirmwareVersion,
    buildId: expected.expectedBuildId,
  };
  if (!readinessMatches(status, identity, expected.expectedBootId)) return false;
  const wifi = status.wifi;
  if (
    !wifi
    || typeof wifi !== 'object'
    || Array.isArray(wifi)
    || wifi.transition !== 'station'
    || wifi.transitionPending !== false
    || wifi.transport !== 'station'
    || wifi.handoffGeneration !== expected.handoffGeneration
  ) {
    return false;
  }
  const stationIp = normalizeWifiHandoffHost(wifi.stationIp);
  const activeIp = normalizeWifiHandoffHost(wifi.ip);
  return stationIp === expected.host && activeIp === expected.host;
}
