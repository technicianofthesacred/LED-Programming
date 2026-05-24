export const SAFE_WLED_TEST_COLORS = {
  blue: [0, 80, 255],
  amber: [255, 64, 0],
  red: [255, 0, 0],
  green: [0, 180, 72],
  white: [180, 160, 120],
};

export function normalizeWledHost(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^wss?:\/\//i, '')
    .replace(/\/.*$/, '');
}

export function summarizeWledInfo(info = {}, { ip = '', source = 'probe' } = {}) {
  const host = normalizeWledHost(ip || info.ip || info.host);
  const freeheap = numberOrNull(info.freeheap);
  const psram = numberOrNull(info.psram);
  const signal = numberOrNull(info.wifi?.signal);
  const leds = numberOrNull(info.leds?.count);
  const fps = numberOrNull(info.leds?.fps);

  return {
    name: info.name || 'WLED',
    ip: host,
    source,
    ver: info.ver || null,
    release: info.release || null,
    arch: info.arch || null,
    mac: info.mac || null,
    leds,
    fps,
    signal,
    freeheap,
    psram,
    uptime: numberOrNull(info.uptime),
    healthy: Boolean(info.ver && host && (freeheap == null || freeheap > 100000)),
  };
}

export function sortWledDevices(devices = [], preferredHost = '') {
  const preferred = normalizeWledHost(preferredHost);
  return dedupeDevices(devices).sort((a, b) => scoreWledDevice(b, preferred) - scoreWledDevice(a, preferred));
}

export function pickBestWledDevice(devices = [], preferredHost = '') {
  return sortWledDevices(devices, preferredHost)[0] || null;
}

export function makeSafeWledTestState(color = 'blue') {
  const rgb = SAFE_WLED_TEST_COLORS[color] || SAFE_WLED_TEST_COLORS.blue;
  return {
    on: true,
    bri: 32,
    transition: 0,
    seg: [{ id: 0, fx: 0, col: [rgb, [0, 0, 0], [0, 0, 0]] }],
  };
}

function dedupeDevices(devices) {
  const byKey = new Map();
  for (const device of devices) {
    if (!device) continue;
    const ip = normalizeWledHost(device.ip || device.host);
    const key = ip || device.mac || device.name;
    if (!key) continue;
    const normalized = { ...device, ip };
    const existing = byKey.get(key);
    if (!existing || scoreWledDevice(normalized) > scoreWledDevice(existing)) {
      byKey.set(key, normalized);
    }
  }
  return [...byKey.values()];
}

function scoreWledDevice(device, preferredHost = '') {
  let score = 0;
  if (device.ip && preferredHost && device.ip === preferredHost) score += 1000;
  if (device.healthy !== false) score += 100;
  if (device.source === 'preferred') score += 90;
  if (device.source === 'default') score += 80;
  if (device.source === 'mdns') score += 60;
  if (device.source === 'probe') score += 40;
  if (device.source === 'ap') score += 35;
  if (device.source === 'scan') score += 20;
  if (device.ver) score += 15;
  if (device.release) score += 5;
  if (Number.isFinite(device.signal)) score += Math.max(0, Math.min(100, device.signal)) / 10;
  if (Number.isFinite(device.freeheap) && device.freeheap > 100000) score += 5;
  return score;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
