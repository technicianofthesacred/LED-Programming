export const PRESERVING_BOOTSTRAP_RANGE = Object.freeze({ start: 0x10000, end: 0x650000 });
export const LIGHTWEAVER_PARTITION_TABLE_RANGE = Object.freeze({ start: 0x8000, end: 0x9000 });

const BUILD_ID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function text(value, max = 128) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

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

function fail(message) {
  throw new Error(`${message} Nothing was written; preserving update stopped before writing.`);
}

export async function inspectPreservingBootstrapEvidence(loader, installedEvidence = {}) {
  if (typeof loader?.readFlash !== 'function') fail('The connected card cannot provide partition-layout evidence.');
  const size = LIGHTWEAVER_PARTITION_TABLE_RANGE.end - LIGHTWEAVER_PARTITION_TABLE_RANGE.start;
  let table;
  try { table = bytes(await loader.readFlash(LIGHTWEAVER_PARTITION_TABLE_RANGE.start, size)); }
  catch { fail('Studio could not read the card partition table.'); }
  if (!table || table.byteLength !== size) fail('The card returned an incomplete partition table.');
  const disposableTable = table.slice();
  const partitionTableSha256 = await sha256Hex(disposableTable);
  disposableTable.fill(0);
  return Object.freeze({ ...installedEvidence, partitionTableSha256 });
}

export function planPreservingBootstrap(evidence = {}, release = {}) {
  const ticket = release?.ticket;
  const image = bytes(release?.imageBytes);
  const partition = ticket?.partition;
  const compatibility = ticket?.compatibility;
  const preservation = ticket?.preservation;
  if (!/^lw-[A-Za-z0-9][A-Za-z0-9._:-]{0,60}$/.test(text(evidence.cardId, 64))
    || text(evidence.chipName, 24).toUpperCase() !== 'ESP32-S3'
    || Number(evidence.flashBytes) !== 16 * 1024 * 1024) {
    fail('Studio could not prove the exact ESP32-S3 16 MB card.');
  }
  if (evidence.source !== 'usb-flash' || !text(evidence.firmwareVersion, 48)
    || !BUILD_ID.test(text(evidence.buildId, 40).toLowerCase())
    || !Number.isSafeInteger(evidence.buildNumber) || evidence.buildNumber < 1) {
    fail('Installed firmware identity was not read directly from this card.');
  }
  if (!ticket || ticket.target !== 'esp32-s3-n16r8'
    || !image || image.byteLength < 1 || image[0] !== 0xe9
    || ticket.image?.size !== image.byteLength
    || !SHA256.test(text(ticket.image?.sha256, 64).toLowerCase())) {
    fail('The signed application update is incomplete or targets another card.');
  }
  if (partition?.layout !== 'default_16MB.csv'
    || partition.app0Offset !== PRESERVING_BOOTSTRAP_RANGE.start
    || partition.app1Offset !== PRESERVING_BOOTSTRAP_RANGE.end
    || partition.slotSize !== PRESERVING_BOOTSTRAP_RANGE.end - PRESERVING_BOOTSTRAP_RANGE.start
    || !SHA256.test(text(partition.tableSha256, 64).toLowerCase())
    || text(evidence.partitionTableSha256, 64).toLowerCase() !== partition.tableSha256) {
    fail('The installed partition layout is not the signed preserving layout.');
  }
  if (evidence.installedAppOffset !== PRESERVING_BOOTSTRAP_RANGE.start) {
    fail('The installed application is not the supported app0 bootstrap source.');
  }
  if (!Number.isSafeInteger(compatibility?.minimumBootstrapBuild)
    || evidence.buildNumber < compatibility.minimumBootstrapBuild) {
    fail('This firmware build is not eligible for preserving USB bootstrap.');
  }
  if (preservation?.dataPartitionsIncluded !== false) {
    throw new Error('The signed update must declare that data partitions are not included. Nothing was written.');
  }
  const end = PRESERVING_BOOTSTRAP_RANGE.start + image.byteLength;
  if (end > PRESERVING_BOOTSTRAP_RANGE.end) fail('The signed application does not fit entirely inside app0.');
  return Object.freeze({
    address: PRESERVING_BOOTSTRAP_RANGE.start,
    eraseAll: false,
    bytes: image,
    expectedSha256: ticket.image.sha256,
    range: Object.freeze({ start: PRESERVING_BOOTSTRAP_RANGE.start, end }),
    cardId: evidence.cardId,
    target: Object.freeze({
      firmwareVersion: ticket.firmwareVersion,
      buildId: ticket.buildId,
      buildNumber: ticket.buildNumber,
    }),
  });
}

function interrupted(cause) {
  const error = new Error(`Preserving update stopped: ${cause?.message || String(cause)}. Wi-Fi, projects, patterns, wiring, and settings data remains in its separate partitions. Reconnect this same card and repeat the preserving USB update.`);
  error.cause = cause;
  error.recovery = 'repeat-preserving-usb-bootstrap';
  return error;
}

export async function runPreservingUsbBootstrap({
  loader,
  transport,
  evidence,
  release,
  writeApplication,
  resetIntoApp,
  disconnect,
  onProgress,
} = {}) {
  let writeStarted = false;
  try {
    const inspected = await inspectPreservingBootstrapEvidence(loader, evidence);
    const plan = planPreservingBootstrap(inspected, release);
    const actualImageSha = await sha256Hex(plan.bytes);
    if (actualImageSha !== plan.expectedSha256) fail('The application bytes do not match the signed SHA-256.');
    if (typeof writeApplication !== 'function') fail('The preserving writer is unavailable.');
    writeStarted = true;
    await writeApplication(loader, plan.bytes, plan.address, false, value => onProgress?.({ phase: 'updating', progress: value }));
    const readback = bytes(await loader.readFlash(plan.address, plan.bytes.byteLength));
    if (!readback || readback.byteLength !== plan.bytes.byteLength
      || await sha256Hex(readback) !== plan.expectedSha256) {
      throw new Error('Application readback SHA-256 did not match.');
    }
    await resetIntoApp?.(transport, loader);
    return Object.freeze({ ok: true, cardId: plan.cardId, target: plan.target, range: plan.range });
  } catch (error) {
    if (writeStarted) throw interrupted(error);
    throw error;
  } finally {
    try { await disconnect?.(loader, transport); } catch { /* USB is already released */ }
  }
}
