// After a USB install, Studio used to ASSERT that the card came back up as a
// factory-blank soft AP and send the owner to join `Lightweaver-XXXX` and open
// http://192.168.4.1. Flashing does not necessarily clear NVS, so a card whose
// saved Wi-Fi credentials survived boots straight onto the home LAN and retires
// its setup hotspot. The owner was then pointed at an address that can never
// answer, with no escape.
//
// Studio runs at https://led.mandalacodes.com, so it cannot probe the LAN to
// find out: fetching http://192.168.18.70 is blocked as mixed content and
// `canPushDirectlyToCard()` is false on every production page. The one channel
// that is BOTH authoritative and unaffected by mixed content is the USB serial
// port Studio just used to flash the card — the firmware narrates its own boot
// on it, and Web Serial keeps the granted port after `Transport.disconnect()`
// closes it, so it can simply be reopened at 115200.
//
// The exact lines below are the firmware's own prints (do not change one
// without changing the other):
//   firmware/.../src/main.cpp:269           "Lightweaver standalone controller booting"
//   firmware/.../src/main.cpp:275-278       "Runtime source: defaults|internal-flash|sd / ..."
//   firmware/.../src/LightweaverWeb.cpp:2332 "Lightweaver AP: <ssid> / <ip>"
//   firmware/.../src/LightweaverWeb.cpp:2343 "Captive DNS up"
//   firmware/.../src/LightweaverWeb.cpp:2396 "WiFi station association started"
//   firmware/.../src/LightweaverWeb.cpp:2511 "WiFi station associated at <ip>"
//
// `startApMode()` always runs first, so AP lines alone prove nothing. The
// discriminator is whether a station line follows: `beginStationJoin()` is only
// reached when saved credentials exist, and it prints the attempt immediately
// after the captive portal comes up.

export const POST_FLASH_SERIAL_BAUD = 115_200;
// Association over a real access point takes a few seconds and the firmware
// retries roughly every 25 s, so one full retry cycle is the honest budget.
export const POST_FLASH_OBSERVE_TIMEOUT_MS = 25_000;
// How long after the captive portal appears Studio waits for a station attempt
// line before concluding the card has no saved credentials. The firmware emits
// both inside the same `setupLightweaverWeb()` call, milliseconds apart.
export const POST_FLASH_AP_SETTLE_MS = 3_000;
// The ESP32-S3 re-enumerates its native USB after the post-flash reset, so the
// first `port.open()` can reject while the device is still coming back.
export const POST_FLASH_SERIAL_REOPEN_INTERVAL_MS = 400;
// Boot chatter is small; this only bounds a pathological device that streams.
export const POST_FLASH_SERIAL_MAX_BYTES = 64_000;

const BOOT_BANNER = /Lightweaver standalone controller booting/i;
const RUNTIME_SOURCE = /Runtime source:\s*(defaults|internal-flash|sd)\b/i;
const AP_STARTED = /Lightweaver AP:\s*(\S+)\s*\/\s*([0-9.]+)/i;
const CAPTIVE_DNS = /Captive DNS up/i;
const STATION_ATTEMPT = /WiFi station (?:association started|reassociation requested)/i;
const STATION_ASSOCIATED = /WiFi station associated at\s+([0-9.]+)/i;

// The soft AP always answers on 192.168.4.1, so that address can never be
// evidence the card reached the home network.
const SETUP_AP_ADDRESS = '192.168.4.1';

