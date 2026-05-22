import { compile } from './patterns.js';
import { normalizePalette, renderPixelFrame } from './frameEngine.js';
import { parseParamsFromCode } from './patternParams.js';

const REQUIRED_STRING_FIELDS = ['name', 'description', 'code'];
const UNSAFE_TOKEN_RE = /\b(fetch|XMLHttpRequest|localStorage|sessionStorage|document|window|Function|eval|import|require|WebSocket|Worker|this|globalThis|self|constructor|prototype|__proto__|function|class|new|async|await|while|for|do|Array|Object|Reflect|Proxy|Map|Set|WeakMap|WeakSet|Promise|setTimeout|setInterval)\b/;
const UNSAFE_METHOD_RE = /\.(fill|map|filter|reduce|flatMap|from|of)\b/;
const IDENTIFIER_RE = /\b[A-Za-z_$][\w$]*\b/g;
const NUMERIC_LITERAL_RE = /(?<![\w$])(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?![\w$])/g;
const NON_ASCII_OR_CONTROL_RE = /[^\x09\x0a\x0d\x20-\x7e]/;
const BACKSLASH_RE = /\\/;
const BRACKET_RE = /[\[\]]/;
const ARROW_FUNCTION_RE = /=>/;
const BIGINT_LITERAL_RE = /\b\d+n\b/;
const SHIFT_OPERATOR_RE = />>>|<<|>>/;
const STRING_LITERAL_RE = /["'`]/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const AI_DRAFT_PATTERN_ID = '__ai_draft__';
const FBM_OCTAVE_LIMIT = 12;
const PARAM_VALUE_LIMIT = 100000;
const SAFE_PATTERN_THIS = Object.freeze(Object.create(null));
const ALLOWED_IDENTIFIERS = new Set([
  'index', 'x', 'y', 't', 'time', 'pixelCount', 'palette', 'beat', 'beatSin', 'params',
  'stripId', 'stripProgress', 'bass', 'mid', 'hi',
  'hsv', 'rgb', 'wave', 'triangle', 'square', 'clamp', 'lerp', 'fract', 'abs', 'floor',
  'ceil', 'int', 'float', 'min', 'max', 'pow', 'sqrt', 'exp', 'log', 'tan', 'atan2',
  'round', 'map', 'step', 'smoothstep', 'mix', 'mod', 'vec2', 'length', 'distance',
  'sin', 'cos', 'noise', 'randomF', 'ping', 'easeIn', 'easeOut', 'easeInOut', 'norm',
  'polar', 'fbm', 'samplePalette',
  'const', 'let', 'if', 'else', 'return', 'throw', 'true', 'false', 'null', 'undefined',
]);

export function normalizeDraftPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: { kind: 'invalid-shape', message: 'Draft response must be an object.' } };
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) {
      return { ok: false, error: { kind: 'invalid-shape', message: `Draft is missing ${field}.` } };
    }
  }
  const changeSummary = Array.isArray(raw.changeSummary)
    ? raw.changeSummary.map(item => String(item).trim()).filter(Boolean)
    : [];
  if (changeSummary.length < 1 || changeSummary.length > 6) {
    return { ok: false, error: { kind: 'invalid-shape', message: 'Draft needs 1 to 6 change summary entries.' } };
  }
  if (!Array.isArray(raw.palette) || raw.palette.length < 2 || raw.palette.length > 8 || raw.palette.some(color => !HEX_RE.test(color))) {
    return { ok: false, error: { kind: 'invalid-palette', message: 'Draft palette must contain 2 to 8 hex colors.' } };
  }
  return {
    ok: true,
    draft: {
      name: raw.name.trim(),
      description: raw.description.trim(),
      changeSummary,
      palette: raw.palette.map(color => color.toLowerCase()),
      code: raw.code.trim(),
      suggestedParams: normalizeSuggestedParams(raw.suggestedParams, normalizeParamDefs(raw.code)),
      notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
    },
  };
}

function normalizeParamDefs(code = '') {
  return parseParamsFromCode(code).map(param => {
    const min = clampGlobalNumber(param.min);
    const max = clampGlobalNumber(param.max);
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    return {
      ...param,
      value: clampNumber(param.value, low, high),
      min: low,
      max: high,
      step: clampGlobalNumber(param.step),
    };
  });
}

