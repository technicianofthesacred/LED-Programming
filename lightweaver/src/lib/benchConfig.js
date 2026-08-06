import { CARD_HARDWARE_CONTRACT } from './cardHardwareContract.js';
import { DEFAULT_CARD_CONTROLS, makeCardRuntimePackage } from './cardRuntimeContract.js';
import { prepareCardStoragePayload } from './cardStoragePayload.js';
import { fingerprintCommissioningProject } from './cardCommissioningFlow.js';
import {
  PORT_ROLE_CONTROL,
  PORT_ROLE_STRIP,
  normalizePortRoles,
} from './portRoles.js';

// A freshly flashed card is erased (lw-flash.jsx flashes with eraseAll), so it
// boots with no saved project: ProvisioningPhase::Factory, only the factory
// beacon renders, playbackReady is false, and Studio's live 'frame' messages
// are refused. That is the deadlock discovery has to break BEFORE it can light
// a single pixel.
//
// The card's entire config-validity bar is LightweaverStorage.cpp:473 —
//   if (config.outputCount == 0 || config.lookCount == 0) -> invalid
// so one output plus one look is a legal config. Installing this minimal
// "bench" config takes the card out of factory-beacon mode and flips
// playbackReady true, which unblocks the existing frame path that discovery
// then uses for everything else.
//
// The sentinel works WITH the identity system, never around it: the config
// carries a real, stable project identity (id + revision + fingerprint) so the
// card reads as a well-formed project everywhere (cardReadiness classifies it
// 'connected' with knownGoodProject true), and isBenchProjectEvidence is how
// Studio tells "mine, but bench" apart from a real owner project.
export const BENCH_PROJECT_ID = 'lightweaver-bench-discovery-v1';
export const BENCH_PROJECT_NAME = 'Lightweaver Bench Discovery';

// The card requires a revision alongside any fingerprint
// (normalizeCardProjectIdentity, cardRuntimeContract.js) and treats
// revision 0 + empty fingerprint as the canonical blank card
// (normalizeCardProjectEvidence, cardIdentity.js), so the bench sentinel starts
// at 1 to read as a genuine — not blank — project.
export const BENCH_PROJECT_REVISION = 1;

// Never rely on the firmware's silent LW_DEFAULT_MAX_MILLIAMPS = 1500 fallback:
// when it applies, FastLED quietly scales brightness down and nothing tells
// anyone. 2000 mA is a deliberately conservative bench number — enough to light
// discovery's dim probe colours on a few hundred pixels, low enough to be safe
// on whatever the card happens to be plugged into at commissioning time.
export const BENCH_MAX_MILLIAMPS = 2000;

export const BENCH_LOOK_ID = 'bench-warm';
export const BENCH_LOOK_LABEL = 'Bench Warm';
// The one look the card plays when discovery is NOT streaming frames. Dim on
// purpose: it may come up on an unknown supply the moment the card reboots.
export const BENCH_LOOK_BRIGHTNESS = 0.25;
const BENCH_PATTERN_ID = 'warm-white';
const BENCH_PATTERN_LABEL = 'Warm White';
export const BENCH_ZONE_ID = 'bench-full';
const BENCH_ZONE_LABEL = 'Bench';

// Provisioned headroom per probed port when nothing better is known. Four ports
// at this size is exactly the 1024-pixel ceiling a pre-upgrade card reports, so
// the default bench config fits the oldest firmware in the field without
// clamping anything away.
export const BENCH_DEFAULT_PORT_PIXELS = 256;

const BENCH_SNAPSHOT_VERSION = 3;

// The compiled pin menu overlaps the default control GPIOs (encoder, buttons,
// status LED), and a config that puts an LED output on one of them is rejected
// outright by CARD_HARDWARE_CAPABILITIES.assertSupported — the same collision
// the firmware's discoveryPinAvailable() enforces at runtime. The bench config
// must never repin the owner's controls to make room, so those ports are
// reported as skipped instead.
export const BENCH_RESERVED_CONTROL_PINS = Object.freeze(
  [
    DEFAULT_CARD_CONTROLS.encoder.a,
    DEFAULT_CARD_CONTROLS.encoder.b,
    DEFAULT_CARD_CONTROLS.encoder.press,
    DEFAULT_CARD_CONTROLS.encoder.alternatePress,
    DEFAULT_CARD_CONTROLS.previous,
    DEFAULT_CARD_CONTROLS.next,
    DEFAULT_CARD_CONTROLS.blackout,
    DEFAULT_CARD_CONTROLS.brightness,
    DEFAULT_CARD_CONTROLS.statusLed,
  ].filter(pin => Number.isInteger(pin) && pin >= 0),
);

export const BENCH_SKIP_ROLE_CONTROL = 'port-role-control';
export const BENCH_SKIP_RESERVED_CONTROL_PIN = 'port-reserved-for-control';
export const BENCH_SKIP_MAX_OUTPUTS = 'max-outputs';
export const BENCH_SKIP_PIXEL_BUDGET = 'pixel-budget';

