import * as firmwareReleaseCore from './firmwareRelease.js';

const BUILD_ID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

async function sha256Hex(value) {
  const source = bytes(value);
  if (!source || !globalThis.crypto?.subtle) throw new Error('SHA-256 verification is unavailable.');
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function signaturePresent(value) {
  const raw = bytes(value);
  if (raw) return raw.byteLength === 64;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{86}\n?$/.test(value);
}

export async function loadVerifiedFirmwareUpdateRelease({
  loadRelease = firmwareReleaseCore.loadProductionFirmwareUpdateRelease,
} = {}) {
  if (typeof loadRelease !== 'function') {
    throw new Error('The shared installer core does not yet export loadProductionFirmwareUpdateRelease.');
  }
  const loaded = await loadRelease();
  const manifest = loaded?.manifest;
  const ticket = loaded?.ticket;
  const ticketBytes = bytes(loaded?.ticketBytes);
  const imageBytes = bytes(loaded?.imageBytes);
  const ticketSha256 = String(loaded?.ticketSha256 || '').toLowerCase();
  if (!manifest || !ticket || !ticketBytes?.byteLength || !imageBytes?.byteLength
    || !signaturePresent(loaded?.ticketSignature)
    || !BUILD_ID.test(String(manifest.buildId || ''))
    || !BUILD_ID.test(String(ticket.buildId || ''))
    || !SHA256.test(ticketSha256)) {
    throw new Error('The verified firmware update release is incomplete.');
  }
  if (manifest.target !== 'esp32-s3-n16r8' || ticket.target !== manifest.target
    || ticket.firmwareVersion !== manifest.firmwareVersion
    || ticket.buildId !== manifest.buildId
    || ticket.buildNumber !== manifest.buildNumber) {
    throw new Error('Firmware update identity does not match the signed factory release.');
  }
  if (ticket.preservation?.dataPartitionsIncluded !== false) {
    throw new Error('Firmware update ticket does not preserve data partitions.');
  }
  if (await sha256Hex(ticketBytes) !== ticketSha256) {
    throw new Error('Firmware update ticket SHA-256 does not match its verified descriptor.');
  }
  if (ticket.image?.size !== imageBytes.byteLength
    || !SHA256.test(String(ticket.image?.sha256 || ''))
    || await sha256Hex(imageBytes) !== ticket.image.sha256) {
    throw new Error('Firmware application SHA-256 does not match the signed update ticket.');
  }
  return Object.freeze({
    manifest,
    ticket,
    ticketBytes,
    ticketSha256,
    ticketSignature: loaded.ticketSignature,
    imageBytes,
  });
}
