import assert from 'node:assert/strict';
import { DEMO_STRIPS } from '../src/data.js';
import { PATTERNS } from '../src/lib/patterns-library.js';
import { compile, evalPixel } from '../src/lib/patterns.js';
import { createDefaultProject, migrateProject, PROJECT_VERSION, resolveStartupProject } from '../src/lib/projectModel.js';
import { compilePattern, normalizePalette, renderPixelFrame } from '../src/lib/frameEngine.js';
import {
  easeCrossfade,
  formatMotionSpeed,
  smoothPixelFrame,
} from '../src/lib/motionSmoothing.js';
import { applySymmetry } from '../src/lib/symmetry.js';
import { clampClipMove, clampClipResize, placeClipInTrackGap } from '../src/lib/timelineLayout.js';
import { recordLivePattern } from '../src/lib/liveRecorder.js';
import {
  makeBlackoutFrame,
  makeWledFrameMessage,
  makeWledSegments,
  makeWledProxyUrl,
  makeWledWsUrl,
  requestWledJson,
} from '../src/lib/deviceController.js';
import {
  DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS,
  DEFAULT_WLED_APP_FLASH_ADDRESS,
  validateFlashPlan,
} from '../src/lib/flashPlan.js';
import {
  makeSafeWledTestState,
  pickBestWledDevice,
  sortWledDevices,
  summarizeWledInfo,
} from '../src/lib/wledDiscovery.js';
import {
  buildControllerProfile,
  controllerProfileReadiness,
  estimatePowerBudget,
  makeArtNetNotes,
  makeDhcpReservationNote,
  makeInstallReadinessReport,
  makeKnownGoodRecoveryState,
  makePixelCountProbeState,
  makePixelMarkerState,
  makeWledHostname,
} from '../src/lib/controllerProfiles.js';
import {
  CONTROLLER_COMPATIBILITY_LEVELS,
  auditWledControllerCompatibility,
} from '../src/lib/controllerCompatibility.js';
import {
  LWSEQ_HEADER_BYTES,
  buildStandaloneProfile,
  deriveStandaloneOutputsFromStrips,
  estimateLwseqBytes,
  makeStandalonePackage,
  normalizeStandaloneOutputs,
  toLwseqBytes,
} from '../src/lib/standaloneController.js';
import {
  ADVANCED_ARTNET_TIER_ID,
  PATTERN_TARGETS,
  WLED_BASIC_TIER_ID,
  describePatternCompatibility,
  getRuntimeTier,
  inferPatternTargets,
  recommendRuntimeTier,
} from '../src/lib/runtimeTargets.js';
import {
  buildWledBasicPackage,
  collectWledBasicPatternIds,
  makeWledBasicPresetsJson,
} from '../src/lib/wledBasicExport.js';
import {
  DEFAULT_WLED_PHYSICAL_CONTROLS,
  WLED_ENCODER_FIRMWARE_MODES,
  summarizeWledControlContract,
} from '../src/lib/wledControlContract.js';
import {
  buildWledInstallWizardPlan,
} from '../src/lib/wledInstallWizard.js';
import {
  PATTERN_COMPATIBILITY_GATES,
  auditPatternCompatibility,
  getPatternCompatibilityGate,
  summarizePatternCompatibility,
} from '../src/lib/patternCompatibility.js';
import {
  makePatternStudioSummary,
} from '../src/lib/patternStudio.js';
import {
  shouldRunBackgroundPatternOutput,
} from '../src/lib/backgroundOutput.js';
import {
  shouldRebuildStripPixels,
} from '../src/lib/stripPixels.js';
import {
  CUSTOM_PATTERNS_EVENT,
  CUSTOM_PATTERNS_KEY,
  CUSTOM_PATTERN_REVISIONS_KEY,
  acceptAiDraftAsCustomPattern,
  buildCustomPatternEntry,
  buildCustomPatternId,
  deleteCustomPattern,
  loadCustomPatterns,
  saveCustomPattern,
  updateCustomPattern,
} from '../src/lib/customPatterns.js';
import {
  getPatternById,
  getPatternCode,
  isBuiltInPattern,
  listPatterns,
} from '../src/lib/patternRegistry.js';
import {
  buildAiPatternPreviewFrame,
  validateAiPatternDraft,
} from '../src/lib/aiPatternDraft.js';
import { requestAiPatternDraft } from '../src/lib/aiPatternClient.js';
import { parseParamsFromCode } from '../src/lib/patternParams.js';

const palette = normalizePalette(['#123456', '#abcdef', '#ffcc00']);
const duplicateIds = PATTERNS.map(p => p.id).filter((id, i, arr) => arr.indexOf(id) !== i);
assert.deepEqual(duplicateIds, [], 'pattern ids must be unique');

const memoryStorage = (() => {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
})();

const parsedParams = parseParamsFromCode('// @param speed float 0.25 0.05 1.0\nreturn rgb(params.speed,0,0);');
assert.deepEqual(parsedParams, [{ name: 'speed', value: 0.25, min: 0.05, max: 1, step: 0.01 }]);

assert.deepEqual(
  DEMO_STRIPS.map(strip => strip.name),
  ['Inner Ring', 'Middle Ring', 'Outer Ring'],
  'empty-project demo strips should be neutral concentric rings',
);
assert.deepEqual(
  DEMO_STRIPS.map(strip => strip.leds),
  [64, 96, 128],
  'empty-project demo rings should provide increasing LED density',
);
assert.ok(
  DEMO_STRIPS.every(strip => strip.path.includes('A ') && strip.path.includes('320 200')),
  'empty-project demo rings should be centered in the default 640x400 viewBox',
);

assert.equal(buildCustomPatternId('Aurora Glass Drift'), 'custom_aurora_glass_drift');
assert.match(buildCustomPatternId('###'), /^custom_[a-z0-9]+$/);

const customEntry = buildCustomPatternEntry({
  name: 'Aurora Glass Drift',
  code: 'return hsv(time, 1, 1);',
  palette: ['#102a2b', '#57e7c1'],
});
assert.equal(customEntry.id, 'custom_aurora_glass_drift');
assert.equal(customEntry.custom, true);
assert.equal(customEntry.preview, 'linear-gradient(135deg,#102a2b,#57e7c1)');

saveCustomPattern(customEntry, { storage: memoryStorage, dispatch: false });
assert.equal(loadCustomPatterns({ storage: memoryStorage }).length, 1);
assert.equal(getPatternById('custom_aurora_glass_drift', { storage: memoryStorage }).name, 'Aurora Glass Drift');
assert.equal(getPatternCode('custom_aurora_glass_drift', { storage: memoryStorage }), 'return hsv(time, 1, 1);');
assert.equal(isBuiltInPattern('aurora'), true);
assert.equal(isBuiltInPattern('custom_aurora_glass_drift'), false);
assert.ok(listPatterns({ storage: memoryStorage }).some(pattern => pattern.id === 'custom_aurora_glass_drift'));

updateCustomPattern('custom_aurora_glass_drift', {
  name: 'Aurora Glass Drift',
  code: 'return hsv(0.6, 1, 1);',
  palette: ['#000000', '#ffffff'],
}, { storage: memoryStorage, dispatch: false });
const revisions = JSON.parse(memoryStorage.getItem(CUSTOM_PATTERN_REVISIONS_KEY));
assert.equal(revisions.custom_aurora_glass_drift.length, 1);
assert.equal(revisions.custom_aurora_glass_drift[0].code, 'return hsv(time, 1, 1);');
assert.equal(getPatternCode('custom_aurora_glass_drift', { storage: memoryStorage }), 'return hsv(0.6, 1, 1);');

deleteCustomPattern('custom_aurora_glass_drift', { storage: memoryStorage, dispatch: false });
assert.equal(loadCustomPatterns({ storage: memoryStorage }).length, 0);
assert.equal(CUSTOM_PATTERNS_EVENT, 'lw:custom-updated');
assert.equal(CUSTOM_PATTERNS_KEY, 'lw_custom_patterns');

const builtInAccept = acceptAiDraftAsCustomPattern({
  sourcePattern: { id: 'aurora', name: 'Aurora', isCustom: false },
  draft: {
    name: 'Aurora Glass Drift',
    description: 'Softer aurora',
    code: 'return hsv(0.6,1,1);',
    palette: ['#102a2b', '#57e7c1'],
    suggestedParams: { speed: 0.1 },
  },
}, { storage: memoryStorage, dispatch: false });
assert.equal(builtInAccept.id, 'custom_aurora_glass_drift');
assert.equal(loadCustomPatterns({ storage: memoryStorage }).some(pattern => pattern.id === builtInAccept.id), true);

const updatedAccept = acceptAiDraftAsCustomPattern({
  sourcePattern: { id: builtInAccept.id, name: builtInAccept.name, isCustom: true },
  draft: {
    name: 'Aurora Glass Drift',
    description: 'Even smoother',
    code: 'return hsv(0.7,1,1);',
    palette: ['#000000', '#ffffff'],
    suggestedParams: { speed: 0.05 },
  },
}, { storage: memoryStorage, dispatch: false });
assert.equal(updatedAccept.id, builtInAccept.id);
assert.equal(getPatternCode(builtInAccept.id, { storage: memoryStorage }), 'return hsv(0.7,1,1);');
const acceptRevisions = JSON.parse(memoryStorage.getItem(CUSTOM_PATTERN_REVISIONS_KEY));
assert.equal(acceptRevisions[builtInAccept.id][0].code, 'return hsv(0.6,1,1);');

const duplicateBuiltInAccept = acceptAiDraftAsCustomPattern({
  sourcePattern: { id: 'aurora', name: 'Aurora', isCustom: false },
  draft: {
    name: 'Aurora Glass Drift',
    description: 'Softer aurora duplicate',
    code: 'return hsv(0.8,1,1);',
    palette: ['#102a2b', '#57e7c1'],
    suggestedParams: { speed: 0.2 },
  },
}, { storage: memoryStorage, dispatch: false });
assert.equal(duplicateBuiltInAccept.id, 'custom_aurora_glass_drift_2');
assert.equal(loadCustomPatterns({ storage: memoryStorage }).filter(pattern => pattern.name === 'Aurora Glass Drift').length, 2);

const customFlagAccept = acceptAiDraftAsCustomPattern({
  sourcePattern: { id: duplicateBuiltInAccept.id, name: duplicateBuiltInAccept.name, custom: true },
  draft: {
    name: 'Aurora Glass Drift',
    description: 'Updated from custom flag',
    code: 'return hsv(0.9,1,1);',
    palette: ['#000000', '#ffffff'],
    suggestedParams: { speed: 0.3 },
  },
}, { storage: memoryStorage, dispatch: false });
assert.equal(customFlagAccept.id, duplicateBuiltInAccept.id);
assert.equal(getPatternCode(duplicateBuiltInAccept.id, { storage: memoryStorage }), 'return hsv(0.9,1,1);');

