import assert from 'node:assert/strict';
import { PATTERNS } from '../src/lib/patterns-library.js';
import { compile, evalPixel } from '../src/lib/patterns.js';
import { createDefaultProject, migrateProject, PROJECT_VERSION } from '../src/lib/projectModel.js';
import { compilePattern, normalizePalette, renderPixelFrame } from '../src/lib/frameEngine.js';
import { makeBlackoutFrame, makeWledFrameMessage, makeWledSegments } from '../src/lib/deviceController.js';
import {
  easeCrossfade,
  formatMotionSpeed,
  smoothPixelFrame,
} from '../src/lib/motionSmoothing.js';
import {
  CUSTOM_PATTERNS_EVENT,
  CUSTOM_PATTERNS_KEY,
  CUSTOM_PATTERN_REVISIONS_KEY,
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
assert.deepEqual(defaultProject.devices, { wledIp: '', segmentMap: {} });
assert.equal(defaultProject.pattern.motionSmoothing, 'soft');
const migratedV1 = migrateProject({
  version: 1,
  name: 'Legacy',
  strips: [{ id: 's1', name: 'Strip 1', pixelCount: 2, pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
  showClips: [{ id: 'c', track: 0, patternId: 'aurora', start: 0, end: 1 }],
  motionSmoothing: 'off',
});
assert.equal(migratedV1.version, PROJECT_VERSION);
assert.equal(migratedV1.layout.strips.length, 1);
assert.equal(migratedV1.show.clips.length, 1);
assert.equal(migratedV1.pattern.motionSmoothing, 'off');
const migratedV3 = migrateProject({
  version: PROJECT_VERSION,
  name: 'Hardware',
  pattern: { motionSmoothing: 'silk' },
  devices: { wledIp: '192.168.4.22', segmentMap: { s1: 2 } },
});
assert.equal(migratedV3.devices.wledIp, '192.168.4.22');
assert.deepEqual(migratedV3.devices.segmentMap, { s1: 2 });
assert.equal(migratedV3.pattern.motionSmoothing, 'silk');
assert.equal(migrateProject({ version: PROJECT_VERSION, pattern: { motionSmoothing: 'invalid' } }).pattern.motionSmoothing, 'soft');

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
assert.deepEqual(makeWledFrameMessage([{ r: 1.2, g: 2.8, b: 300 }]).seg[0].i, [1, 3, 255]);
assert.deepEqual(makeWledSegments([{ id: 'a', pixels: [1, 2] }, { id: 'b', pixelCount: 3 }], { b: 4 }), [
  { id: 0, start: 0, stop: 2, on: true },
  { id: 4, start: 2, stop: 5, on: true },
]);

console.log('project-frame-audit passed');