function privateIpv4(value = '') {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4) return false;
  if (!parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = parts.map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

// A station address Studio is willing to send the owner to: a real RFC1918
// LAN address that is not the card's own setup-AP gateway and not a
// place-holder the SDK reports before DHCP completes.
export function usableCardStationIp(value = '') {
  const ip = String(value || '').trim();
  if (!privateIpv4(ip)) return '';
  if (ip === SETUP_AP_ADDRESS || ip === '0.0.0.0' || ip === '127.0.0.1') return '';
  return ip;
}

export function readPostFlashSerialEvidence(output = '') {
  const text = String(output || '');
  const associated = text.match(STATION_ASSOCIATED);
  const ap = text.match(AP_STARTED);
  const runtimeSource = text.match(RUNTIME_SOURCE);
  return {
    booted: BOOT_BANNER.test(text),
    runtimeSource: runtimeSource ? runtimeSource[1].toLowerCase() : '',
    apStarted: Boolean(ap),
    apSsid: ap ? ap[1] : '',
    captiveDns: CAPTIVE_DNS.test(text),
    stationAttempt: STATION_ATTEMPT.test(text) || Boolean(associated),
    stationIp: associated ? usableCardStationIp(associated[1]) : '',
  };
}

/**
 * Classify what the card actually did after the flash from its boot log.
 *
 * - `station`      the card joined the home network; its address is known and
 *                  the setup hotspot is gone. Studio must skip the AP step.
 * - `setup-ap`     the card came up as a captive-portal hotspot with no saved
 *                  credentials to try. The existing AP flow is correct.
 * - `inconclusive` everything else, including "credentials exist but the join
 *                  has not completed yet", which is genuinely ambiguous: the
 *                  hotspot is up right now and the card may still leave it.
 *
 * `settled` reports whether the AP evidence has had long enough to be trusted
 * as "no credentials"; the reader uses it to stop early instead of burning the
 * whole budget on a genuinely blank card.
 */
export function classifyPostFlashSerialOutput(output = '', { settled = true } = {}) {
  const evidence = readPostFlashSerialEvidence(output);
  if (evidence.stationIp) {
    return { state: 'station', stationIp: evidence.stationIp, evidence };
  }
  const blankCard = evidence.apStarted || evidence.captiveDns;
  if (settled && blankCard && !evidence.stationAttempt) {
    return { state: 'setup-ap', stationIp: '', evidence };
  }
  return { state: 'inconclusive', stationIp: '', evidence };
}

function makeClock(now, sleep) {
  const timers = new Set();
  return {
    now,
    sleep: ms => sleep(ms, timers),
    cancelPending: () => {
      for (const cancel of timers) cancel();
      timers.clear();
    },
  };
}

function defaultSleep(ms, timers) {
  return new Promise(resolve => {
    const id = setTimeout(() => { timers.delete(cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(id); resolve(); };
    timers.add(cancel);
  });
}

async function openSerialPort(port, { clock, deadline, baudRate }) {
  while (clock.now() < deadline) {
    try {
      await port.open({ baudRate });
      return true;
    } catch (error) {
      // A port already opened by something else in this page is usable as-is.
      if (error?.name === 'InvalidStateError') return true;
      if (clock.now() >= deadline) return false;
      await clock.sleep(POST_FLASH_SERIAL_REOPEN_INTERVAL_MS);
    }
  }
  return false;
}

/**
 * Reopen the just-flashed Web Serial port and watch the card's boot log.
 *
 * Never throws and never leaves the port open: any failure — no port, a device
 * that never re-enumerates, an unreadable stream — degrades to `inconclusive`
 * so Studio shows both recovery paths instead of asserting one.
 */
export async function observePostFlashNetwork({
  port,
  timeoutMs = POST_FLASH_OBSERVE_TIMEOUT_MS,
  settleMs = POST_FLASH_AP_SETTLE_MS,
  baudRate = POST_FLASH_SERIAL_BAUD,
  maxBytes = POST_FLASH_SERIAL_MAX_BYTES,
  now = () => Date.now(),
  sleep = defaultSleep,
  decode = bytes => new TextDecoder().decode(bytes, { stream: true }),
} = {}) {
  const unreadable = reason => ({ state: 'inconclusive', stationIp: '', reason });
  if (!port || typeof port.open !== 'function') return unreadable('no-serial-port');
  const clock = makeClock(now, sleep);
  const deadline = now() + Math.max(0, Number(timeoutMs) || 0);
  let opened = false;
  try {
    opened = await openSerialPort(port, { clock, deadline, baudRate });
  } catch { opened = false; }
  if (!opened) {
    clock.cancelPending();
    return unreadable('serial-unavailable');
  }

  let text = '';
  let apFirstSeenAt = 0;
  let reader = null;
  try {
    reader = port.readable?.getReader?.();
    if (!reader) throw new Error('serial-unreadable');
    while (clock.now() < deadline) {
      const remaining = deadline - clock.now();
      const chunk = await Promise.race([
        reader.read(),
        clock.sleep(remaining).then(() => ({ expired: true })),
      ]);
      if (!chunk || chunk.expired || chunk.done) break;
      if (chunk.value) text += decode(chunk.value);
      if (text.length > maxBytes) text = text.slice(-maxBytes);

      const evidence = readPostFlashSerialEvidence(text);
      // The card told us its LAN address. Nothing later can contradict that,
      // so stop immediately rather than holding the port for the full budget.
      if (evidence.stationIp) {
        return { state: 'station', stationIp: evidence.stationIp, reason: 'station-associated' };
      }
      if (!apFirstSeenAt && (evidence.apStarted || evidence.captiveDns)) apFirstSeenAt = clock.now();
      // A genuinely blank card never prints a station attempt. Once the
      // captive portal has been up past the settle window with no attempt,
      // the AP is the whole story — release USB and let setup continue.
      if (apFirstSeenAt && !evidence.stationAttempt && clock.now() - apFirstSeenAt >= settleMs) {
        return { state: 'setup-ap', stationIp: '', reason: 'setup-ap-only' };
      }
    }
  } catch {
    // fall through and classify whatever was captured
  } finally {
    clock.cancelPending();
    try { await reader?.cancel(); } catch { /* stream already gone */ }
    try { reader?.releaseLock?.(); } catch { /* stream already gone */ }
    try { await port.close(); } catch { /* device already detached */ }
  }

  const classified = classifyPostFlashSerialOutput(text, { settled: true });
  return {
    state: classified.state,
    stationIp: classified.stationIp,
    reason: text ? 'observation-window-elapsed' : 'no-serial-output',
  };
}