function normalizeSuggestedParams(suggestedParams, paramDefs = []) {
  if (!suggestedParams || typeof suggestedParams !== 'object') return {};
  const bounds = new Map(paramDefs.map(param => [param.name, param]));
  return Object.fromEntries(Object.entries(suggestedParams)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([name, value]) => {
      const param = bounds.get(name);
      return [name, param ? clampNumber(value, param.min, param.max) : clampGlobalNumber(value)];
    }));
}

function clampGlobalNumber(value) {
  return clampNumber(value, -PARAM_VALUE_LIMIT, PARAM_VALUE_LIMIT);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, min), max);
}

function stripCodeComments(code = '') {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function validateDraftCodeSafety(code = '') {
  const scanned = stripCodeComments(code);
  if (
    BACKSLASH_RE.test(scanned)
    || NON_ASCII_OR_CONTROL_RE.test(scanned)
    || STRING_LITERAL_RE.test(scanned)
    || BRACKET_RE.test(scanned)
    || ARROW_FUNCTION_RE.test(scanned)
    || BIGINT_LITERAL_RE.test(scanned)
    || SHIFT_OPERATOR_RE.test(scanned)
    || UNSAFE_TOKEN_RE.test(scanned)
    || UNSAFE_METHOD_RE.test(scanned)
    || hasUnsafeMemberAccess(scanned)
    || hasUnsafeNumericLiteral(scanned)
    || hasUnsafeFbmCall(scanned)
    || hasUnsafeLocalCall(scanned)
    || hasUnsafeAssignment(scanned)
    || hasUnsafeIdentifier(scanned)
  ) {
    return { ok: false, error: { kind: 'unsafe-code', message: 'Draft code used a blocked JavaScript construct.' } };
  }
  return { ok: true };
}

function hasUnsafeAssignment(code) {
  if (/\+\+|--/.test(code)) return true;
  if (/(?:\*\*=|<<=|>>=|>>>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|&&=|\|\|=|\?\?=)/.test(code)) return true;

  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '=') continue;
    const previous = code[i - 1] || '';
    const next = code[i + 1] || '';
    if (previous === '=' || previous === '!' || previous === '<' || previous === '>' || next === '=') continue;
    if (/\b(?:const|let)\s+[A-Za-z_$][\w$]*\s*$/.test(code.slice(0, i))) continue;
    return true;
  }
  return false;
}

function hasUnsafeMemberAccess(code) {
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '.') continue;
    const previous = code.slice(0, i).match(/[A-Za-z_$][\w$]*\s*$/)?.[0]?.trim();
    const next = code.slice(i + 1).match(/^\s*[A-Za-z_$][\w$]*/)?.[0];
    if (!next) continue;
    if (previous !== 'params') return true;
  }
  return false;
}

function hasUnsafeNumericLiteral(code) {
  for (const match of code.matchAll(NUMERIC_LITERAL_RE)) {
    if (Math.abs(Number(match[0])) > PARAM_VALUE_LIMIT) return true;
  }
  return false;
}

function hasUnsafeFbmCall(code) {
  for (const args of extractCallArguments(code, 'fbm')) {
    if (args.length < 3) continue;
    const octaves = args[2].trim();
    if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(octaves)) return true;
    if (Number(octaves) > FBM_OCTAVE_LIMIT) return true;
  }
  return false;
}

function extractCallArguments(code, name) {
  const calls = [];
  const callRe = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let index = 0;
  let match;
  while ((match = callRe.exec(code)) !== null) {
    const start = callRe.lastIndex;
    let depth = 1;
    for (let i = start; i < code.length; i++) {
      if (code[i] === '(') depth++;
      if (code[i] === ')') depth--;
      if (depth === 0) {
        calls.push(splitTopLevelArgs(code.slice(start, i)));
        index = i + 1;
        callRe.lastIndex = index;
        break;
      }
    }
    if (depth !== 0) break;
  }
  return calls;
}

function hasUnsafeLocalCall(code) {
  const locals = collectLocalNames(code);
  for (const name of locals) {
    const callRe = new RegExp(`\\b${name}\\s*\\(`);
    if (callRe.test(code)) return true;
  }
  return false;
}

function splitTopLevelArgs(args) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '(') depth++;
    if (args[i] === ')') depth--;
    if (args[i] === ',' && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  return parts;
}