// Plain-language sentence per skip reason. It lives beside the constants rather
// than in the panel so a new reason cannot ship without copy — a port that
// silently disappears from a discovery walk is exactly the failure this whole
// builder exists to avoid.
const BENCH_SKIP_REASON_TEXT = Object.freeze({
  [BENCH_SKIP_ROLE_CONTROL]: 'you set this port to a physical control, so it is never driven as an LED output',
  [BENCH_SKIP_RESERVED_CONTROL_PIN]: 'it is in use by the controls (encoder, buttons, status light)',
  [BENCH_SKIP_MAX_OUTPUTS]: `this card can drive only ${CARD_HARDWARE_CONTRACT.maxOutputs} strip outputs at once`,
  [BENCH_SKIP_PIXEL_BUDGET]: 'the earlier ports already used up every pixel this card can hold',
});

export function benchSkipReasonText(reason) {
  return BENCH_SKIP_REASON_TEXT[reason] || 'this card cannot drive an LED output here';
}

export function isBenchProjectEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  // The card's own claim wins when present (raw /api/status from new
  // firmware); the projectId string match remains for older firmware and for
  // normalized evidence objects that do not carry provisionalSetup.
  if (evidence.provisionalSetup === true) return true;
  return evidence.projectId === BENCH_PROJECT_ID;
}

// portRoles: the array from portRoles.js (normalized here, so callers may pass
// raw persisted data).
// opts.pixelsPerPort: { [pin]: count } — how much headroom to provision per
//   port, e.g. discovery's current probe ceiling.
// opts.maxPixels: the pixel ceiling the CARD reported — normalizeCardReadiness
//   reads it from the firmware's `limits.pixels`. A blank card in the field may
//   still be running firmware capped at 1024 total. Null/absent means the card
//   never said, and the Studio contract bound is used instead.
//
// -> { config, layout, skipped, totalPixels, budget } where config is the exact
//    object POSTed to /api/config (same builder + compaction the real install
//    path uses), layout is [{ pin, start, count }] in ascending-start order —
//    which is what callers need to address pixels in a frame — skipped is
//    [{ pin, reason }] for every requested port that could not be provisioned,
//    so consumers can WARN instead of silently losing a port, and totalPixels /
//    budget are what was asked for against the ceiling it was measured on, so a
//    refusal can be explained in the two numbers that caused it.
//
// config is NULL when no requested port could be provisioned. There is no
// substitute port and no empty config: see the note above `ports` below.
export function buildBenchConfig(portRoles, {
  ledType = 'WS2812B',
  colorOrder = 'GRB',
  pixelsPerPort = {},
  maxPixels,
} = {}) {
  const roles = normalizePortRoles(portRoles);
  const requestedByPin = readPixelsPerPort(pixelsPerPort);
  const budget = resolvePixelBudget(maxPixels);
  const skipped = [];

  const wanted = roles.filter(entry => (
    entry.role === PORT_ROLE_STRIP || requestedByPin.get(entry.pin) > 0
  ));
  const candidates = [];
  for (const entry of wanted) {
    // A port the owner has claimed for a knob or a button must never be driven
    // as an LED output, even if a caller names it in pixelsPerPort.
    if (entry.role === PORT_ROLE_CONTROL) {
      skipped.push({ pin: entry.pin, reason: BENCH_SKIP_ROLE_CONTROL });
      continue;
    }
    if (BENCH_RESERVED_CONTROL_PINS.includes(entry.pin)) {
      skipped.push({ pin: entry.pin, reason: BENCH_SKIP_RESERVED_CONTROL_PIN });
      continue;
    }
    candidates.push(entry);
  }

  // The ESP32-S3 has four RMT TX channels, so four is a silicon limit on how
  // many ports can be driven at once no matter how many the owner wired.
  for (const entry of candidates.slice(CARD_HARDWARE_CONTRACT.maxOutputs)) {
    skipped.push({ pin: entry.pin, reason: BENCH_SKIP_MAX_OUTPUTS });
  }
  // Deliberately NO fallback port. Provisioning a port the owner did not choose
  // is worse than provisioning none: they would stand at the ports they picked,
  // watch them stay dark while an unrelated GPIO lit up, and end the walk at
  // "0 LEDs found" with nothing explaining it. When nothing survives, the
  // builder says so — config null, plus a reason for every skipped pin — and
  // the caller tells the owner why.
  const ports = candidates.slice(0, CARD_HARDWARE_CONTRACT.maxOutputs);

  const outputs = [];
  const layout = [];
  let start = 0;
  for (const entry of ports) {
    const remaining = budget - start;
    const requested = requestedByPin.get(entry.pin)
      ?? (entry.pixelCount > 0 ? entry.pixelCount : BENCH_DEFAULT_PORT_PIXELS);
    const count = Math.min(requested, remaining);
    if (count <= 0) {
      skipped.push({ pin: entry.pin, reason: BENCH_SKIP_PIXEL_BUDGET });
      continue;
    }
    outputs.push({
      id: `bench-${entry.pin}`,
      name: `Bench GPIO ${entry.pin}`,
      pin: entry.pin,
      pixels: count,
      direction: 'forward',
    });
    layout.push({ pin: entry.pin, start, count });
    start += count;
  }

  const totalPixels = start;
  if (!outputs.length) {
    // outputCount == 0 is rejected outright by the card (LightweaverStorage.cpp:473),
    // so there is genuinely nothing installable here — never an empty config.
    return { config: null, layout: [], skipped, totalPixels: 0, budget };
  }
  const snapshot = buildBenchProjectSnapshot({ ledType, colorOrder, outputs });
  const runtimePackage = makeCardRuntimePackage({
    projectId: BENCH_PROJECT_ID,
    projectName: BENCH_PROJECT_NAME,
    projectRevision: BENCH_PROJECT_REVISION,
    projectFingerprint: fingerprintCommissioningProject(snapshot),
    mode: 'website-flash',
    // Top-level "provisional": true inside the stored config JSON marks this as
    // Find-my-strips scaffolding, not a project the owner chose. New firmware
    // reports it back as provisionalSetup on /api/status + /api/firmware-info
    // and holds an unattended boot of it dark (findings 2026-08-06 #1); old
    // firmware ignores the unknown key, so this is safe to send everywhere.
    provisional: true,
    led: {
      type: ledType,
      colorOrder,
      pixels: totalPixels,
      // Explicit, always. See BENCH_MAX_MILLIAMPS.
      maxMilliamps: BENCH_MAX_MILLIAMPS,
      outputs,
    },
    // Deliberately NO controls.encoder.patternCycleIds. There is no such field
    // on the card: the firmware cycles config.looks[] directly, and
    // compactCardStorageConfig strips patternCycleIds out of every payload
    // before it is POSTed anyway. The one bench look below IS the whole cycle,
    // and startupPatternId names it explicitly, so nothing here depends on a
    // Studio-side cycle list that never crosses the wire.
    patterns: [{ id: BENCH_PATTERN_ID, label: BENCH_PATTERN_LABEL, mode: 'preset' }],
    looks: [{
      id: BENCH_LOOK_ID,
      label: BENCH_LOOK_LABEL,
      mode: 'preset',
      preset: BENCH_PATTERN_ID,
      brightness: BENCH_LOOK_BRIGHTNESS,
    }],
    startupPatternId: BENCH_LOOK_ID,
    // One zone covering everything. The validity bar (LightweaverStorage.cpp:473)
    // does not require zones, but renderProceduralFrame() bails on
    // `runtimeConfig.zoneCount == 0` (main.cpp:1424) — so a zone-less bench
    // config would come up Ready with a completely dark strip, which reads as
    // broken hardware at exactly the moment discovery is trying to prove the
    // opposite.
    zones: [{
      id: BENCH_ZONE_ID,
      label: BENCH_ZONE_LABEL,
      patternId: BENCH_PATTERN_ID,
      brightness: BENCH_LOOK_BRIGHTNESS,
      ranges: [{ start: 0, count: totalPixels }],
    }],
    syncZones: true,
  });

  // Same preparation as every real install (cardPushClient.js), so the bench
  // config is validated against the card's storage limit before it is offered.
  const { config } = prepareCardStoragePayload(runtimePackage);
  return { config, layout, skipped, totalPixels, budget };
}

