import { makeSafeWledTestState } from './wledDiscovery.js';

export const DEFAULT_CONTROLLER_LED = {
  type: 'WS2815',
  length: 30,
  dataPin: 16,
  colorOrder: 'GRB',
  maxBrightness: 180,
};

export const DEFAULT_CONTROLLER_POWER = {
  voltage: 12,
  psuAmps: 5,
  milliampsPerPixel: 12,
  injectionPoints: '',
  levelShifter: false,
  commonGround: true,
};

export const DEFAULT_CONTROLLER_ARTNET = {
  enabled: false,
  startUniverse: 0,
  startChannel: 0,
  channelsPerUniverse: 510,
  fps: 40,
  targetMode: 'unicast',
};

export function buildControllerProfile(info = {}, overrides = {}) {
  const mac = normalizeMac(info.mac || overrides.mac || '');
  const id = overrides.id || mac.replace(/:/g, '') || info.deviceId || normalizeHost(info.ip) || `controller-${Date.now()}`;
  const led = { ...DEFAULT_CONTROLLER_LED, length: info.leds?.count || DEFAULT_CONTROLLER_LED.length, ...(overrides.led || {}) };
  const profile = {
    id,
    name: overrides.name || info.name || 'WLED Controller',
    role: overrides.role || 'primary',
    ip: normalizeHost(overrides.ip || info.ip || ''),
    hostname: overrides.hostname || '',
    mac: mac.replace(/:/g, ''),
    version: overrides.version || info.ver || '',
    release: overrides.release || info.release || '',
    arch: overrides.arch || info.arch || '',
    flashMb: Number(info.flash || overrides.flashMb || 0) || null,
    psramBytes: Number(info.psram || overrides.psramBytes || 0) || null,
    lastVerifiedAt: overrides.lastVerifiedAt || new Date().toISOString(),
    led,
    power: { ...DEFAULT_CONTROLLER_POWER, ...(overrides.power || {}) },
    artnet: { ...DEFAULT_CONTROLLER_ARTNET, ...(overrides.artnet || {}) },
    wiring: {
      dataGpio: overrides.wiring?.dataGpio ?? led.dataPin,
      notes: overrides.wiring?.notes || '',
    },
    calibration: {
      colorOrderConfirmed: false,
      pixelCountConfirmed: false,
      direction: 'forward',
      lastTest: '',
      ...(overrides.calibration || {}),
    },
    backup: {
      lastSnapshotAt: '',
      snapshot: null,
      ...(overrides.backup || {}),
    },
  };
  return { ...profile, hostname: profile.hostname || makeWledHostname(profile) };
}

export function mergeControllerProfile(existing = {}, info = {}, overrides = {}) {
  return buildControllerProfile(info, {
    ...existing,
    ...overrides,
    led: { ...(existing.led || {}), ...(overrides.led || {}) },
    power: { ...(existing.power || {}), ...(overrides.power || {}) },
    artnet: { ...(existing.artnet || {}), ...(overrides.artnet || {}) },
    wiring: { ...(existing.wiring || {}), ...(overrides.wiring || {}) },
    calibration: { ...(existing.calibration || {}), ...(overrides.calibration || {}) },
    backup: { ...(existing.backup || {}), ...(overrides.backup || {}) },
  });
}

export function makeWledHostname(profile = {}) {
  const suffix = String(profile.mac || profile.id || '').replace(/[^a-fA-F0-9]/g, '').slice(-6).toLowerCase();
  return suffix ? `lightweaver-${suffix}.local` : 'lightweaver-wled.local';
}

export function makeDhcpReservationNote(profile = {}) {
  const mac = formatMac(profile.mac);
  const ip = normalizeHost(profile.ip);
  if (!mac || !ip) return 'Record this controller MAC and assign a DHCP reservation once its IP is known.';
  return `Reserve MAC ${mac} as ${ip}.`;
}

export function estimatePowerBudget(profile = {}) {
  const length = Number(profile.led?.length || 0);
  const maxBrightness = clamp(Number(profile.led?.maxBrightness || 255), 1, 255);
  const milliampsPerPixel = Number(profile.power?.milliampsPerPixel || DEFAULT_CONTROLLER_POWER.milliampsPerPixel);
  const psuAmps = Number(profile.power?.psuAmps || 0);
  const maxAmps = round2((length * milliampsPerPixel * (maxBrightness / 255)) / 1000);
  const safeAmps = round2(psuAmps * 0.8);
  const headroomAmps = round2(safeAmps - maxAmps);
  return {
    maxAmps,
    safeAmps,
    headroomAmps,
    status: headroomAmps >= 0 ? 'ok' : 'over',
  };
}