function collectLocalNames(code) {
  const names = new Set();
  const declarationRe = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = declarationRe.exec(code)) !== null) {
    names.add(match[1]);
  }
  return names;
}

function hasUnsafeIdentifier(code) {
  const locals = collectLocalNames(code);
  IDENTIFIER_RE.lastIndex = 0;
  let match;
  while ((match = IDENTIFIER_RE.exec(code)) !== null) {
    const name = match[0];
    const start = match.index;
    const end = start + name.length;
    const previousChar = code[start - 1] || '';
    const nextChar = code[end] || '';
    const nextNonSpace = code.slice(end).match(/^\s*(.)/)?.[1] || '';
    if (previousChar === '.') continue;
    if (nextNonSpace === ':' && ['r', 'g', 'b'].includes(name)) continue;
    if (ALLOWED_IDENTIFIERS.has(name) || locals.has(name)) continue;
    if ((name === 'r' || name === 'g' || name === 'b') && nextChar === '(') continue;
    return true;
  }
  return false;
}

export function stripPixelsToFrameStrips(strips = []) {
  const visible = Array.isArray(strips) && strips.length ? strips : [{
    id: 'draft-default',
    pixels: Array.from({ length: 12 }, (_, i) => ({ x: i / 11, y: 0.5 + Math.sin(i) * 0.2 })),
  }];
  return visible
    .filter(strip => strip && !strip.hidden)
    .map(strip => {
      const pixels = strip.pixels || strip.pts || [];
      const count = pixels.length;
      return {
        id: strip.id || 'draft-strip',
        pts: pixels.map((pixel, i) => ({
          x: Number.isFinite(pixel.x) ? pixel.x : i,
          y: Number.isFinite(pixel.y) ? pixel.y : 0,
          p: count > 1 ? i / (count - 1) : 0.5,
        })),
      };
    })
    .filter(strip => strip.pts.length > 0);
}

function allowsBlackout(instruction = '') {
  return /\b(blackout|turn\s+off|all\s+off|lights?\s+off|off\s+the\s+lights?)\b/i.test(instruction);
}

function buildDraftParamValues(draft) {
  return {
    ...Object.fromEntries(normalizeParamDefs(draft.code).map(param => [param.name, param.value])),
    ...(draft.suggestedParams || {}),
  };
}

function wrapDraftFunction(fn) {
  return (...args) => {
    const safeArgs = [...args];
    safeArgs[9] = buildReadOnlyParams(safeArgs[9]);
    return fn.apply(SAFE_PATTERN_THIS, safeArgs);
  };
}

function buildReadOnlyParams(params = {}) {
  return new Proxy(Object.freeze({ ...params }), {
    set() {
      throw new Error('Draft params are read-only.');
    },
    defineProperty() {
      throw new Error('Draft params are read-only.');
    },
    deleteProperty() {
      throw new Error('Draft params are read-only.');
    },
    setPrototypeOf() {
      throw new Error('Draft params are read-only.');
    },
  });
}

function prepareAiPatternPreview(draft, {
  strips = [],
  t = 0.5,
  bpm = 120,
  audioBands = null,
} = {}) {
  const compiled = compile(draft.code);
  if (compiled.error || !compiled.fn) {
    return { ok: false, error: { kind: 'compile-error', message: compiled.error || 'Draft did not compile.' } };
  }
  const activeFn = wrapDraftFunction(compiled.fn);
  const frameStrips = stripPixelsToFrameStrips(strips);
  const params = buildDraftParamValues(draft);
  const paletteNorm = normalizePalette(draft.palette);
  const runtimeProbe = probeDraftRuntime(activeFn, {
    frameStrips,
    params,
    paletteNorm,
    t,
    bpm,
    audioBands,
  });
  if (!runtimeProbe.ok) {
    return runtimeProbe;
  }
  return { ok: true, activeFn, frameStrips, params, paletteNorm, t, bpm, audioBands };
}

function prepareValidatedAiPatternDraft(rawDraft, options = {}) {
  const normalized = normalizeDraftPayload(rawDraft);
  if (!normalized.ok) return normalized;
  const { draft } = normalized;
  const safety = validateDraftCodeSafety(draft.code);
  if (!safety.ok) return safety;
  const prepared = prepareAiPatternPreview(draft, options);
  if (!prepared.ok) return prepared;
  return {
    ...prepared,
    draft,
    paramDefs: applySuggestedParamValues(normalizeParamDefs(draft.code), draft.suggestedParams),
  };
}

