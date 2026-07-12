// Test strip mode — a bench/session-only override so the user can preview
// and push the current design to a single short physical strip (e.g. 30 LEDs
// on the bench) instead of the full saved design (e.g. 94 LEDs across several
// outputs). This is deliberately NOT part of the project: it never touches
// strips/patchBoard/zones/playlist, and it is never written into a saved or
// exported project file. It lives in localStorage only, following the same
// idiom as the card host store in cardConnection.js.

export const TEST_STRIP_STORAGE_KEY = 'lw:test-strip';
export const TEST_STRIP_CHANGED_EVENT = 'lightweaver-test-strip-changed';
export const DEFAULT_TEST_STRIP = Object.freeze({ enabled: false, length: 30 });
// The id/label the collapsed single zone always uses — callers that need to
// target it directly (e.g. to wait for it to show up on the card) can import
// this instead of re-deriving it from a transformed package.
export const TEST_STRIP_ZONE_ID = 'full-piece';

function sanitizeLength(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : DEFAULT_TEST_STRIP.length;
}

export function readTestStrip() {
  if (typeof window === 'undefined') return { ...DEFAULT_TEST_STRIP };
  try {
    const raw = JSON.parse(window.localStorage.getItem(TEST_STRIP_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_TEST_STRIP };
    return {
      enabled: Boolean(raw.enabled),
      length: sanitizeLength(raw.length),
    };
  } catch {
    return { ...DEFAULT_TEST_STRIP };
  }
}

export function writeTestStrip(next = {}) {
  const value = {
    enabled: Boolean(next.enabled),
    length: sanitizeLength(next.length),
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(TEST_STRIP_STORAGE_KEY, JSON.stringify(value));
      window.dispatchEvent?.(new CustomEvent(TEST_STRIP_CHANGED_EVENT, { detail: value }));
    } catch {
      /* quota */
    }
  }
  return value;
}

// Simple subscribe helper (cardConnection.js has no subscribe of its own —
// consumers there just listen for its CHANGED_EVENT directly — so this
// mirrors that instead of inventing a heavier store).
export function subscribeTestStrip(callback) {
  if (typeof window === 'undefined') return () => {};
  const handler = () => callback();
  window.addEventListener(TEST_STRIP_CHANGED_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(TEST_STRIP_CHANGED_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

function firstFiniteOutputPin(outputs = [], fallbackPin = 16) {
  const found = Array.isArray(outputs)
    ? outputs.find(output => Number.isFinite(Number(output?.pin)))
    : null;
  return Number.isFinite(Number(found?.pin)) ? Number(found.pin) : fallbackPin;
}

// Collapse a full runtime package (whatever the real design is — several
// outputs, several zones, a playlist of looks) down to what a single N-pixel
// bench strip can accept: one output, one full-piece zone, and looks that
// each still play their real pattern/preset but all point at that one zone.
// Returns a NEW package; `runtimePackage` (and everything inside it) is left
// untouched so the saved/exported project is never affected by bench testing.
export function applyTestStripToRuntimePackage(runtimePackage = {}, length = DEFAULT_TEST_STRIP.length) {
  const pixels = Math.max(1, Math.floor(Number(length) || DEFAULT_TEST_STRIP.length));
  const sourcePackage = runtimePackage?.config ? runtimePackage : { config: runtimePackage };
  const sourceConfig = sourcePackage.config || {};
  const pin = firstFiniteOutputPin(sourceConfig.led?.outputs);

  const sourceZones = Array.isArray(sourceConfig.zones) ? sourceConfig.zones : [];
  const firstZone = sourceZones[0] || {};
  const testZone = {
    id: TEST_STRIP_ZONE_ID,
    label: 'Full piece',
    patternId: firstZone.patternId,
    brightness: firstZone.brightness,
    speed: firstZone.speed,
    hueShift: firstZone.hueShift,
    customHue: firstZone.customHue,
    customSaturation: firstZone.customSaturation,
    customBreathe: firstZone.customBreathe,
    customDrift: firstZone.customDrift,
    ranges: [{ start: 0, count: pixels }],
  };

  const sourceLooks = Array.isArray(sourceConfig.looks) ? sourceConfig.looks : [];
  const looks = sourceLooks.map(look => {
    if (!Array.isArray(look.zones) || !look.zones.length) return { ...look };
    // Combo looks normally light several zones at once; on a single bench
    // strip there is only one zone to target, so keep the combo's primary
    // (first) zone settings and point them at the collapsed full-piece zone.
    const primary = look.zones[0] || {};
    return {
      ...look,
      zones: [{
        id: TEST_STRIP_ZONE_ID,
        label: 'Full piece',
        patternId: primary.patternId,
        brightness: primary.brightness,
        speed: primary.speed,
        hueShift: primary.hueShift,
        customHue: primary.customHue,
        customSaturation: primary.customSaturation,
        customBreathe: primary.customBreathe,
        customDrift: primary.customDrift,
      }],
    };
  });

  return {
    ...sourcePackage,
    config: {
      ...sourceConfig,
      led: {
        ...(sourceConfig.led || {}),
        pixels,
        outputs: [{ id: 'test-strip', name: 'Test strip', pin, pixels }],
      },
      zones: [testZone],
      looks,
      syncZones: true,
    },
  };
}
