import { compile } from './patterns.js';
import { normalizePalette, renderPixelFrame } from './frameEngine.js';
import { parseParamsFromCode } from './patternParams.js';

const REQUIRED_STRING_FIELDS = ['name', 'description', 'code'];
const UNSAFE_TOKEN_RE = /(?:\b(fetch|XMLHttpRequest|localStorage|sessionStorage|document|window|Function|eval|import|require|WebSocket|Worker|this|globalThis|self|constructor|prototype|__proto__|class|async|await)\b|\bnew\s+(?!Error\b))/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const AI_DRAFT_PATTERN_ID = '__ai_draft__';
const SAFE_PATTERN_THIS = Object.freeze(Object.create(null));

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
      suggestedParams: normalizeSuggestedParams(raw.suggestedParams),
      notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
    },
  };
}

function normalizeSuggestedParams(suggestedParams) {
  if (!suggestedParams || typeof suggestedParams !== 'object') return {};
  return Object.fromEntries(
    Object.entries(suggestedParams).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
  );
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
    ...Object.fromEntries(parseParamsFromCode(draft.code).map(param => [param.name, param.value])),
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
  const prepared = prepareAiPatternPreview(draft, options);
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  return renderPreparedPreviewFrame(prepared);
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
  const normalized = normalizeDraftPayload(rawDraft);
  if (!normalized.ok) return normalized;
  const { draft } = normalized;
  if (UNSAFE_TOKEN_RE.test(draft.code)) {
    return { ok: false, error: { kind: 'unsafe-code', message: 'Draft code used a blocked browser or network API.' } };
  }
  const params = parseParamsFromCode(draft.code);
  const prepared = prepareAiPatternPreview(draft, options);
  if (!prepared.ok) return prepared;
  try {
    const frame = renderPreparedPreviewFrame(prepared);
    if (!frameHasLight(frame) && !allowsBlackout(options.instruction)) {
      return { ok: false, error: { kind: 'blank-render', message: 'Draft rendered as a blackout.' } };
    }
    return { ok: true, draft, params, frame };
  } catch (error) {
    return { ok: false, error: { kind: 'runtime-error', message: error.message || 'Draft failed during preview.' } };
  }
}
