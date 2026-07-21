const FACTS = Object.freeze({
  'charge-only-cable': {
    supportCode: 'LW-USB-101', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'The computer did not find a data connection to the card. The cable may provide power only.',
    action: { id: 'retry-usb', label: 'Reconnect with a data cable' },
  },
  'port-busy': {
    supportCode: 'LW-USB-102', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'Another browser tab or serial program is using the USB card.',
    action: { id: 'retry-usb', label: 'Close other serial apps, then retry' },
  },
  'linux-permissions': {
    supportCode: 'LW-USB-103', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'Linux did not allow this browser to open the USB serial device.',
    action: { id: 'retry-usb', label: 'Fix USB permission, then retry' },
  },
  'missing-driver': {
    supportCode: 'LW-USB-104', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'The computer does not have the USB serial driver needed for this card.',
    action: { id: 'retry-usb', label: 'Install the card driver, then retry' },
  },
  'multiple-cards': {
    supportCode: 'LW-USB-105', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'Studio could not identify one unambiguous USB card.',
    action: { id: 'retry-usb', label: 'Leave one card connected, then retry' },
  },
  'unsupported-card': {
    supportCode: 'LW-USB-106', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'The connected USB device is not a supported Lightweaver ESP32-S3 card.',
    action: { id: 'retry-usb', label: 'Connect a supported card' },
  },
  'disconnect-phase': {
    supportCode: 'LW-USB-107', cardChanged: 'unknown', usbReleased: 'unknown',
    whatHappened: 'The USB connection ended before Studio could confirm the current phase.',
    action: { id: 'release-usb', label: 'Release USB safely' },
  },
  'usb-ownership-uncertain': {
    supportCode: 'LW-USB-108', cardChanged: 'unknown', usbReleased: 'unknown',
    whatHappened: 'Studio cannot prove whether this tab still owns the USB port.',
    action: { id: 'release-usb', label: 'Release USB safely' },
  },
  'wrong-card-reconnect': {
    supportCode: 'LW-CARD-201', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'The reconnected card is not the card bound to this production run.',
    action: { id: 'reconnect-expected-card', label: 'Reconnect the expected card' },
  },
  'card-page-unavailable': {
    supportCode: 'LW-CARD-202', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'Studio could not read the local card page, so it stopped before making a firmware decision.',
    action: { id: 'reconnect-expected-card', label: 'Reconnect the expected card page' },
  },
  'restore-failure': {
    supportCode: 'LW-LOAD-301', cardChanged: 'unknown', usbReleased: 'yes',
    whatHappened: 'The artwork load response was interrupted, so Studio does not assume whether the card accepted it.',
    action: { id: 'verify-restore', label: 'Verify card read-back' },
  },
  'restore-readback-mismatch': {
    supportCode: 'LW-LOAD-302', cardChanged: 'unknown', usbReleased: 'yes',
    whatHappened: 'Independent card read-back did not match the verified artwork job. Studio did not load the artwork a second time.',
    action: { id: 'retry-restore', label: 'Retry verified artwork load' },
  },
  'physical-failure': {
    supportCode: 'LW-LIGHT-401', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'The physical light observation did not match the verified artwork wiring.',
    action: { id: 'rerun-physical', label: 'Run the safe light check again' },
  },
  'signed-release-failure': {
    supportCode: 'LW-FW-501', cardChanged: 'no', usbReleased: 'yes',
    whatHappened: 'Studio could not verify and preload the official signed firmware release.',
    action: { id: 'retry-signed-release', label: 'Retry verified firmware' },
  },
  unknown: {
    supportCode: 'LW-UNKNOWN-900', cardChanged: 'unknown', usbReleased: 'unknown',
    whatHappened: 'Studio stopped because it could not prove the card and USB state.',
    action: { id: 'release-usb', label: 'Release USB safely' },
  },
});

const FIRMWARE_MISMATCH = Object.freeze({
  supportCode: 'LW-FW-502', cardChanged: 'no', usbReleased: 'yes',
  whatHappened: 'The exact inspected card reports a different firmware version or build from the verified target.',
  action: { id: 'reinspect-firmware-mismatch', label: 'Reconnect same card by USB' },
});

const PHYSICAL_FAILURES = Object.freeze({
  'nothing-lit': { supportCode: 'LW-LIGHT-411', whatHappened: 'The active boundary did not light during its bounded physical test.', action: { id: 'retry-physical-stream', label: 'Check power and data, then retry' } },
  'wrong-color': { supportCode: 'LW-LIGHT-412', whatHappened: 'The active boundary lit with the wrong marker colors.', action: { id: 'open-physical-correction', label: 'Test color order safely' } },
  'wrong-start-end': { supportCode: 'LW-LIGHT-413', whatHappened: 'The blue start and red end markers appeared in the opposite physical direction.', action: { id: 'open-physical-correction', label: 'Test the opposite direction' } },
  'wrong-count': { supportCode: 'LW-LIGHT-414', whatHappened: 'The red end marker did not land on the expected final pixel.', action: { id: 'open-physical-correction', label: 'Adjust pixel count safely' } },
  'wrong-output': { supportCode: 'LW-LIGHT-415', whatHappened: 'A different physical output lit during the active boundary test.', action: { id: 'open-physical-correction', label: 'Test the correct GPIO safely' } },
  'flashing-or-frozen': { supportCode: 'LW-LIGHT-416', whatHappened: 'The bounded physical test flashed, froze, or did not release cleanly.', action: { id: 'retry-physical-stream', label: 'Release and restart the light test' } },
});

function state(value, fallback) {
  return ['yes', 'no', 'unknown'].includes(value) ? value : fallback;
}