export function controllerProfileReadiness(profile = {}) {
  const power = estimatePowerBudget(profile);
  const checks = [
    check('Controller IP saved', Boolean(profile.ip)),
    check('MAC recorded', Boolean(profile.mac)),
    check('Firmware verified', Boolean(profile.version && profile.release)),
    check('LED count set', Number(profile.led?.length) > 0),
    check('Data GPIO set', Number(profile.led?.dataPin) >= 0),
    check('Color order confirmed', Boolean(profile.calibration?.colorOrderConfirmed)),
    check('Pixel count/direction confirmed', Boolean(profile.calibration?.pixelCountConfirmed)),
    check('Power budget safe', power.status === 'ok'),
    check('Common ground noted', profile.power?.commonGround !== false),
    check('Config snapshot saved', Boolean(profile.backup?.lastSnapshotAt)),
  ];
  return { ready: checks.every(item => item.ok), checks, power };
}

export function makeKnownGoodRecoveryState() {
  return makeSafeWledTestState('amber');
}

export function makePixelMarkerState(pixelCount = 30, index = 0, color = [255, 64, 0]) {
  const count = Math.max(1, Math.min(4096, Number(pixelCount) || 1));
  const selected = Math.max(0, Math.min(count - 1, Number(index) || 0));
  const flat = [];
  for (let i = 0; i < count; i++) {
    flat.push(...(i === selected ? color : [0, 0, 0]));
  }
  return { on: true, bri: 32, transition: 0, v: true, seg: [{ id: 0, i: flat }] };
}

export function makeEveryNthMarkerState(pixelCount = 30, every = 10) {
  const count = Math.max(1, Math.min(4096, Number(pixelCount) || 1));
  const step = Math.max(1, Number(every) || 10);
  const flat = [];
  for (let i = 0; i < count; i++) {
    flat.push(...(i % step === 0 ? [0, 80, 255] : [0, 0, 0]));
  }
  return { on: true, bri: 32, transition: 0, v: true, seg: [{ id: 0, i: flat }] };
}

export function makeColorOrderHint(expected, observed) {
  const exp = String(expected || '').toLowerCase();
  const obs = String(observed || '').toLowerCase();
  if (!exp || !obs || exp === obs) return 'Color order appears consistent.';
  return `Expected ${expected} but saw ${observed}. In WLED LED Preferences, adjust Color order before saving presets.`;
}

export function makeArtNetNotes(profile = {}) {
  const length = Number(profile.led?.length || 0);
  const channels = length * 3;
  const universes = Math.max(1, Math.ceil(channels / (profile.artnet?.channelsPerUniverse || 510)));
  return [
    `Target IP: ${profile.ip || '<controller-ip>'}`,
    `Mode: ${profile.artnet?.targetMode || 'unicast'}`,
    `Universe start: ${profile.artnet?.startUniverse ?? 0}`,
    `Start channel: ${profile.artnet?.startChannel ?? 0}`,
    `Channels: ${channels}`,
    `Universes needed: ${universes}`,
    `FPS target: ${profile.artnet?.fps || 40}`,
  ].join('\n');
}

export function makeInstallReadinessReport(profile = {}, { snapshotSaved = false } = {}) {
  const readiness = controllerProfileReadiness({
    ...profile,
    backup: {
      ...(profile.backup || {}),
      lastSnapshotAt: snapshotSaved ? (profile.backup?.lastSnapshotAt || new Date().toISOString()) : profile.backup?.lastSnapshotAt,
    },
  });
  const power = readiness.power;
  return [
    '# Lightweaver Install Readiness',
    '',
    `Controller: ${profile.name || 'WLED Controller'}`,
    `Role: ${profile.role || 'primary'}`,
    `IP: ${profile.ip || 'unassigned'}`,
    `Hostname: ${profile.hostname || makeWledHostname(profile)}`,
    `MAC: ${profile.mac || 'unknown'}`,
    `Firmware: ${profile.version || 'unknown'} ${profile.release || ''}`.trim(),
    `LED: ${profile.led?.type || 'unknown'}, ${profile.led?.length || 0} px, GPIO ${profile.led?.dataPin ?? 'unknown'}, ${profile.led?.colorOrder || 'unknown'}`,
    `Power: ${power.maxAmps}A estimated, ${power.safeAmps}A safe budget, ${power.status}`,
    '',
    '## Readiness',
    ...readiness.checks.map(item => `- [${item.ok ? 'x' : ' '}] ${item.label}`),
    '',
    '## DHCP',
    makeDhcpReservationNote(profile),
    '',
    '## Art-Net / Madrix',
    makeArtNetNotes(profile),
  ].join('\n');
}

export function makeSnapshotFilename(profile = {}) {
  const id = String(profile.mac || profile.id || 'controller').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `wled-${id || 'controller'}-snapshot.json`;
}

function check(label, ok) {
  return { label, ok: Boolean(ok) };
}

function normalizeHost(raw) {
  return String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

function normalizeMac(raw) {
  return String(raw || '').trim().replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

function formatMac(raw) {
  const clean = normalizeMac(raw);
  if (clean.length !== 12) return '';
  return clean.match(/.{2}/g).join(':');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