function applySuggestedParamValues(paramDefs, suggestedParams = {}) {
  return paramDefs.map(param => ({
    ...param,
    value: Object.prototype.hasOwnProperty.call(suggestedParams, param.name)
      ? clampNumber(suggestedParams[param.name], param.min, param.max)
      : param.value,
  }));
}

function renderPreparedPreviewFrame(prepared) {
  return renderPixelFrame({
    t: prepared.t,
    strips: prepared.frameStrips,
    patternId: AI_DRAFT_PATTERN_ID,
    activeFn: prepared.activeFn,
    params: prepared.params,
    paletteNorm: prepared.paletteNorm,
    bpm: prepared.bpm,
    audioBands: prepared.audioBands,
  });
}

export function buildAiPatternPreviewFrame(draft, options = {}) {
  const prepared = prepareValidatedAiPatternDraft(draft, options);
  if (!prepared.ok) {
    throwAiPatternDraftError(prepared.error);
  }
  const frame = renderPreparedPreviewFrame(prepared);
  if (!frameHasLight(frame) && !allowsBlackout(options.instruction)) {
    throwAiPatternDraftError({ kind: 'blank-render', message: 'Draft rendered as a blackout.' });
  }
  return frame;
}

function throwAiPatternDraftError(error) {
  const thrown = new Error(error.message);
  thrown.kind = error.kind;
  thrown.error = error;
  throw thrown;
}

function frameHasLight(frame) {
  return (frame?.pixels || []).some(pixel => Math.max(pixel.r || 0, pixel.g || 0, pixel.b || 0) > 8);
}

function probeDraftRuntime(fn, {
  frameStrips = [],
  params = {},
  paletteNorm = [],
  t = 0.5,
  bpm = 120,
  audioBands = null,
} = {}) {
  const allPts = frameStrips.flatMap(strip => strip.pts || []);
  const bounds = getDraftNormBounds(allPts);
  const beat = (t * bpm / 60) % 1;
  const beatSin = Math.sin(beat * Math.PI);
  const time = (t / 65.536) % 1;
  const pixelCount = allPts.length || 1;
  const bass = audioBands?.bass ?? 0;
  const mid = audioBands?.mid ?? 0;
  const hi = audioBands?.hi ?? 0;

  try {
    let globalIndex = 0;
    for (const strip of frameStrips) {
      for (const pt of strip.pts || []) {
        const nx = (pt.x - bounds.minX) / bounds.range;
        const ny = (pt.y - bounds.minY) / bounds.range;
        const result = fn(globalIndex, nx, ny, t, time, pixelCount, paletteNorm, beat, beatSin, params, strip.id, pt.p, bass, mid, hi);
        assertRenderableColor(result);
        globalIndex++;
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: { kind: 'runtime-error', message: error.message || 'Draft failed during preview.' } };
  }
}

function assertRenderableColor(result) {
  if (Array.isArray(result)) {
    assertFiniteColorValues([result[0] ?? 0, result[1] ?? 0, result[2] ?? 0]);
    return;
  }
  if (!result || typeof result !== 'object') {
    return;
  }
  assertFiniteColorValues([result.r ?? 0, result.g ?? 0, result.b ?? 0]);
}

function assertFiniteColorValues(values) {
  for (const value of values) {
    if (!Number.isFinite(Number(value))) {
      throw new Error('Draft returned a non-finite color value.');
    }
  }
}

function getDraftNormBounds(pts) {
  if (!pts.length) return { minX: 0, minY: 0, range: 1 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const pt of pts) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, range: Math.max(maxX - minX, maxY - minY, 0.001) };
}

export function validateAiPatternDraft(rawDraft, options = {}) {
  const prepared = prepareValidatedAiPatternDraft(rawDraft, options);
  if (!prepared.ok) return prepared;
  try {
    const frame = renderPreparedPreviewFrame(prepared);
    if (!frameHasLight(frame) && !allowsBlackout(options.instruction)) {
      return { ok: false, error: { kind: 'blank-render', message: 'Draft rendered as a blackout.' } };
    }
    return { ok: true, draft: prepared.draft, params: prepared.paramDefs, frame };
  } catch (error) {
    return { ok: false, error: { kind: 'runtime-error', message: error.message || 'Draft failed during preview.' } };
  }
}