// Mirrors the shape cardCommissioningFlow's cardRestoreSnapshot() produces, so
// the fingerprint is a genuine project fingerprint rather than a made-up hex
// string — derived only from inputs that determine the bench config, so the
// same ports and counts always produce the same identity.
export function buildBenchProjectSnapshot({ ledType, colorOrder, outputs = [] } = {}) {
  return {
    version: BENCH_SNAPSHOT_VERSION,
    id: BENCH_PROJECT_ID,
    name: BENCH_PROJECT_NAME,
    layout: { strips: [], patchBoard: null, wiring: null },
    devices: {
      standaloneController: {
        led: { type: ledType, colorOrder, maxMilliamps: BENCH_MAX_MILLIAMPS },
        outputs: outputs.map(output => ({
          id: output.id,
          pin: output.pin,
          pixels: output.pixels,
        })),
      },
    },
  };
}

function readPixelsPerPort(pixelsPerPort) {
  const byPin = new Map();
  if (!pixelsPerPort || typeof pixelsPerPort !== 'object') return byPin;
  for (const [key, value] of Object.entries(pixelsPerPort)) {
    const pin = Number(key);
    const count = Number(value);
    if (!Number.isInteger(pin)) continue;
    if (!Number.isFinite(count) || count <= 0) continue;
    byPin.set(pin, Math.trunc(count));
  }
  return byPin;
}

function resolvePixelBudget(maxPixels) {
  const reported = Number(maxPixels);
  // Studio's own contract bound applies too: normalizeCardRuntimeConfig rejects
  // anything above it, so the usable budget is the intersection of what the
  // card says it can hold and what this Studio build knows how to describe.
  const contract = CARD_HARDWARE_CONTRACT.maxPixels;
  if (!Number.isFinite(reported) || reported < 1) return contract;
  return Math.max(1, Math.min(Math.trunc(reported), contract));
}
