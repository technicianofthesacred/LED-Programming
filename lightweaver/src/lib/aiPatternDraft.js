import { compile } from './patterns.js';
import { normalizePalette, renderPixelFrame, resolvePatternParams } from './frameEngine.js';
import { parseParamsFromCode } from './patternParams.js';

const REQUIRED_STRING_FIELDS = ['name', 'description', 'code'];
const UNSAFE_TOKEN_RE = /\b(fetch|XMLHttpRequest|localStorage|sessionStorage|document|window|Function|eval|import|require|WebSocket|Worker)\b/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeDraftPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: { kind: 'invalid-shape', message: 'Draft response must be an object.' } };
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) {
      return { ok: false, error: { kind: 'invalid-shape', message: `Draft is missing ${field}.` } };
    }
  }
  if (!Array.isArray(raw.changeSummary) || raw.changeSummary.length < 1 || raw.changeSummary.length > 6) {
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
      changeSummary: raw.changeSummary.map(item => String(item).trim()).filter(Boolean).slice(0, 6),
      palette: raw.palette.map(color => color.toLowerCase()),
      code: raw.code.trim(),
      suggestedParams: raw.suggestedParams && typeof raw.suggestedParams === 'object' ? raw.suggestedParams : {},
      notes: typeof raw.notes === 'string' ? raw.notes.trim() : '',
    },
  };
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
  return /\b(blackout|turn off|all off|dark|darkness)\b/i.test(instruction);
}

export function buildAiPatternPreviewFrame(draft, {
  strips = [],
  t = 0.5,
  bpm = 120,
  audioBands = null,
} = {}) {
  const compiled = compile(draft.code);
  if (compiled.error || !compiled.fn) {
    throw new Error(compiled.error || 'Draft did not compile.');
  }
  return renderPixelFrame({
    t,
    strips: stripPixelsToFrameStrips(strips),
    activeFn: compiled.fn,
    params: {
      ...Object.fromEntries(parseParamsFromCode(draft.code).map(param => [param.name, param.value])),
      ...(draft.suggestedParams || {}),
    },
    paletteNorm: normalizePalette(draft.palette),
    bpm,
    audioBands,
  });
}

function frameHasLight(frame) {
  return (frame?.pixels || []).some(pixel => Math.max(pixel.r || 0, pixel.g || 0, pixel.b || 0) > 8);
}

export function validateAiPatternDraft(rawDraft, options = {}) {
  const normalized = normalizeDraftPayload(rawDraft);
  if (!normalized.ok) return normalized;
  const { draft } = normalized;
  if (UNSAFE_TOKEN_RE.test(draft.code)) {
    return { ok: false, error: { kind: 'unsafe-code', message: 'Draft code used a blocked browser or network API.' } };
  }
  const compiled = compile(draft.code);
  if (compiled.error || !compiled.fn) {
    return { ok: false, error: { kind: 'compile-error', message: compiled.error || 'Draft did not compile.' } };
  }
  const params = parseParamsFromCode(draft.code);
  try {
    const frame = buildAiPatternPreviewFrame(draft, options);
    if (!frameHasLight(frame) && !allowsBlackout(options.instruction)) {
      return { ok: false, error: { kind: 'blank-render', message: 'Draft rendered as a blackout.' } };
    }
    return { ok: true, draft, params, frame };
  } catch (error) {
    return { ok: false, error: { kind: 'runtime-error', message: error.message || 'Draft failed during preview.' } };
  }
}