function exactFirmwareMismatch(evidence) {
  return evidence?.exactCard === true
    && typeof evidence.installedVersion === 'string'
    && typeof evidence.installedBuildId === 'string'
    && typeof evidence.targetVersion === 'string'
    && typeof evidence.targetBuildId === 'string'
    && (evidence.installedVersion !== evidence.targetVersion || evidence.installedBuildId !== evidence.targetBuildId);
}

export function classifyProductionFailure(kind, context = {}) {
  const normalizedKind = String(kind || 'unknown');
  const provenFirmwareMismatch = normalizedKind === 'firmware-mismatch' && exactFirmwareMismatch(context.firmwareEvidence);
  const resolvedKind = provenFirmwareMismatch ? 'firmware-mismatch'
    : normalizedKind === 'firmware-mismatch' ? 'usb-ownership-uncertain'
      : FACTS[normalizedKind] ? normalizedKind : 'unknown';
  const base = provenFirmwareMismatch ? FIRMWARE_MISMATCH : FACTS[resolvedKind];
  const usbUncertain = state(context.usbReleased, base.usbReleased) === 'unknown';
  return Object.freeze({
    kind: resolvedKind,
    supportCode: base.supportCode,
    whatHappened: base.whatHappened,
    cardChanged: state(context.cardChanged, base.cardChanged),
    usbReleased: state(context.usbReleased, base.usbReleased),
    action: Object.freeze(usbUncertain ? { id: 'release-usb', label: 'Release USB safely' } : { ...base.action }),
  });
}

export function classifyProductionPhysicalFailure(observation) {
  const base = PHYSICAL_FAILURES[observation];
  if (!base) return classifyProductionFailure('physical-failure');
  return Object.freeze({
    kind: 'physical-failure', supportCode: base.supportCode, whatHappened: base.whatHappened,
    cardChanged: 'no', usbReleased: 'yes', action: Object.freeze({ ...base.action }),
  });
}

export function inferProductionFailure(reason, context = {}) {
  const message = String(reason?.message || reason || '').toLowerCase();
  const name = String(reason?.name || '').toLowerCase();
  let kind = context.kind;
  if (!kind && /wrong (?:usb |online )?card|this card is|different card/.test(message)) kind = 'wrong-card-reconnect';
  if (!kind && context.phase === 'physical') kind = 'physical-failure';
  if (!kind && context.phase === 'restore') kind = 'restore-failure';
  if (!kind && context.phase === 'signed-release') kind = 'signed-release-failure';
  // Reconnect is a transport phase, not identity evidence. An AP/LAN timeout
  // means the expected card page is unavailable; call it the wrong card only
  // when the response itself explicitly proves a different identity above.
  if (!kind && context.phase === 'reconnect') kind = 'card-page-unavailable';
  if (!kind && /not supported|unsupported|wrong chip|flash size|needs 16 mb|not an esp32-s3|nothing was erased/.test(message)) kind = 'unsupported-card';
  if (!kind && /driver/.test(message)) kind = 'missing-driver';
  if (!kind && context.os === 'linux' && /permission|denied|dialout|udev/.test(message)) kind = 'linux-permissions';
  if (!kind && /busy|already open|access denied|in use|networkerror/.test(`${message} ${name}`)) kind = 'port-busy';
  if (!kind && /more than one|multiple|one card|no port selected|notfounderror/.test(`${message} ${name}`)) kind = 'multiple-cards';
  if (!kind && /disconnect|closed|lost/.test(message)) kind = 'disconnect-phase';
  if (!kind && /no device|not found|timeout|timed out|data cable/.test(message)) kind = 'charge-only-cable';
  return classifyProductionFailure(kind || 'usb-ownership-uncertain', context);
}

const VALID_OS = new Set(['windows', 'macos', 'linux', 'chromeos', 'unknown']);
const VALID_ARCH = new Set(['x86', 'x86_64', 'arm', 'arm64', 'unknown']);
const VALID_PHASE = new Set(['select-job', 'connect-card', 'inspect', 'install', 'reconnect', 'restore', 'verify-card', 'check-lights', 'record', 'complete', 'recovery', 'physical', 'signed-release', 'unknown']);

function safeToken(value, pattern, maximum, fallback = 'unknown') {
  const text = String(value || '');
  return text.length <= maximum && pattern.test(text) ? text : fallback;
}

function usbId(value) {
  if (Number.isInteger(value) && value >= 0 && value <= 0xffff) return `0x${value.toString(16).padStart(4, '0')}`;
  if (typeof value === 'string' && /^0x[0-9a-f]{4}$/i.test(value)) return value.toLowerCase();
  return 'unknown';
}

export function buildProductionDiagnostic(input = {}) {
  const diagnostic = {
    app: 'Lightweaver',
    version: safeToken(input.version, /^[A-Za-z0-9][A-Za-z0-9.+-]*$/, 40),
    os: VALID_OS.has(input.os) ? input.os : 'unknown',
    arch: VALID_ARCH.has(input.arch) ? input.arch : 'unknown',
    supportCode: safeToken(input.supportCode, /^LW-[A-Z]+-[0-9]{3}$/, 32, 'LW-UNKNOWN-900'),
    phase: VALID_PHASE.has(input.phase) ? input.phase : 'unknown',
    firmwareTarget: safeToken(input.firmwareTarget, /^[A-Za-z0-9][A-Za-z0-9.+@_-]*$/, 96),
    vid: usbId(input.vid),
    pid: usbId(input.pid),
  };
  if (new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength > 1024) throw new Error('Production diagnostic exceeds its safe export limit');
  return Object.freeze(diagnostic);
}