let aiClientHeaders = null;
const aiClientDraft = await requestAiPatternDraft(
  { instruction: 'make it smoother' },
  {
    token: 'shared-secret',
    fetchImpl: async (_url, options) => {
      aiClientHeaders = options.headers;
      return new Response(JSON.stringify({ draft: { name: 'Authorized Draft' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  },
);
assert.equal(aiClientDraft.name, 'Authorized Draft');
assert.equal(aiClientHeaders['x-lightweaver-ai-token'], 'shared-secret');

const previousLocalStorage = globalThis.localStorage;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: memoryStorage,
});
memoryStorage.setItem('lw_ai_pattern_token', 'stored-secret');
let storedTokenHeaders = null;
await requestAiPatternDraft(
  { instruction: 'make it smoother' },
  {
    fetchImpl: async (_url, options) => {
      storedTokenHeaders = options.headers;
      return new Response(JSON.stringify({ draft: { name: 'Stored Token Draft' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  },
);
assert.equal(storedTokenHeaders['x-lightweaver-ai-token'], 'stored-secret');
if (previousLocalStorage === undefined) {
  delete globalThis.localStorage;
} else {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: previousLocalStorage,
  });
}

saveCustomPattern({
  id: 'aurora',
  name: 'Fake Aurora',
  code: 'return rgb(1, 0, 0);',
}, { storage: memoryStorage, dispatch: false });
assert.equal(getPatternById('aurora', { storage: memoryStorage }).custom, undefined);
assert.notEqual(getPatternCode('aurora', { storage: memoryStorage }), 'return rgb(1, 0, 0);');
deleteCustomPattern('aurora', { storage: memoryStorage, dispatch: false });

const validDraft = validateAiPatternDraft({
  name: 'Soft Reef',
  description: 'Blue-green bioluminescent drift.',
  changeSummary: ['Created slow ocean motion'],
  palette: ['#001a2a', '#22e6c7', '#7aa7ff'],
  code: '// @param speed float 0.2 0.05 1.0\nconst v = fbm(x * 2 + t * params.speed, y * 2, 4);\nreturn samplePalette(v);',
  suggestedParams: { speed: 0.2 },
}, {
  strips: [{
    id: 'draft-strip',
    pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
  }],
});
assert.equal(validDraft.ok, true);
assert.equal(validDraft.draft.name, 'Soft Reef');
assert.equal(validDraft.params[0].name, 'speed');

const trimmedPaletteDraft = validateAiPatternDraft({
  name: 'Trimmed Palette',
  description: 'Normalizes palette whitespace.',
  changeSummary: ['Trimmed palette'],
  palette: [' #ABCDEF ', '#001122'],
  code: 'return rgb(1,1,1);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(trimmedPaletteDraft.ok, true);
assert.deepEqual(trimmedPaletteDraft.draft.palette, ['#abcdef', '#001122']);

const normalizedSuggestedParamsDraft = validateAiPatternDraft({
  name: 'Numeric Params Only',
  description: 'Drops non-numeric suggested params.',
  changeSummary: ['Normalized params'],
  palette: ['#000000', '#ffffff'],
  code: '// @param speed float 0.1 0 1\nreturn rgb(params.speed, 0, 0);',
  suggestedParams: { speed: 0.2, state: { touched: false }, bad: 'x' },
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(normalizedSuggestedParamsDraft.ok, true);
assert.deepEqual(normalizedSuggestedParamsDraft.draft.suggestedParams, { speed: 0.2 });

const polarHelperDraft = validateAiPatternDraft({
  name: 'Polar Helper',
  description: 'Uses local polar result members.',
  changeSummary: ['Used polar helper'],
  palette: ['#000000', '#ffffff'],
  code: 'const p = polar(x, y);\nreturn hsv(p.a, 1, 1 - p.r);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(polarHelperDraft.ok, true);

const unsafeDraft = validateAiPatternDraft({
  name: 'Unsafe',
  description: 'Attempts browser access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'fetch("https://example.com"); return rgb(1,1,1);',
});
assert.equal(unsafeDraft.ok, false);
assert.equal(unsafeDraft.error.kind, 'unsafe-code');

const alertUnsafeDraft = validateAiPatternDraft({
  name: 'Alert Unsafe',
  description: 'Attempts unqualified browser global access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'alert(1); return rgb(1,1,1);',
});
assert.equal(alertUnsafeDraft.ok, false);
assert.equal(alertUnsafeDraft.error.kind, 'unsafe-code');

const globalWriteUnsafeDraft = validateAiPatternDraft({
  name: 'Global Write Unsafe',
  description: 'Attempts sloppy-mode global writes.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'r = 1; get = 2; return rgb(1,1,1);',
});
assert.equal(globalWriteUnsafeDraft.ok, false);
assert.equal(globalWriteUnsafeDraft.error.kind, 'unsafe-code');

const nonAsciiUnsafeDraft = validateAiPatternDraft({
  name: 'Non ASCII Unsafe',
  description: 'Attempts non-ASCII identifier write.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'α = 1; return rgb(1,1,1);',
});
assert.equal(nonAsciiUnsafeDraft.ok, false);
assert.equal(nonAsciiUnsafeDraft.error.kind, 'unsafe-code');

const historyUnsafeDraft = validateAiPatternDraft({
  name: 'History Unsafe',
  description: 'Attempts browser history access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'history.back(); return rgb(1,1,1);',
});
assert.equal(historyUnsafeDraft.ok, false);
assert.equal(historyUnsafeDraft.error.kind, 'unsafe-code');

const computedUnsafeDraft = validateAiPatternDraft({
  name: 'Computed Unsafe',
  description: 'Attempts computed global access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'this["fet"+"ch"]("https://example.com"); return rgb(1,1,1);',
});
assert.equal(computedUnsafeDraft.ok, false);
assert.equal(computedUnsafeDraft.error.kind, 'unsafe-code');

const unicodeEscapeUnsafeDraft = validateAiPatternDraft({
  name: 'Unicode Escape Unsafe',
  description: 'Attempts escaped global access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'glob\\u0061lThis.loc\\u0061lStorage?.clear(); return rgb(1,1,1);',
});
assert.equal(unicodeEscapeUnsafeDraft.ok, false);
assert.equal(unicodeEscapeUnsafeDraft.error.kind, 'unsafe-code');
assert.throws(
  () => buildAiPatternPreviewFrame({
    name: 'Unicode Escape Unsafe',
    description: 'Attempts escaped global access.',
    changeSummary: ['Invalid'],
    palette: ['#000000', '#ffffff'],
    code: 'glob\\u0061lThis.loc\\u0061lStorage?.clear(); return rgb(1,1,1);',
  }),
  error => error.kind === 'unsafe-code',
);

const reconstructedUnsafeDraft = validateAiPatternDraft({
  name: 'Reconstructed Unsafe',
  description: 'Attempts constructor reconstruction.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: '[]["filter"]["constr"+"uctor"]("return 1")(); return rgb(1,1,1);',
});
assert.equal(reconstructedUnsafeDraft.ok, false);
assert.equal(reconstructedUnsafeDraft.error.kind, 'unsafe-code');

const functionUnsafeDraft = validateAiPatternDraft({
  name: 'Function Unsafe',
  description: 'Attempts dynamic this access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'function leak(){ return this; } return rgb(1,1,1);',
});
assert.equal(functionUnsafeDraft.ok, false);
assert.equal(functionUnsafeDraft.error.kind, 'unsafe-code');

const arrowUnsafeDraft = validateAiPatternDraft({
  name: 'Arrow Unsafe',
  description: 'Attempts function-like arrow code.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'const f = () => 1; return rgb(1,1,1);',
});
assert.equal(arrowUnsafeDraft.ok, false);
assert.equal(arrowUnsafeDraft.error.kind, 'unsafe-code');

const whileUnsafeDraft = validateAiPatternDraft({
  name: 'While Unsafe',
  description: 'Attempts an unbounded loop.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'while (true) {} return rgb(1,1,1);',
});
assert.equal(whileUnsafeDraft.ok, false);
assert.equal(whileUnsafeDraft.error.kind, 'unsafe-code');

const allocationUnsafeDraft = validateAiPatternDraft({
  name: 'Allocation Unsafe',
  description: 'Attempts large allocation.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'Array(10000000).fill(0); return rgb(1,1,1);',
});
assert.equal(allocationUnsafeDraft.ok, false);
assert.equal(allocationUnsafeDraft.error.kind, 'unsafe-code');

const expensiveFbmUnsafeDraft = validateAiPatternDraft({
  name: 'Expensive Fbm Unsafe',
  description: 'Attempts excessive fbm octaves.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(fbm(x, y, 1000), 0, 0);',
});
assert.equal(expensiveFbmUnsafeDraft.ok, false);
assert.equal(expensiveFbmUnsafeDraft.error.kind, 'unsafe-code');

const spacedFbmUnsafeDraft = validateAiPatternDraft({
  name: 'Spaced Fbm Unsafe',
  description: 'Attempts excessive fbm octaves with spacing.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(fbm (x, y, 1000) + 0.1, 0, 0);',
});
assert.equal(spacedFbmUnsafeDraft.ok, false);
assert.equal(spacedFbmUnsafeDraft.error.kind, 'unsafe-code');

const newlineFbmUnsafeDraft = validateAiPatternDraft({
  name: 'Newline Fbm Unsafe',
  description: 'Attempts excessive fbm octaves with newline.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(fbm\n(x, y, 1000) + 0.1, 0, 0);',
});
assert.equal(newlineFbmUnsafeDraft.ok, false);
assert.equal(newlineFbmUnsafeDraft.error.kind, 'unsafe-code');

const aliasFbmUnsafeDraft = validateAiPatternDraft({
  name: 'Alias Fbm Unsafe',
  description: 'Attempts excessive fbm octaves through alias.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'const f = fbm; return rgb(f(x, y, 1000) + 0.1, 0, 0);',
});
assert.equal(aliasFbmUnsafeDraft.ok, false);
assert.equal(aliasFbmUnsafeDraft.error.kind, 'unsafe-code');

const dollarAliasFbmUnsafeDraft = validateAiPatternDraft({
  name: 'Dollar Alias Fbm Unsafe',
  description: 'Attempts excessive fbm octaves through a dollar alias.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'const $ = fbm; return rgb($(x, y, 13) + 1, 0, 0);',
});
assert.equal(dollarAliasFbmUnsafeDraft.ok, false);
assert.equal(dollarAliasFbmUnsafeDraft.error.kind, 'unsafe-code');

const doubleDollarAliasFbmUnsafeDraft = validateAiPatternDraft({
  name: 'Double Dollar Alias Fbm Unsafe',
  description: 'Attempts excessive fbm octaves through a double dollar alias.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'const $$ = fbm; return rgb($$(x, y, 13) + 1, 0, 0);',
});
assert.equal(doubleDollarAliasFbmUnsafeDraft.ok, false);
assert.equal(doubleDollarAliasFbmUnsafeDraft.error.kind, 'unsafe-code');

const dollarIdentifierUnsafeDraft = validateAiPatternDraft({
  name: 'Dollar Identifier Unsafe',
  description: 'Attempts a dollar identifier declaration.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'const $ = 1; return rgb(1,1,1);',
});
assert.equal(dollarIdentifierUnsafeDraft.ok, false);
assert.equal(dollarIdentifierUnsafeDraft.error.kind, 'unsafe-code');

const methodUnsafeDraft = validateAiPatternDraft({
  name: 'Method Unsafe',
  description: 'Attempts method-style map access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'values.map(x); return rgb(1,1,1);',
});
assert.equal(methodUnsafeDraft.ok, false);
assert.equal(methodUnsafeDraft.error.kind, 'unsafe-code');

const expensiveHelperUnsafeDraft = validateAiPatternDraft({
  name: 'Expensive Helper Unsafe',
  description: 'Attempts excessive helper work.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(fbm(x, y, 1000000000), 0, 0);',
});
assert.equal(expensiveHelperUnsafeDraft.ok, false);
assert.equal(expensiveHelperUnsafeDraft.error.kind, 'unsafe-code');

const bigintShiftUnsafeDraft = validateAiPatternDraft({
  name: 'BigInt Shift Unsafe',
  description: 'Attempts BigInt shift abuse.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(1n << 8n, 0, 0);',
});
assert.equal(bigintShiftUnsafeDraft.ok, false);
assert.equal(bigintShiftUnsafeDraft.error.kind, 'unsafe-code');

const radixBigintExponentUnsafeDraft = validateAiPatternDraft({
  name: 'Radix BigInt Exponent Unsafe',
  description: 'Attempts radix BigInt exponentiation.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(0x2n ** 0x10n, 0, 0);',
});
assert.equal(radixBigintExponentUnsafeDraft.ok, false);
assert.equal(radixBigintExponentUnsafeDraft.error.kind, 'unsafe-code');

const hexLiteralUnsafeDraft = validateAiPatternDraft({
  name: 'Hex Literal Unsafe',
  description: 'Attempts a hex numeric literal.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(0x100000000,0,0);',
});
assert.equal(hexLiteralUnsafeDraft.ok, false);
assert.equal(hexLiteralUnsafeDraft.error.kind, 'unsafe-code');

const binaryLiteralUnsafeDraft = validateAiPatternDraft({
  name: 'Binary Literal Unsafe',
  description: 'Attempts a binary numeric literal.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(0b111111111111111111111111111111111111111111111111,0,0);',
});
assert.equal(binaryLiteralUnsafeDraft.ok, false);
assert.equal(binaryLiteralUnsafeDraft.error.kind, 'unsafe-code');

const numericSeparatorUnsafeDraft = validateAiPatternDraft({
  name: 'Numeric Separator Unsafe',
  description: 'Attempts numeric separators.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(1_000_000_000_000,0,0);',
});
assert.equal(numericSeparatorUnsafeDraft.ok, false);
assert.equal(numericSeparatorUnsafeDraft.error.kind, 'unsafe-code');

const decimalExponentDraft = validateAiPatternDraft({
  name: 'Decimal Exponent',
  description: 'Uses a small exponent decimal.',
  changeSummary: ['Uses exponent'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(0.5 + 1e-3, 0, 0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(decimalExponentDraft.ok, true);

const tooManyHelperCallsDraft = validateAiPatternDraft({
  name: 'Too Many Helpers',
  description: 'Attempts too many helper calls.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: `const v = ${Array.from({ length: 81 }, () => 'sin(0)').join(' + ')}; return rgb(1,1,1);`,
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(tooManyHelperCallsDraft.ok, false);
assert.equal(tooManyHelperCallsDraft.error.kind, 'unsafe-code');

const tooManyFbmCallsDraft = validateAiPatternDraft({
  name: 'Too Many Fbm Calls',
  description: 'Attempts too many fbm calls.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: `const v = ${Array.from({ length: 9 }, () => 'fbm(x,y,4)').join(' + ')}; return rgb(1,1,1);`,
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(tooManyFbmCallsDraft.ok, false);
assert.equal(tooManyFbmCallsDraft.error.kind, 'unsafe-code');

const tooDeepNestingDraft = validateAiPatternDraft({
  name: 'Too Deep Nesting',
  description: 'Attempts excessive parenthesis nesting.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: `return rgb(${Array.from({ length: 25 }, () => 'sin(').join('')}0${')'.repeat(25)},0,0);`,
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(tooDeepNestingDraft.ok, false);
assert.equal(tooDeepNestingDraft.error.kind, 'unsafe-code');

const parenthesizedFbmUnsafeDraft = validateAiPatternDraft({
  name: 'Parenthesized Fbm Unsafe',
  description: 'Attempts parenthesized fbm call.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(1, (fbm)(x, y, 13), 0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(parenthesizedFbmUnsafeDraft.ok, false);
assert.equal(parenthesizedFbmUnsafeDraft.error.kind, 'unsafe-code');

const commaFbmUnsafeDraft = validateAiPatternDraft({
  name: 'Comma Fbm Unsafe',
  description: 'Attempts comma-expression fbm call.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(1, (0, fbm)(x, y, 13), 0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(commaFbmUnsafeDraft.ok, false);
assert.equal(commaFbmUnsafeDraft.error.kind, 'unsafe-code');

const parenthesizedAliasFbmUnsafeDraft = validateAiPatternDraft({
  name: 'Parenthesized Alias Fbm Unsafe',
  description: 'Attempts parenthesized local helper alias call.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'const f = fbm; return rgb(1, (f)(x, y, 13), 0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(parenthesizedAliasFbmUnsafeDraft.ok, false);
assert.equal(parenthesizedAliasFbmUnsafeDraft.error.kind, 'unsafe-code');

const parenthesizedHelperCapDraft = validateAiPatternDraft({
  name: 'Parenthesized Helper Cap',
  description: 'Attempts too many parenthesized helper calls.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: `const v = ${Array.from({ length: 81 }, () => '(sin)(0)').join(' + ')}; return rgb(1,1,1);`,
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(parenthesizedHelperCapDraft.ok, false);
assert.equal(parenthesizedHelperCapDraft.error.kind, 'unsafe-code');

const longCommentUnsafeDraft = validateAiPatternDraft({
  name: 'Long Comment Unsafe',
  description: 'Attempts excessive raw code length.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: `/* ${'x'.repeat(4100)} */ return rgb(1,1,1);`,
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(longCommentUnsafeDraft.ok, false);
assert.equal(longCommentUnsafeDraft.error.kind, 'unsafe-code');

assert.throws(
  () => buildAiPatternPreviewFrame({
    name: 'Unsafe Direct Preview',
    description: 'Attempts browser access without validation.',
    changeSummary: ['Invalid'],
    palette: ['#000000', '#ffffff'],
    code: 'fetch("https://example.com"); return rgb(1,1,1);',
  }),
  error => error.kind === 'unsafe-code',
);

const invalidShapeDraft = validateAiPatternDraft({
  description: 'Missing required name.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(1,1,1);',
});
assert.equal(invalidShapeDraft.ok, false);
assert.equal(invalidShapeDraft.error.kind, 'invalid-shape');

const blankSummaryDraft = validateAiPatternDraft({
  name: 'Blank Summary',
  description: 'Has no meaningful summary.',
  changeSummary: ['   '],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(1,1,1);',
});
assert.equal(blankSummaryDraft.ok, false);
assert.equal(blankSummaryDraft.error.kind, 'invalid-shape');

const invalidPaletteDraft = validateAiPatternDraft({
  name: 'Bad Palette',
  description: 'Contains invalid colors.',
  changeSummary: ['Invalid'],
  palette: ['#000000', 'white'],
  code: 'return rgb(1,1,1);',
});
assert.equal(invalidPaletteDraft.ok, false);
assert.equal(invalidPaletteDraft.error.kind, 'invalid-palette');

const compileErrorDraft = validateAiPatternDraft({
  name: 'Syntax Error',
  description: 'Contains malformed code.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(1,1,1',
});
assert.equal(compileErrorDraft.ok, false);
assert.equal(compileErrorDraft.error.kind, 'compile-error');

const runtimeErrorDraft = validateAiPatternDraft({
  name: 'Runtime Error',
  description: 'Throws while rendering.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'throw 1;',
});
assert.equal(runtimeErrorDraft.ok, false);
assert.equal(runtimeErrorDraft.error.kind, 'runtime-error');

const hiddenStripRuntimeErrorDraft = validateAiPatternDraft({
  name: 'Hidden Strip Runtime Error',
  description: 'Throws even when provided strips are hidden.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'throw 1;',
}, {
  instruction: 'blackout the lights',
  strips: [{ hidden: true, pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(hiddenStripRuntimeErrorDraft.ok, false);
assert.equal(hiddenStripRuntimeErrorDraft.error.kind, 'runtime-error');

const getterRuntimeErrorDraft = validateAiPatternDraft({
  name: 'Getter Runtime Error',
  description: 'Throws while reading returned color.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'return { get r() { throw 1; }, g: 0, b: 0 };',
});
assert.equal(getterRuntimeErrorDraft.ok, false);
assert.equal(getterRuntimeErrorDraft.error.kind, 'unsafe-code');
assert.throws(
  () => buildAiPatternPreviewFrame({
    name: 'Getter Runtime Error',
    description: 'Throws while reading returned color.',
    changeSummary: ['Invalid'],
    palette: ['#000000', '#ffffff'],
    code: 'return { get r() { throw 1; }, g: 0, b: 0 };',
  }),
  error => error.kind === 'unsafe-code',
);

const indexedRuntimeDraft = {
  name: 'Indexed Runtime Error',
  description: 'Throws on a later pixel.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'if (index === 3) throw 1; return rgb(1,1,1);',
};
const indexedRuntimeOptions = {
  strips: [{
    id: 'draft-strip',
    pixels: [{ x: 0, y: 0 }, { x: 0.33, y: 0 }, { x: 0.66, y: 0 }, { x: 1, y: 0 }],
  }],
};
const indexedRuntimeErrorDraft = validateAiPatternDraft(indexedRuntimeDraft, indexedRuntimeOptions);
assert.equal(indexedRuntimeErrorDraft.ok, false);
assert.equal(indexedRuntimeErrorDraft.error.kind, 'runtime-error');
assert.throws(
  () => buildAiPatternPreviewFrame(indexedRuntimeDraft, indexedRuntimeOptions),
);

const mutatingParamsUnsafeDraft = {
  name: 'Mutating Params Unsafe',
  description: 'Attempts params assignment.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: '// @param touched float 0 0 1\nif (params.touched) throw 1;\nparams.touched = 1;\nreturn rgb(1, 1, 1);',
};
const mutatingParamsUnsafeResult = validateAiPatternDraft(mutatingParamsUnsafeDraft, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
});
assert.equal(mutatingParamsUnsafeResult.ok, false);
assert.equal(mutatingParamsUnsafeResult.error.kind, 'unsafe-code');
assert.throws(
  () => buildAiPatternPreviewFrame(mutatingParamsUnsafeDraft, {
    strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
  }),
  error => error.kind === 'unsafe-code',
);

const nestedParamsUnsafeDraft = validateAiPatternDraft({
  name: 'Nested Params Unsafe',
  description: 'Attempts nested params member access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'if (params.state.touched) throw 1;\nparams.state.touched = true;\nreturn rgb(1, 1, 1);',
  suggestedParams: { state: { touched: false } },
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(nestedParamsUnsafeDraft.ok, false);
assert.equal(nestedParamsUnsafeDraft.error.kind, 'unsafe-code');

const blankDraft = validateAiPatternDraft({
  name: 'Blank',
  description: 'Accidental blackout.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(blankDraft.ok, false);
assert.equal(blankDraft.error.kind, 'blank-render');

const darkRedBlankDraft = validateAiPatternDraft({
  name: 'Dark Red',
  description: 'Accidental blackout for a dark red request.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  instruction: 'make a dark red glow',
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(darkRedBlankDraft.ok, false);
assert.equal(darkRedBlankDraft.error.kind, 'blank-render');

const blackoutDraft = validateAiPatternDraft({
  name: 'Blackout',
  description: 'Intentional blackout scene.',
  changeSummary: ['Turns all LEDs off'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  instruction: 'make an intentional blackout',
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(blackoutDraft.ok, true);

const lightsOffDraft = validateAiPatternDraft({
  name: 'Lights Off',
  description: 'Intentional lights-off scene.',
  changeSummary: ['Turns all LEDs off'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  instruction: 'make the lights off',
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(lightsOffDraft.ok, true);

const turnOffDraft = validateAiPatternDraft({
  name: 'Turn Off',
  description: 'Intentional off scene.',
  changeSummary: ['Turns all LEDs off'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  instruction: 'turn off the lights',
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(turnOffDraft.ok, true);

const standaloneMapDraft = validateAiPatternDraft({
  name: 'Standalone Map',
  description: 'Uses allowed map helper.',
  changeSummary: ['Uses map helper'],
  palette: ['#000000', '#ffffff'],
  code: 'const v = map(index, 0, pixelCount, 0, 1); return rgb(1,1,1);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(standaloneMapDraft.ok, true);

const localReassignmentDraft = validateAiPatternDraft({
  name: 'Local Reassignment',
  description: 'Allows safe local reassignment.',
  changeSummary: ['Uses local assignment'],
  palette: ['#000000', '#ffffff'],
  code: 'let v = 0; if (x < 0.5) v = 1; return rgb(v,0,0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 1, y: 0 }] }],
});
assert.equal(localReassignmentDraft.ok, true);

const multiConstDraft = validateAiPatternDraft({
  name: 'Multiple Const',
  description: 'Allows multiple const declarators.',
  changeSummary: ['Uses multiple consts'],
  palette: ['#000000', '#ffffff'],
  code: 'const cx = x - 0.5, cy = y - 0.5; return rgb(abs(cx), abs(cy), 0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(multiConstDraft.ok, true);

const groupedArithmeticDraft = validateAiPatternDraft({
  name: 'Grouped Arithmetic',
  description: 'Allows normal parenthesized arithmetic.',
  changeSummary: ['Uses grouped arithmetic'],
  palette: ['#000000', '#ffffff'],
  code: 'const v = ((x + y) * 0.5); return rgb(v,0,0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(groupedArithmeticDraft.ok, true);

const runtimeWriteUnsafeDraft = validateAiPatternDraft({
  name: 'Runtime Write Unsafe',
  description: 'Attempts runtime input assignment.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'x = 1; return rgb(1,1,1);',
});
assert.equal(runtimeWriteUnsafeDraft.ok, false);
assert.equal(runtimeWriteUnsafeDraft.error.kind, 'unsafe-code');

const paramsWriteUnsafeDraft = validateAiPatternDraft({
  name: 'Params Write Unsafe',
  description: 'Attempts params assignment.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'params.speed = 1; return rgb(1,1,1);',
});
assert.equal(paramsWriteUnsafeDraft.ok, false);
assert.equal(paramsWriteUnsafeDraft.error.kind, 'unsafe-code');

const helperWriteUnsafeDraft = validateAiPatternDraft({
  name: 'Helper Write Unsafe',
  description: 'Attempts helper assignment.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'rgb = 1; return rgb(1,1,1);',
});
assert.equal(helperWriteUnsafeDraft.ok, false);
assert.equal(helperWriteUnsafeDraft.error.kind, 'unsafe-code');

const runtimeConstantsDraft = validateAiPatternDraft({
  name: 'Runtime Constants',
  description: 'Uses runtime math constants.',
  changeSummary: ['Uses constants'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(sin(PI), cos(TAU), sin(TWO_PI));',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(runtimeConstantsDraft.ok, true);

const validFbmDraft = validateAiPatternDraft({
  name: 'Valid Fbm',
  description: 'Uses capped fbm octaves.',
  changeSummary: ['Uses fbm'],
  palette: ['#000000', '#ffffff'],
  code: 'const v = fbm(x, y, 4); return rgb(1,1,1);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(validFbmDraft.ok, true);

const emptyStripFallbackDraft = validateAiPatternDraft({
  name: 'Empty Strip Fallback',
  description: 'Falls back to default preview points.',
  changeSummary: ['Renders light'],
  palette: ['#000000', '#ffffff'],
  code: 'return rgb(1,1,1);',
}, {
  strips: [{ id: 'empty-strip', pixels: [] }],
});
assert.equal(emptyStripFallbackDraft.ok, true);
assert.ok(emptyStripFallbackDraft.frame.pixels.length > 0);

const previewFrame = buildAiPatternPreviewFrame(validDraft.draft, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(previewFrame.pixels.length, 2);

assert.throws(
  () => buildAiPatternPreviewFrame({
    name: 'Accidental Blank Preview',
    description: 'Should not preview accidental blackout.',
    changeSummary: ['Invalid'],
    palette: ['#000000', '#111111'],
    code: 'return rgb(0,0,0);',
  }, {
    instruction: 'make a dim shimmer',
    strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
  }),
  error => error.kind === 'blank-render',
);
const intentionalBlankPreviewFrame = buildAiPatternPreviewFrame({
  name: 'Intentional Blank Preview',
  description: 'Allows intentional blackout preview.',
  changeSummary: ['Turns LEDs off'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  instruction: 'blackout the lights',
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(intentionalBlankPreviewFrame.pixels.length, 1);

const suggestedParamDraft = {
  name: 'Param Brightness',
  description: 'Uses suggested params.',
  changeSummary: ['Sets brightness'],
  palette: ['#000000', '#ffffff'],
  code: '// @param brightness float 0.1 0.0 1.0\nreturn rgb(params.brightness, 0, 0);',
  suggestedParams: { brightness: 0.8 },
};
const suggestedParamValidation = validateAiPatternDraft(suggestedParamDraft, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(suggestedParamValidation.ok, true);
assert.equal(suggestedParamValidation.params[0].value, 0.8);
const suggestedParamFrame = buildAiPatternPreviewFrame(suggestedParamDraft, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.ok(Math.abs(suggestedParamFrame.pixels[0].r - 204) < Math.abs(suggestedParamFrame.pixels[0].r - 26));

const clampedSuggestedParamFrame = buildAiPatternPreviewFrame({
  name: 'Clamped Brightness',
  description: 'Clamps huge suggested params.',
  changeSummary: ['Clamps brightness'],
  palette: ['#000000', '#ffffff'],
  code: '// @param brightness float 0.1 0.0 1.0\nreturn rgb(params.brightness, 0, 0);',
  suggestedParams: { brightness: 1000000000 },
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(clampedSuggestedParamFrame.pixels[0].r, 255);

const noBuiltInParamsDraft = {
  name: 'No Built In Params',
  description: 'Should not inherit built-in pattern params.',
  changeSummary: ['Avoids default params'],
  palette: ['#000000', '#ffffff'],
  code: 'if (params.speed) throw 1; return rgb(1, 1, 1);',
  suggestedParams: {},
};
const noBuiltInParamsValidation = validateAiPatternDraft(noBuiltInParamsDraft, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(noBuiltInParamsValidation.ok, true);
const noBuiltInParamsFrame = buildAiPatternPreviewFrame(noBuiltInParamsDraft, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }] }],
});
assert.ok(
  noBuiltInParamsFrame.pixels[0].r > 200
    && noBuiltInParamsFrame.pixels[0].g > 200
    && noBuiltInParamsFrame.pixels[0].b > 200,
);

const customParamEntry = saveCustomPattern({
  name: 'Param Glow',
  code: '// @param speed float 0.5 0 1\nreturn rgb(params.speed, 0, 0);',
}, { storage: memoryStorage, dispatch: false });
const originalLocalStorage = globalThis.localStorage;
globalThis.localStorage = memoryStorage;
try {
  assert.ok(compilePattern(customParamEntry.id), 'custom pattern should compile through frame engine registry lookup');
  const customParamFrame = renderPixelFrame({
    t: 0,
    strips: [{
      id: 'custom-param-strip',
      pts: [{ x: 0, y: 0, p: 0 }],
    }],
    patternId: customParamEntry.id,
    paletteNorm: palette,
  });
  assert.deepEqual(customParamFrame.pixels[0], { r: 128, g: 0, b: 0 });
} finally {
  if (originalLocalStorage === undefined) {
    delete globalThis.localStorage;
  } else {
    globalThis.localStorage = originalLocalStorage;
  }
}

for (const pattern of PATTERNS) {
  const { fn, error } = compile(pattern.code || 'return [0,0,0];');
  assert.equal(error, null, `${pattern.id} should compile`);
  assert.ok(fn, `${pattern.id} should return a compiled function`);
  for (const sample of [
    { index: 0, x: 0, y: 0, t: 0, time: 0, pixelCount: 1, stripProgress: 0 },
    { index: 1, x: 0.25, y: 0.5, t: 0.25, time: 0.1, pixelCount: 8, stripProgress: 0.2 },
    { index: 7, x: 1, y: 1, t: 1.5, time: 0.75, pixelCount: 8, stripProgress: 1 },
  ]) {
    const out = evalPixel(fn, sample.index, sample.x, sample.y, sample.t, sample.time, sample.pixelCount, palette, 0.25, 0.5, {}, 'audit', sample.stripProgress);
    assert.ok(Number.isFinite(out.r) && Number.isFinite(out.g) && Number.isFinite(out.b), `${pattern.id} produced invalid RGB`);
  }
}

const defaultProject = createDefaultProject();
assert.equal(defaultProject.version, PROJECT_VERSION);
assert.match(defaultProject.id, /^lwproj-/);
assert.equal(defaultProject.devices.wledIp, '');
assert.deepEqual(defaultProject.devices.segmentMap, {});
assert.deepEqual(defaultProject.devices.controllerProfiles, []);
assert.equal(defaultProject.devices.activeControllerId, '');
assert.deepEqual(defaultProject.devices.physicalControls, DEFAULT_WLED_PHYSICAL_CONTROLS);
assert.equal(defaultProject.devices.standaloneController.outputs.length, 4);
assert.equal(defaultProject.devices.standaloneController.outputs[0].pin, 16);
assert.equal(defaultProject.devices.standaloneController.controls.blackout, 9);
assert.equal(defaultProject.devices.standaloneController.runtimeMode, 'sequence');
assert.equal(defaultProject.pattern.motionSmoothing, 'soft');

const savedWithLayout = {
  ...createDefaultProject(),
  layout: {
    ...createDefaultProject().layout,
    strips: [{ id: 'saved-strip', pathData: 'M0 0 L10 0', pixelCount: 10, pixels: [{ x: 0, y: 0 }] }],
  },
  pattern: {
    ...createDefaultProject().pattern,
    activePatternId: 'gradient',
  },
};
const emptyLegacyLayout = {
  version: 2,
  strips: [],
  viewBox: '0 0 640 400',
};
assert.equal(
  resolveStartupProject({ savedProject: savedWithLayout, legacyLayoutProject: emptyLegacyLayout }).layout.strips.length,
  1,
  'empty legacy layout autosave must not overwrite the canonical project layout',
);

const recoverableLegacyLayout = {
  version: 2,
  strips: [{ id: 'legacy-strip', pathData: 'M0 0 L20 0', pixelCount: 20 }],
  viewBox: '0 0 640 400',
};
const recoveredStartup = resolveStartupProject({
  savedProject: createDefaultProject(),
  legacyLayoutProject: recoverableLegacyLayout,
});
// The recovered legacy strip is re-homed onto the strip-<n> namespace (its old
// id is preserved as sourceLayerId so its artwork source can still be found).
assert.match(recoveredStartup.layout.strips[0].id, /^strip-\d+$/);
assert.equal(recoveredStartup.layout.strips[0].sourceLayerId, 'legacy-strip');
assert.equal(recoveredStartup.pattern.activePatternId, 'aurora');

const wledBasicTier = getRuntimeTier(WLED_BASIC_TIER_ID);
assert.equal(wledBasicTier.id, 'wled-basic');
assert.equal(wledBasicTier.requiresPiAtRuntime, false);
assert.ok(wledBasicTier.lookStorage.includes('WLED presets'));
assert.ok(wledBasicTier.capabilities.includes(PATTERN_TARGETS.WLED_CUSTOM_EFFECT));
assert.ok(wledBasicTier.capabilities.includes(PATTERN_TARGETS.WLED_PRESET));

const advancedTier = getRuntimeTier(ADVANCED_ARTNET_TIER_ID);
assert.equal(advancedTier.id, 'advanced-artnet');
assert.equal(advancedTier.requiresPiAtRuntime, 'optional');
assert.ok(advancedTier.capabilities.includes(PATTERN_TARGETS.ARTNET_STREAM));
assert.ok(advancedTier.capabilities.includes(PATTERN_TARGETS.STANDALONE_SEQUENCE));

assert.equal(
  recommendRuntimeTier({ wantsStoredLooks: true, needsExactTimeline: false, needsLiveArtNet: false }).id,
  WLED_BASIC_TIER_ID,
);
assert.equal(
  recommendRuntimeTier({ wantsStoredLooks: true, needsExactTimeline: true, needsLiveArtNet: false }).id,
  ADVANCED_ARTNET_TIER_ID,
);
assert.equal(
  recommendRuntimeTier({ wantsStoredLooks: false, needsExactTimeline: false, needsLiveArtNet: true }).id,
  ADVANCED_ARTNET_TIER_ID,
);

const candleTargets = inferPatternTargets(PATTERNS.find(pattern => pattern.id === 'candle'));
assert.ok(candleTargets.includes(PATTERN_TARGETS.WLED_CUSTOM_EFFECT));
assert.ok(candleTargets.includes(PATTERN_TARGETS.STANDALONE_PROCEDURAL));
assert.equal(
  recommendRuntimeTier({ wantsStoredLooks: true, patternTargets: candleTargets }).id,
  WLED_BASIC_TIER_ID,
);
const candleCompatibility = describePatternCompatibility(PATTERNS.find(pattern => pattern.id === 'candle'));
assert.equal(candleCompatibility.bestTier.id, WLED_BASIC_TIER_ID);
assert.match(candleCompatibility.summary, /stored on WLED/i);

const heartbeatTargets = inferPatternTargets(PATTERNS.find(pattern => pattern.id === 'heartbeat'));
assert.ok(heartbeatTargets.includes(PATTERN_TARGETS.ARTNET_STREAM));
assert.ok(heartbeatTargets.includes(PATTERN_TARGETS.STANDALONE_SEQUENCE));
assert.equal(describePatternCompatibility(PATTERNS.find(pattern => pattern.id === 'heartbeat')).bestTier.id, ADVANCED_ARTNET_TIER_ID);

const heartbeatPattern = PATTERNS.find(pattern => pattern.id === 'heartbeat');
const heartbeatCompiled = compile(heartbeatPattern.code);
const heartbeatPeak = evalPixel(heartbeatCompiled.fn, 0, 0, 0, 0, 0, 43, palette, 0, 0, { hue: 0 }, 'strip-1', 0);
const heartbeatRest = evalPixel(heartbeatCompiled.fn, 0, 0, 0, 0.4, 0.4, 43, palette, 0.4, 0, { hue: 0 }, 'strip-1', 0);
assert.ok(heartbeatPeak.r >= 240 && heartbeatPeak.g <= 3 && heartbeatPeak.b <= 3, 'heartbeat peak should be bright red');
assert.ok(heartbeatRest.r >= 10 && heartbeatRest.g <= 3 && heartbeatRest.b <= 3, 'heartbeat rest should stay dim red instead of disappearing');

assert.equal(shouldRunBackgroundPatternOutput('layout'), true);
assert.equal(shouldRunBackgroundPatternOutput('settings'), true);
assert.equal(shouldRunBackgroundPatternOutput('pattern'), false);
assert.equal(shouldRunBackgroundPatternOutput('live'), false);
assert.equal(shouldRunBackgroundPatternOutput('timeline'), false);

assert.equal(shouldRebuildStripPixels({ pathData: 'M 0 0 L 10 0', pixelCount: 43, pixels: Array.from({ length: 41 }) }), true);
assert.equal(shouldRebuildStripPixels({ pathData: 'M 0 0 L 10 0', pixelCount: 43, pixels: Array.from({ length: 43 }) }), false);
assert.equal(shouldRebuildStripPixels({ pathData: 'M 0 0 L 10 0', pixelCount: 43, pixels: [] }), true);

const compatibilityAudit = auditPatternCompatibility(PATTERNS);
assert.equal(compatibilityAudit.length, PATTERNS.length);
assert.equal(compatibilityAudit.every(item => item.patternId && item.gate && item.allowedRuntimes.length > 0), true);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'candle')).gate, PATTERN_COMPATIBILITY_GATES.WLED_STOCK);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'ember')).gate, PATTERN_COMPATIBILITY_GATES.WLED_CUSTOM_PORT);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'bass-pulse')).gate, PATTERN_COMPATIBILITY_GATES.AUDIO_SOURCE);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'strobe-bpm')).gate, PATTERN_COMPATIBILITY_GATES.BEAT_SOURCE);
assert.equal(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'mandelbrot')).gate, PATTERN_COMPATIBILITY_GATES.COMPUTER_RENDER);
assert.ok(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'bass-pulse')).allowedRuntimes.includes('computer-live'));
assert.ok(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'bass-pulse')).allowedRuntimes.includes('artnet'));
assert.ok(getPatternCompatibilityGate(PATTERNS.find(pattern => pattern.id === 'ember')).allowedRuntimes.includes('wled-custom'));
const compatibilitySummary = summarizePatternCompatibility(compatibilityAudit);
assert.equal(Object.values(compatibilitySummary.gates).reduce((sum, count) => sum + count, 0), PATTERNS.length);
assert.ok(compatibilitySummary.gates[PATTERN_COMPATIBILITY_GATES.WLED_STOCK] >= 12);
assert.ok(compatibilitySummary.gates[PATTERN_COMPATIBILITY_GATES.AUDIO_SOURCE] >= 10);
assert.ok(compatibilitySummary.gates[PATTERN_COMPATIBILITY_GATES.COMPUTER_RENDER] >= 1);

const basicPatternIds = collectWledBasicPatternIds({
  activePatternId: 'candle',
  showClips: [{ patternId: 'heartbeat' }, { patternId: 'aurora' }],
  strips: [{ patternId: 'twinkle' }],
  minBankSize: 4,
});
assert.deepEqual(basicPatternIds.slice(0, 4), ['candle', 'aurora', 'twinkle', 'breathe']);
assert.equal(basicPatternIds.includes('heartbeat'), false);
assert.deepEqual(collectWledBasicPatternIds({ patternIds: ['plasma', 'mandelbrot'] }), ['plasma']);

const wledBasicPackage = buildWledBasicPackage({
  projectName: 'Bench Piece',
  activePatternId: 'candle',
  showClips: [{ patternId: 'aurora' }, { patternId: 'heartbeat' }],
  strips: [
    { id: 'outer', name: 'Outer', pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
    { id: 'inner', name: 'Inner', patternId: 'twinkle', pixels: [{ x: 0.5, y: 0.5 }] },
  ],
  palette: ['#ffb15c', '#271006', '#ffd7a0'],
  duration: 120,
  loop: true,
});
assert.equal(wledBasicPackage.format, 'wled-basic-package');
assert.equal(wledBasicPackage.runtimeTier, WLED_BASIC_TIER_ID);
assert.equal(wledBasicPackage.presets[0].patternId, 'candle');
assert.equal(wledBasicPackage.presets[0].effectName, 'Candle');
assert.equal(wledBasicPackage.presets[0].segments.length, 2);
assert.equal(wledBasicPackage.presets[0].segments[0].n, 'Outer');
assert.equal(wledBasicPackage.presets[0].segments[1].start, 2);
assert.equal(wledBasicPackage.playlistPresetId, wledBasicPackage.presets.length + 1);
assert.deepEqual(wledBasicPackage.presetsJson[String(wledBasicPackage.playlistPresetId)].playlist.ps, wledBasicPackage.presets.map(preset => preset.presetId));
assert.equal(wledBasicPackage.customEffectPorts.some(pattern => pattern.patternId === 'twinkle'), false);
assert.equal(buildWledBasicPackage({
  projectName: 'Port Piece',
  activePatternId: 'ember',
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
}).customEffectPorts.some(pattern => pattern.patternId === 'ember'), true);
const browserFirstPackage = buildWledBasicPackage({
  projectName: 'Browser First Piece',
  activePatternId: 'ember',
  showClips: [
    { patternId: 'calm' },
    { patternId: 'bloom' },
    { patternId: 'wave' },
    { patternId: 'smoke' },
    { patternId: 'galaxy' },
    { patternId: 'zen' },
    { patternId: 'comet' },
  ],
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
});
assert.ok(browserFirstPackage.presets.length >= 8, 'browser-first WLED package needs at least 8 runnable stock presets');
assert.ok(browserFirstPackage.customEffectPorts.some(pattern => pattern.patternId === 'ember'));
assert.equal(browserFirstPackage.presets.every(preset => preset.compatibility === 'stock-wled-preset'), true);
assert.equal(wledBasicPackage.unsupportedPatterns.some(pattern => pattern.patternId === 'heartbeat'), true);
assert.equal(wledBasicPackage.unsupportedPatterns.find(pattern => pattern.patternId === 'heartbeat').gate, PATTERN_COMPATIBILITY_GATES.BEAT_SOURCE);
assert.equal(wledBasicPackage.compatibilityAudit.length >= wledBasicPackage.presets.length, true);
assert.equal(wledBasicPackage.gateSummary.gates[PATTERN_COMPATIBILITY_GATES.WLED_STOCK] >= wledBasicPackage.presets.length, true);
assert.ok(wledBasicPackage.install.applyViaJsonApi.includes('POST /json/state'));
assert.ok(wledBasicPackage.install.restorePresetsJson.includes('/edit'));

const candleStudio = makePatternStudioSummary(PATTERNS.find(pattern => pattern.id === 'candle'), {
  params: { flicker: 0.42 },
  palette: ['#ffb15c', '#271006', '#ffd7a0'],
  targetRuntime: 'wled-basic',
});
assert.equal(candleStudio.compatibility.gate, PATTERN_COMPATIBILITY_GATES.WLED_STOCK);
assert.equal(candleStudio.installability, 'ready');
assert.ok(candleStudio.qualityScore >= 80);
assert.equal(candleStudio.controls.paramCount > 0, true);
assert.equal(candleStudio.nextActions[0].id, 'save-wled-preset');

const emberStudio = makePatternStudioSummary(PATTERNS.find(pattern => pattern.id === 'ember'), {
  targetRuntime: 'wled-basic',
});
assert.equal(emberStudio.compatibility.gate, PATTERN_COMPATIBILITY_GATES.WLED_CUSTOM_PORT);
assert.equal(emberStudio.installability, 'port-required');
assert.ok(emberStudio.nextActions.some(action => action.id === 'port-custom-effect'));

const bassStudio = makePatternStudioSummary(PATTERNS.find(pattern => pattern.id === 'bass-pulse'), {
  targetRuntime: 'wled-basic',
});
assert.equal(bassStudio.installability, 'runtime-only');
assert.ok(bassStudio.nextActions.some(action => action.id === 'gate-advanced'));

const customOnlyPattern = {
  id: 'gallery-idle-custom',
  name: 'Gallery Idle Custom',
  runtimeTargets: [PATTERN_TARGETS.WLED_CUSTOM_EFFECT],
};
const customPackage = buildWledBasicPackage({
  projectName: 'Custom Basic',
  patterns: [customOnlyPattern],
  patternIds: ['gallery-idle-custom'],
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
});
assert.equal(customPackage.presets.length, 0);
assert.deepEqual(customPackage.customEffectPorts.map(item => item.patternId), ['gallery-idle-custom']);

const presetJson = makeWledBasicPresetsJson({
  presets: wledBasicPackage.presets.slice(0, 2),
  playlistName: 'Bench Cycle',
  playlistPresetId: 10,
  presetDurationSeconds: 12,
  transitionMs: 900,
  repeat: 0,
});
assert.equal(presetJson['10'].n, 'Bench Cycle');
assert.deepEqual(presetJson['10'].playlist.dur, [120, 120]);
assert.deepEqual(presetJson['10'].playlist.transition, [9, 9]);
const migratedV1 = migrateProject({
  version: 1,
  name: 'Legacy',
  strips: [{ id: 's1', name: 'Strip 1', pixelCount: 2, pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
  showClips: [{ id: 'c', track: 0, patternId: 'aurora', start: 0, end: 1 }],
});
assert.equal(migratedV1.version, PROJECT_VERSION);
assert.match(migratedV1.id, /^lwproj-/);
assert.equal(migratedV1.layout.strips.length, 1);
assert.equal(migratedV1.show.clips.length, 1);
const migratedV3 = migrateProject({
  version: PROJECT_VERSION,
  id: 'lwproj-hardware',
  name: 'Hardware',
  devices: { wledIp: '192.168.4.22', segmentMap: { s1: 2 } },
});
assert.equal(migratedV3.id, 'lwproj-hardware');
assert.equal(migratedV3.devices.wledIp, '192.168.4.22');
assert.deepEqual(migratedV3.devices.segmentMap, { s1: 2 });
assert.deepEqual(migratedV3.devices.controllerProfiles, []);
assert.deepEqual(migratedV3.devices.physicalControls, DEFAULT_WLED_PHYSICAL_CONTROLS);
assert.equal(migratedV3.devices.standaloneController.outputs.length, 4);
assert.equal(migratedV3.pattern.symSettings.guide.mode, 'fold');
assert.equal(migrateProject({ version: PROJECT_VERSION, pattern: { motionSmoothing: 'silk' } }).pattern.motionSmoothing, 'silk');
assert.equal(migrateProject({ version: PROJECT_VERSION, pattern: { motionSmoothing: 'invalid' } }).pattern.motionSmoothing, 'soft');
assert.equal(migrateProject({ version: 2, motionSmoothing: 'off' }).pattern.motionSmoothing, 'off');
assert.equal(migrateProject({
  version: PROJECT_VERSION,
  devices: {
    standaloneController: {
      outputs: [{ id: 'outer', name: 'Outer', pin: 32, pixels: 144 }],
      controls: { blackout: 12 },
    },
  },
}).devices.standaloneController.controls.blackout, 12);

const guideAxis = { x1: 0.5, y1: 0, x2: 0.5, y2: 1 };
const guideFold = applySymmetry(0.25, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: guideAxis } });
assert.equal(guideFold.x, 0.5);
assert.equal(guideFold.y, 0.4);
assert.equal(guideFold.progress, 0.5);
const guideReflectLeft = applySymmetry(0.25, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'reflect', axis: guideAxis } });
assert.equal(guideReflectLeft.x, 0.5);
assert.equal(guideReflectLeft.y, 0.4);
const guideReflectRight = applySymmetry(0.75, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'reflect', axis: guideAxis } });
assert.equal(guideReflectRight.x, 0.5);
assert.equal(guideReflectRight.y, 0.4);
const guideSplit = applySymmetry(0.25, 0.4, { enabled: true, type: 'guide-mirror', guide: { mode: 'split', axis: guideAxis } });
assert.equal(guideSplit.split, true);

const guideProgressFn = compile('return rgb(stripProgress, 0, 0);').fn;
const guideProgressFrame = renderPixelFrame({
  t: 0,
  strips: [{
    id: 'guide-strip',
    pts: [
      { x: 0, y: 0.5, p: 0 },
      { x: 0.5, y: 0.5, p: 0.5 },
      { x: 1, y: 0.5, p: 1 },
    ],
  }],
  activeFn: guideProgressFn,
  symSettings: { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: guideAxis } },
});
assert.deepEqual(guideProgressFrame.pixels.map(px => px.r), [255, 0, 255]);

const guideIndexFn = compile('return rgb(index / max(pixelCount - 1, 1), 0, 0);').fn;
const guideIndexFrame = renderPixelFrame({
  t: 0,
  strips: [{
    id: 'guide-index-strip',
    pts: [
      { x: 0, y: 0.5, p: 0 },
      { x: 0.5, y: 0.5, p: 0.5 },
      { x: 1, y: 0.5, p: 1 },
    ],
  }],
  activeFn: guideIndexFn,
  symSettings: { enabled: true, type: 'guide-mirror', guide: { mode: 'fold', axis: guideAxis } },
});
assert.deepEqual(guideIndexFrame.pixels.map(px => px.r), [255, 0, 255]);

const timelineClips = [
  { id: 'a', track: 0, patternId: 'aurora', start: 0, end: 10 },
  { id: 'b', track: 0, patternId: 'ember', start: 12, end: 22 },
  { id: 'c', track: 1, patternId: 'wave', start: 8, end: 18 },
];
assert.deepEqual(clampClipMove(timelineClips, 'a', 8, 40), { start: 2, end: 12 });
assert.deepEqual(clampClipMove(timelineClips, 'b', 1, 40), { start: 10, end: 20 });
assert.deepEqual(clampClipMove(timelineClips, 'c', 2, 40), { start: 2, end: 12 });
assert.deepEqual(clampClipResize(timelineClips, 'a', 'end', 16, 40), { start: 0, end: 12 });
assert.deepEqual(clampClipResize(timelineClips, 'b', 'start', 4, 40), { start: 10, end: 22 });
assert.deepEqual(
  placeClipInTrackGap(timelineClips, { track: 0, preferredStart: 9, duration: 30, showDuration: 40 }),
  { start: 22, end: 40 },
);
const overlappingTimelineClips = [
  { id: 'a', track: 0, patternId: 'calm', start: 0, end: 10 },
  { id: 'b', track: 0, patternId: 'aurora', start: 8, end: 18 },
];
assert.deepEqual(clampClipMove(overlappingTimelineClips, 'a', 4, 40), { start: 0, end: 10 });
assert.deepEqual(clampClipResize(overlappingTimelineClips, 'a', 'end', 14, 40), { start: 0, end: 10 });

const liveFirst = recordLivePattern({
  clips: [],
  transitions: [],
  patternId: 'aurora',
  at: 3.1,
  crossfadeSecs: 2,
  showDuration: 60,
});
assert.equal(liveFirst.clips.length, 1);
assert.deepEqual(liveFirst.clips[0], {
  id: 'live_3100_aurora',
  track: 0,
  patternId: 'aurora',
  start: 3.1,
  end: 60,
  label: 'aurora',
  recorded: true,
});
assert.deepEqual(liveFirst.transitions, []);

const liveSecond = recordLivePattern({
  clips: liveFirst.clips,
  transitions: liveFirst.transitions,
  patternId: 'ember',
  at: 10,
  crossfadeSecs: 3,
  showDuration: 60,
});
assert.equal(liveSecond.clips.find(c => c.patternId === 'aurora').end, 13);
assert.equal(liveSecond.clips.find(c => c.patternId === 'ember').start, 10);
assert.equal(liveSecond.clips.find(c => c.patternId === 'ember').end, 60);
assert.deepEqual(liveSecond.transitions, [{
  id: 'live_10000_ember_xfade',
  clipA: 'live_3100_aurora',
  clipB: 'live_10000_ember',
  type: 'crossfade',
  curve: 'ease-in-out',
  start: 10,
  end: 13,
  recorded: true,
}]);

const liveBeat = recordLivePattern({
  clips: [],
  transitions: [],
  patternId: 'wave',
  at: 10.31,
  bpm: 120,
  quantize: 'beat',
  crossfadeSecs: 1,
  showDuration: 60,
});
assert.equal(liveBeat.clips[0].start, 10.5);

const liveSameMoment = recordLivePattern({
  clips: liveFirst.clips,
  transitions: liveFirst.transitions,
  patternId: 'ember',
  at: 3.1,
  crossfadeSecs: 2,
  showDuration: 60,
});
assert.equal(liveSameMoment.clips.length, 2);
assert.equal(liveSameMoment.transitions.length, 1);
assert.equal(liveSameMoment.transitions[0].clipA, 'live_3100_aurora');
assert.equal(liveSameMoment.transitions[0].clipB, 'live_3100_ember');

const frame = renderPixelFrame({
  t: 0.2,
  strips: [{
    id: 's1',
    pts: [{ x: 0, y: 0, p: 0 }, { x: 1, y: 0, p: 1 }],
  }],
  patternId: 'aurora',
  paletteNorm: palette,
});
assert.equal(frame.pixels.length, 2);
assert.equal(frame.stripFrames.length, 1);
frame.pixels.forEach(px => {
  assert.ok(Number.isFinite(px.r) && Number.isFinite(px.g) && Number.isFinite(px.b));
});

const { fn: indexPatternFn } = compile('return rgb(index / max(1, pixelCount - 1), stripProgress, 0);');
const mirroredIndexFrame = renderPixelFrame({
  t: 0.2,
  strips: [{
    id: 'quad',
    pts: [
      { x: 0.25, y: 0.25, p: 0 },
      { x: 0.75, y: 0.25, p: 0.33 },
      { x: 0.25, y: 0.75, p: 0.66 },
      { x: 0.75, y: 0.75, p: 1 },
    ],
  }],
  activeFn: indexPatternFn,
  symSettings: { enabled: true, type: 'mirror-hv' },
});
assert.deepEqual(
  mirroredIndexFrame.pixels.map(px => [px.r, px.g]),
  [[170, 159], [170, 159], [170, 159], [170, 159]],
  'mirror-hv should mirror index and stripProgress driven patterns, not only x/y driven patterns',
);

const { fn: journeyColorFn } = compile('return rgb(0, 0, fract(t));');
const journeyColorFrame = renderPixelFrame({
  t: 5,
  strips: [{ id: 's', pts: [{ x: 0, y: 0, p: 0 }] }],
  activeFn: journeyColorFn,
  params: {
    __journey: {
      enabled: true,
      duration: 10,
      colorMix: 1,
      colorStops: ['#ffff00', '#ff8000', '#ffffff'],
      saturationStart: 1,
      saturationEnd: 0.25,
      speedStart: 1,
      speedEnd: 3,
    },
  },
});
assert.ok(
  journeyColorFrame.pixels[0].r > journeyColorFrame.pixels[0].b,
  'pattern journey should steer dark pixels toward the current journey color',
);
assert.ok(
  journeyColorFrame.pixels[0].r < 140,
  'pattern journey mix should not replace dark source pixels with a full-bright wash',
);

const { fn: journeyDetailFn } = compile('return hsv(index / max(1, pixelCount), 1, 1);');
const journeyDetailFrame = renderPixelFrame({
  t: 2,
  strips: [{
    id: 'detail',
    pts: [
      { x: 0, y: 0, p: 0 },
      { x: 0.2, y: 0, p: 0.2 },
      { x: 0.4, y: 0, p: 0.4 },
      { x: 0.6, y: 0, p: 0.6 },
      { x: 0.8, y: 0, p: 0.8 },
      { x: 1, y: 0, p: 1 },
    ],
  }],
  activeFn: journeyDetailFn,
  params: {
    __journey: {
      enabled: true,
      duration: 10,
      easing: 'linear',
      colorMix: 1,
      colorStops: ['#ffd000', '#ffd000'],
      saturationStart: 1,
      saturationEnd: 1,
      speedStart: 1,
      speedEnd: 1,
    },
  },
});
assert.ok(
  new Set(journeyDetailFrame.pixels.map(px => `${px.r},${px.g},${px.b}`)).size >= 4,
  'journey mix should keep multicolor pattern detail instead of collapsing every pixel to the journey color',
);

const { fn: journeyLoopFn } = compile('return rgb(0, 0, 0);');
const journeyLoopFrame = renderPixelFrame({
  t: 9,
  strips: [{ id: 's', pts: [{ x: 0, y: 0, p: 0 }] }],
  activeFn: journeyLoopFn,
  params: {
    __journey: {
      enabled: true,
      duration: 10,
      easing: 'linear',
      colorMix: 1,
      colorStops: ['#ff0000', '#0000ff'],
      saturationStart: 1,
      saturationEnd: 1,
      speedStart: 1,
      speedEnd: 1,
    },
  },
});
assert.ok(
  journeyLoopFrame.pixels[0].r > journeyLoopFrame.pixels[0].b,
  'repeat color journey should blend from the last stop back to the first stop before restarting',
);

const { fn: journeySpeedFn } = compile('return rgb(fract(t), 0, 0);');
const journeySpeedFrame = renderPixelFrame({
  t: 0.25,
  strips: [{ id: 's', pts: [{ x: 0, y: 0, p: 0 }] }],
  activeFn: journeySpeedFn,
  params: {
    __journey: {
      enabled: true,
      duration: 1,
      colorMix: 0,
      easing: 'linear',
      speedStart: 1,
      speedEnd: 3,
    },
  },
});
assert.deepEqual(
  journeySpeedFrame.pixels[0],
  { r: 96, g: 0, b: 0 },
  'pattern journey should ramp motion speed inside one running pattern',
);

assert.deepEqual(
  smoothPixelFrame([{ r: 100, g: 50, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'off', dt: 1 / 60 }),
  [{ r: 100, g: 50, b: 0 }],
);
const softFrame = smoothPixelFrame([{ r: 100, g: 0, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'soft', dt: 1 / 60 });
assert.ok(softFrame[0].r > 0 && softFrame[0].r < 100, 'soft smoothing moves toward target without overshoot');
const silkFrame = smoothPixelFrame([{ r: 100, g: 0, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'silk', dt: 1 / 60 });
assert.ok(silkFrame[0].r > 0 && silkFrame[0].r < softFrame[0].r, 'silk smoothing is slower than soft');
assert.deepEqual(
  smoothPixelFrame([{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }], [{ r: 0, g: 0, b: 0 }], { mode: 'silk', dt: 1 / 60 }),
  [{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }],
);
assert.equal(easeCrossfade(0, 'ease-in-out'), 0);
assert.equal(easeCrossfade(1, 'ease-in-out'), 1);
assert.equal(easeCrossfade(-1, 'ease-in-out'), 0);
assert.equal(easeCrossfade(2, 'ease-in-out'), 1);
assert.equal(easeCrossfade(0.5, 'linear'), 0.5);
assert.ok(easeCrossfade(0.25, 'ease-in-out') < 0.25);
assert.ok(easeCrossfade(0.75, 'ease-in-out') > 0.75);
assert.equal(formatMotionSpeed(0.03), '0.03x');
assert.equal(formatMotionSpeed(1), '1.0x');

assert.deepEqual(makeBlackoutFrame(2), [{ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }]);
assert.deepEqual(makeBlackoutFrame(-1), []);
assert.deepEqual(makeWledFrameMessage([{ r: 1.2, g: 2.8, b: 300 }]).seg[0].i, ['0103FF']);
assert.deepEqual(makeWledFrameMessage([{ r: -5, g: Number.NaN, b: 12.4 }]).seg[0].i, ['00000C']);
assert.throws(
  () => makeWledFrameMessage([{ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }], { maxPixels: 1 }),
  /max 1/,
);
assert.deepEqual(makeWledSegments([{ id: 'a', pixels: [1, 2] }, { id: 'b', pixelCount: 3 }], { b: 4 }), [
  { id: 0, start: 0, stop: 2, on: true },
  { id: 4, start: 2, stop: 5, on: true },
]);
assert.deepEqual(makeWledSegments([{ id: 'z', pixelCount: 0 }, { id: 'a', pixelCount: 2 }, { id: 'b', pixels: [1, 2, 3] }], { z: 9, a: 2, b: 3 }), [
  { id: 9, start: 0, stop: 0, on: true },
  { id: 2, start: 0, stop: 2, on: true },
  { id: 3, start: 2, stop: 5, on: true },
]);

assert.equal(makeWledProxyUrl('http://192.168.1.50/json', 'state'), '/api/wled/state?ip=192.168.1.50');
assert.equal(makeWledWsUrl('192.168.1.50', { preferProxy: false }), 'ws://192.168.1.50:81/');
assert.equal(
  makeWledWsUrl('192.168.1.50', { locationObj: { protocol: 'https:', host: 'lightweaver.local' } }),
  'wss://lightweaver.local/api/wled/ws?ip=192.168.1.50&wsPort=81',
);
assert.equal(DEFAULT_WLED_APP_FLASH_ADDRESS, '0x10000');
assert.equal(DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS, '0x0');
assert.deepEqual(validateFlashPlan({ address: '0x10000', eraseAll: false }), { address: 0x10000 });
assert.throws(
  () => validateFlashPlan({ address: '0x10000', eraseAll: true }),
  /merged factory image flashed at 0x0/,
);
assert.deepEqual(
  summarizeWledInfo({
    name: 'WLED',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    ip: '192.168.18.66',
    mac: 'aca704e2ece0',
    freeheap: 230000,
    psram: 8300000,
    wifi: { signal: 86 },
    leds: { count: 30, fps: 2 },
  }, { ip: '192.168.18.66', source: 'probe' }),
  {
    name: 'WLED',
    ip: '192.168.18.66',
    source: 'probe',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    mac: 'aca704e2ece0',
    leds: 30,
    fps: 2,
    signal: 86,
    freeheap: 230000,
    psram: 8300000,
    uptime: null,
    healthy: true,
  },
);
assert.equal(
  pickBestWledDevice([
    { ip: '192.168.18.10', source: 'scan', healthy: true },
    { ip: '192.168.18.66', source: 'default', healthy: true },
  ], '192.168.18.66').ip,
  '192.168.18.66',
);
assert.deepEqual(
  sortWledDevices([
    { ip: '192.168.18.10', source: 'scan', signal: 45, healthy: true },
    { ip: '192.168.18.11', source: 'mdns', signal: 80, healthy: true },
    { ip: '192.168.18.12', source: 'scan', healthy: false },
  ]).map(d => d.ip),
  ['192.168.18.11', '192.168.18.10', '192.168.18.12'],
);
assert.deepEqual(makeSafeWledTestState('blue'), {
  on: true,
  bri: 32,
  transition: 0,
  seg: [{ id: 0, fx: 0, col: [[0, 80, 255], [0, 0, 0], [0, 0, 0]] }],
});
const profile = buildControllerProfile({
  name: 'WLED',
  ver: '0.15.4',
  release: 'ESP32-S3_16MB_opi',
  arch: 'ESP32-S3',
  ip: '192.168.18.66',
  mac: 'aca704e2ece0',
  flash: 16,
  psram: 8300000,
  leds: { count: 30 },
}, {
  led: { type: 'WS2815', length: 240, dataPin: 16, colorOrder: 'GRB', maxBrightness: 180 },
  power: { voltage: 12, psuAmps: 10, milliampsPerPixel: 12 },
  artnet: { startUniverse: 0, fps: 40 },
});
assert.equal(profile.id, 'aca704e2ece0');
assert.equal(profile.physicalControls.encoder.enabled, true);
assert.equal(profile.physicalControls.encoder.firmware, WLED_ENCODER_FIRMWARE_MODES.ROTARY_USERMOD);
assert.deepEqual(profile.physicalControls.encoder.pins, { a: 4, b: 5, press: 0 });
assert.equal(makeWledHostname(profile), 'lightweaver-e2ece0.local');
assert.equal(makeDhcpReservationNote(profile), 'Reserve MAC ac:a7:04:e2:ec:e0 as 192.168.18.66.');
assert.deepEqual(estimatePowerBudget(profile), {
  maxAmps: 2.03,
  safeAmps: 8,
  headroomAmps: 5.97,
  status: 'ok',
});
assert.match(makeArtNetNotes(profile), /Universe start: 0/);
assert.match(makeArtNetNotes(profile), /Channels: 720/);
assert.equal(controllerProfileReadiness(profile).ready, false);
assert.deepEqual(makeKnownGoodRecoveryState(), makeSafeWledTestState('amber'));
assert.deepEqual(makePixelMarkerState(5, 4).seg[0].i, ['000000', '000000', '000000', '000000', 'FF4000']);
assert.deepEqual(makePixelCountProbeState(40, 39), {
  pixelCount: 40,
  markerIndex: 39,
  state: makePixelMarkerState(40, 39),
});
assert.deepEqual(makePixelCountProbeState(40, 60), {
  pixelCount: 40,
  markerIndex: 39,
  state: makePixelMarkerState(40, 39),
});
assert.deepEqual(makePixelCountProbeState(40.4, 38.6), {
  pixelCount: 40,
  markerIndex: 39,
  state: makePixelMarkerState(40, 39),
});
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /Lightweaver Install Readiness/);
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /aca704e2ece0/);
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /Physical Controls/);
assert.match(makeInstallReadinessReport(profile, { snapshotSaved: true }), /Rotate: brightness/);

const controllerAudit = auditWledControllerCompatibility({
  info: {
    name: 'WLED',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    ip: '192.168.18.66',
    fxcount: 187,
    palcount: 71,
    time: '1970-1-2, 04:44:22',
    leds: { count: 30, maxseg: 32 },
  },
  state: {
    AudioReactive: { on: false },
    seg: [{ id: 0, start: 0, stop: 30, fx: 0, pal: 0 }],
  },
  cfg: {
    hw: { led: { total: 30, ins: [{ len: 30, pin: [16], order: 0, type: 22 }] } },
    if: { live: { en: true, port: 5568, dmx: { uni: 1, addr: 1, mode: 4 } } },
  },
  presets: { 0: {} },
  ledMap: null,
  expected: {
    pixelCount: 240,
    segmentCount: 4,
    requiresLedMap: true,
    requiresArtNet: true,
    usesAudioPatterns: true,
  },
});
assert.equal(controllerAudit.summary.status, 'needs-configuration');
assert.equal(controllerAudit.actual.ledCount, 30);
assert.equal(controllerAudit.actual.effectCount, 187);
assert.equal(controllerAudit.findings.find(item => item.id === 'firmware').level, CONTROLLER_COMPATIBILITY_LEVELS.READY);
assert.equal(controllerAudit.findings.find(item => item.id === 'led-count').level, CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG);
assert.equal(controllerAudit.findings.find(item => item.id === 'presets').level, CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_INSTALL);
assert.equal(controllerAudit.findings.find(item => item.id === 'led-map').level, CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG);
assert.equal(controllerAudit.findings.find(item => item.id === 'artnet').level, CONTROLLER_COMPATIBILITY_LEVELS.READY);
assert.equal(controllerAudit.findings.find(item => item.id === 'clock').level, CONTROLLER_COMPATIBILITY_LEVELS.NEEDS_CONFIG);
assert.equal(controllerAudit.findings.find(item => item.id === 'audio-source').level, CONTROLLER_COMPATIBILITY_LEVELS.RUNTIME_ONLY);
assert.equal(controllerAudit.runtimeGates.wledBasic.status, 'needs-install');
assert.equal(controllerAudit.runtimeGates.advancedArtNet.status, 'needs-configuration');

const blockedWizardPlan = buildWledInstallWizardPlan({
  controllerAudit,
  wledPackage: wledBasicPackage,
  backupSaved: false,
});
assert.equal(blockedWizardPlan.status, 'blocked');
assert.equal(blockedWizardPlan.canInstall, false);
assert.ok(blockedWizardPlan.blockers.includes('led-count'));
assert.equal(blockedWizardPlan.steps.find(step => step.id === 'backup').state, 'open');
assert.equal(blockedWizardPlan.steps.find(step => step.id === 'geometry').state, 'blocked');

const unauditedWizardPlan = buildWledInstallWizardPlan({
  controllerAudit: null,
  wledPackage: wledBasicPackage,
  backupSaved: true,
});
assert.equal(unauditedWizardPlan.status, 'blocked');
assert.equal(unauditedWizardPlan.canInstall, false);
assert.ok(unauditedWizardPlan.blockers.includes('controller-audit'));
assert.equal(unauditedWizardPlan.nextAction.id, 'run-controller-audit');

const readyControllerAudit = auditWledControllerCompatibility({
  info: {
    name: 'Lightweaver Bench',
    ver: '0.15.4',
    release: 'ESP32-S3_16MB_opi',
    arch: 'ESP32-S3',
    ip: '192.168.18.66',
    fxcount: 187,
    palcount: 71,
    time: '2026-5-25, 12:00:00',
    leds: { count: 3, maxseg: 32 },
  },
  state: { seg: [{ id: 0, start: 0, stop: 3 }] },
  cfg: { hw: { led: { total: 3, ins: [{ len: 3, pin: [16] }] } }, if: { live: { en: true, dmx: { uni: 1, addr: 1, mode: 4 } } } },
  presets: { 0: {} },
  expected: { pixelCount: 3, segmentCount: 1, requiresArtNet: false, requiresLedMap: false },
});
const readyWizardPlan = buildWledInstallWizardPlan({
  controllerAudit: readyControllerAudit,
  wledPackage: wledBasicPackage,
  backupSaved: true,
});
assert.equal(readyWizardPlan.status, 'ready-to-apply');
assert.equal(readyWizardPlan.canInstall, true);
assert.equal(readyWizardPlan.steps.find(step => step.id === 'package').state, 'ready');
assert.equal(readyWizardPlan.packageSummary.presets, wledBasicPackage.presets.length);
assert.equal(readyWizardPlan.packageSummary.customEffectPorts, wledBasicPackage.customEffectPorts.length);

const controlledBasicPackage = buildWledBasicPackage({
  projectName: 'Controlled Bench',
  activePatternId: 'candle',
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
  physicalControls: profile.physicalControls,
});
assert.equal(controlledBasicPackage.controlContract.encoder.enabled, true);
assert.equal(controlledBasicPackage.controlContract.encoder.press.helperPresetId, controlledBasicPackage.playlistPresetId + 1);
assert.equal(
  controlledBasicPackage.presetsJson[String(controlledBasicPackage.controlContract.encoder.press.helperPresetId)].ps,
  '1~ 8~',
);
assert.match(summarizeWledControlContract(controlledBasicPackage.controlContract), /WLED firmware/);

const orderedControlPackage = buildWledBasicPackage({
  projectName: 'Ordered Press Cycle',
  activePatternId: 'fire',
  strips: [{ id: 'main', pixels: [{ x: 0, y: 0 }] }],
  physicalControls: {
    encoder: {
      enabled: true,
      rotateDirection: 'clockwise-dimmer',
      patternCycleIds: ['aurora', 'candle', 'breathe'],
    },
  },
});
assert.deepEqual(orderedControlPackage.presets.map(preset => preset.patternId), ['aurora', 'candle', 'breathe']);
assert.equal(orderedControlPackage.controlContract.controls.encoder.rotateDirection, 'clockwise-dimmer');
assert.equal(orderedControlPackage.controlContract.controls.encoder.patternCycleIds.length, 3);
assert.equal(
  orderedControlPackage.presetsJson[String(orderedControlPackage.controlContract.encoder.press.helperPresetId)].ps,
  '1~ 3~',
);

const controlledWizardPlan = buildWledInstallWizardPlan({
  controllerAudit: readyControllerAudit,
  wledPackage: controlledBasicPackage,
  backupSaved: true,
});
assert.equal(controlledWizardPlan.packageSummary.physicalControls.encoder, true);
assert.equal(controlledWizardPlan.packageSummary.physicalControls.helperPresetId, controlledBasicPackage.controlContract.encoder.press.helperPresetId);
assert.equal(controlledWizardPlan.steps.find(step => step.id === 'physical-controls').state, 'ready');
assert.match(controlledWizardPlan.steps.find(step => step.id === 'physical-controls').detail, /press preset/);

const standaloneOutputs = normalizeStandaloneOutputs([
  { id: 'outer', pin: 16, pixels: 260 },
  { id: 'inner', pin: 17, pixels: 180 },
  { id: '', pin: 18, pixels: -5 },
  { id: 'unused', pin: null, pixels: 0 },
  { id: 'ignored', pin: 21, pixels: 50 },
]);
assert.deepEqual(standaloneOutputs, [
  { id: 'outer', name: 'Outer', pin: 16, pixels: 260 },
  { id: 'inner', name: 'Inner', pin: 17, pixels: 180 },
]);
assert.deepEqual(deriveStandaloneOutputsFromStrips([
  { id: 'outer-zone', name: 'Outer Zone', pixels: [{}, {}, {}] },
  { id: 'inner-zone', name: 'Inner Zone', pixelCount: 2 },
], [
  { id: 'out1', pin: 16, pixels: 0 },
  { id: 'out2', pin: 17, pixels: 0 },
]), [
  { id: 'outer-zone', name: 'Outer Zone', pin: 16, pixels: 3 },
  { id: 'inner-zone', name: 'Inner Zone', pin: 17, pixels: 2 },
]);
assert.deepEqual(deriveStandaloneOutputsFromStrips([
  { id: 's1', pixelCount: 10 },
  { id: 's2', pixelCount: 10 },
  { id: 's3', pixelCount: 10 },
  { id: 's4', pixelCount: 10 },
  { id: 's5', pixelCount: 10 },
]), [
  { id: 'out1', name: 'Output 1', pin: 16, pixels: 20 },
  { id: 'out2', name: 'Output 2', pin: 17, pixels: 10 },
  { id: 'out3', name: 'Output 3', pin: 18, pixels: 10 },
  { id: 'out4', name: 'Output 4', pin: 21, pixels: 10 },
]);
assert.deepEqual(estimateLwseqBytes({ pixels: 440, fps: 24, duration: 10 }), {
  headerBytes: LWSEQ_HEADER_BYTES,
  payloadBytes: 316800,
  totalBytes: 316800 + LWSEQ_HEADER_BYTES,
});

const standaloneProfile = buildStandaloneProfile({
  projectName: 'Spiral 01',
  runtimeMode: 'procedural',
  outputs: standaloneOutputs,
  looks: [{ id: 'ember', label: 'Ember', mode: 'procedural', preset: 'ember', fps: 24 }],
});
assert.equal(standaloneProfile.piece.id, 'spiral-01');
assert.equal(standaloneProfile.runtimeMode, 'procedural');
assert.equal(standaloneProfile.outputs.length, 2);
assert.equal(standaloneProfile.controls.encoder.press, 0);
assert.equal(standaloneProfile.controls.encoder.alternatePress, 6);
assert.equal(standaloneProfile.startupLook, 'ember');
assert.equal(standaloneProfile.looks[0].preset, 'ember');

const lwseq = toLwseqBytes([
  [{ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }],
  [{ r: 7, g: 8, b: 9 }, { r: 10, g: 11, b: 12 }],
], { fps: 24, outputs: [{ id: 'main', pin: 16, pixels: 2 }] });
assert.equal(lwseq.byteLength, LWSEQ_HEADER_BYTES + 12);
assert.equal(String.fromCharCode(...lwseq.slice(0, 6)), 'LWSEQ1');
assert.deepEqual([...lwseq.slice(LWSEQ_HEADER_BYTES)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

const standalonePackage = makeStandalonePackage({
  projectName: 'Spiral 01',
  outputs: [{ id: 'main', pin: 16, pixels: 1 }],
  sequenceFilename: '001-ember.lwseq',
  frames: [[{ r: 1, g: 2, b: 3 }]],
  fps: 24,
});
assert.equal(standalonePackage.files['/lightweaver.json'].piece.name, 'Spiral 01');
assert.equal(standalonePackage.files['/sequences/001-ember.lwseq'].encoding, 'base64');
assert.equal(standalonePackage.files['/sequences/001-ember.lwseq'].bytes, LWSEQ_HEADER_BYTES + 3);

const proceduralPackage = makeStandalonePackage({
  projectName: 'Spiral 01',
  runtimeMode: 'procedural',
  outputs: [{ id: 'main', pin: 16, pixels: 12 }],
  proceduralPreset: 'aurora',
  frames: [[{ r: 255, g: 0, b: 0 }]],
});
assert.equal(proceduralPackage.files['/lightweaver.json'].runtimeMode, 'procedural');
assert.equal(proceduralPackage.files['/lightweaver.json'].looks[0].mode, 'procedural');
assert.equal(proceduralPackage.files['/lightweaver.json'].looks[0].preset, 'aurora');
assert.equal(Object.keys(proceduralPackage.files).length, 1);

const presetPackage = makeStandalonePackage({
  projectName: 'Spiral 01',
  runtimeMode: 'preset',
  outputs: [{ id: 'main', pin: 16, pixels: 12 }],
  preset: 'warm-white',
});
assert.equal(presetPackage.files['/lightweaver.json'].runtimeMode, 'preset');
assert.equal(presetPackage.files['/lightweaver.json'].looks[0].mode, 'preset');
assert.equal(presetPackage.files['/lightweaver.json'].looks[0].preset, 'warm-white');
assert.equal(Object.keys(presetPackage.files).length, 1);

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  };
}

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

{
  const calls = [];
  const data = await requestWledJson('192.168.1.51', 'state', {
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method });
      return jsonResponse(200, { on: true });
    },
  });
  assert.deepEqual(data, { on: true });
  assert.equal(calls[0].url, '/api/wled/state?ip=192.168.1.51');
}

{
  const calls = [];
  const data = await requestWledJson('192.168.1.52', 'info', {
    fetchImpl: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? textResponse(200, '<!doctype html><div>Vite fallback</div>')
        : jsonResponse(200, { ver: '0.15.4' });
    },
  });
  assert.deepEqual(data, { ver: '0.15.4' });
  assert.deepEqual(calls, ['/api/wled/info?ip=192.168.1.52', 'http://192.168.1.52/json/info']);
}

{
  let calls = 0;
  await assert.rejects(
    () => requestWledJson('192.168.1.53', 'state', {
      method: 'POST',
      body: { on: false },
      fetchImpl: async () => {
        calls++;
        return jsonResponse(500, { error: 'state rejected' });
      },
    }),
    /HTTP 500/,
  );
  assert.equal(calls, 1, 'Pi API WLED failures should not be hidden by direct fallback');
}

{
  await assert.rejects(
    () => requestWledJson('192.168.1.54', 'state', {
      method: 'POST',
      body: { on: true },
      preferProxy: false,
      fetchImpl: async () => jsonResponse(503, { error: 'offline' }),
    }),
    /HTTP 503/,
  );
}

console.log('project-frame-audit passed');
