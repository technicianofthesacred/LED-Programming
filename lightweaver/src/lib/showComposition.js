// showComposition.js — the saved Program format for the Show (music-responsive)
// screen, and its graceful degradation when reopened against a layout that has
// changed. Pure ESM, no React/DOM/audio inside the model itself (persistence
// helpers touch localStorage/File only, guarded the same way the existing
// per-mode tune panel in src/v3/lw-show.jsx guards its own localStorage reads —
// see MODE_PARAMS_KEY / loadSavedParams / persistParams there, lines ~40-53,
// and exportDefaults around line ~340. This module is NOT imported by that
// file; nothing there was edited).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A "COMPOSITION" IS
//
// A composition is a saved Program: a piece-level symmetry layout (fields, per
// symmetryFields.js) plus a set of named AREAS (strip groups, referenced by id
// — never copied) plus a set of VOICES, each a single audio-reactive layer
// bound to exactly one area. A GROUND layer is the always-on base field the
// piece rests on (see "silence decays to a living coal" in the project's
// locked aesthetic — the ground is what silence looks like, never black).
//
// Areas reference strips BY ID. Voices reference areas BY ID. Areas reference
// fields BY ID. Nothing is copied between these lists — resolveComposition()
// is what joins them at read time, and it is written to tolerate every id it
// dereferences going stale.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY COMPOSITIONS ARE NEVER SAVED INTO THE PROJECT FILE
//
// The project file's contents feed cardProjectFingerprint() (see
// src/lib/cardProjectResolver.js), which the live-control authority gate
// (src/lib/cardLiveControl.js) uses to decide whether this browser tab still
// owns the card. A composition is edited by turning knobs continuously while
// music plays — depth, spread, palette, mute toggles, all mid-session. If any
// of that lived in the project file, every knob turn would change the
// project's fingerprint and silently revoke live-control authority the piece
// currently holds, mid-performance. Compositions are therefore an entirely
// separate persistence keyed by projectId (parallel to, never inside, the
// project document), exactly like MODE_PARAMS_KEY is a sibling key to the
// project's own storage, not a field on it.
//
// ─────────────────────────────────────────────────────────────────────────────
// DEGRADATION IS A DESIGN SURFACE, NOT AN ERROR PATH
//
// A composition is a durable record of authored intent — "this voice reacts
// to the bass on the lotus" — and layouts change underneath it constantly
// (a strip renamed, a group split, half a fold rewired). resolveComposition()
// therefore NEVER deletes a voice: an area that resolves to zero pixels keeps
// its voice, marked `unresolved: true`, contributing nothing to the render but
// still present in the composition's own "paragraph" of voices — the record a
// human rereads to understand what this piece is supposed to do. A PARTIAL
// area (4 of 6 authored copies still present) keeps the authored fold and
// gives the missing instances empty pixel runs, so the surviving instances'
// phase timing is byte-identical to the fully-populated case — a gap in the
// wave, not a re-timed wave. Reopening against a layout with MORE strips does
// not auto-join anything; new strips are simply unvoiced until a human assigns
// them.
import {
  fieldCopyCount,
  memberStripIds,
  normalizeArea,
  normalizeField,
  normalizeFields,
  readAreaSymmetry,
  resolveFieldForArea,
  deriveInstancePhases,
} from './symmetryFields.js';

export const SHOW_COMPOSITION_VERSION = 1;
const STORAGE_KEY = 'lw.show.compositions.v1';
const WHOLE_PIECE = '*';

export const MAX_VOICES = 8;
export const MAX_FOLD = 64;

// The five modulation targets the locked aesthetic permits audio to touch.
// Never add 'clock' or 'rotation' here — see the header of symmetryFields.js
// and the project CLAUDE.md "LOCKED AESTHETIC" section. A band value must be
// physically unable to reach a clock increment; keeping the character
// vocabulary limited to this list is part of how that's enforced in code,
// not just by discipline (checked by the audio-isolation test below).
export const VOICE_CHARACTERS = Object.freeze([
  'amplitude',
  'breadth',
  'contrast',
  'position',
  'texture',
]);
const DEFAULT_CHARACTER = VOICE_CHARACTERS[0];

// The audio bands createShowAudioFeatures() (showAudioFeatures.js) actually
// produces, plus 'none' for a voice/ground authored to sit still.
export const AUDIO_BANDS = Object.freeze(['none', 'bass', 'mid', 'high', 'energy', 'beat']);
const DEFAULT_BAND = 'mid';

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function clampDirection(value) {
  return value === -1 ? -1 : 1;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback = '') {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function makeId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function normalizeCharacter(raw) {
  // 'mode' is a legitimate character (the legacy nine-effect engine voice —
  // see isModeVoice below) that is deliberately NOT one of the five
  // locked-aesthetic modulation targets in VOICE_CHARACTERS. It must still
  // survive normalization as literally 'mode', or a second reload — which
  // recomputes isModeVoice from this already-normalized value — silently
  // loses the fact that this voice was ever a mode voice.
  if (raw === 'mode') return 'mode';
  return VOICE_CHARACTERS.includes(raw) ? raw : DEFAULT_CHARACTER;
}

function normalizeBand(raw) {
  return AUDIO_BANDS.includes(raw) ? raw : DEFAULT_BAND;
}

// ── stripIds: either the whole-piece sentinel '*' or an explicit array ────
function normalizeStripIds(raw) {
  if (raw === WHOLE_PIECE) return WHOLE_PIECE;
  if (Array.isArray(raw)) {
    const seen = new Set();
    const out = [];
    for (const id of raw) {
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }
  return [];
}

function normalizeAreaInstance(raw, index) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    index: Number.isInteger(src.index) ? src.index : index,
    stripIds: normalizeStripIds(src.stripIds),
    mirrored: src.mirrored === true,
  };
}

function normalizeAreaEntry(raw, index) {
  const src = isPlainObject(raw) ? raw : {};
  const instancesRaw = Array.isArray(src.instances) ? src.instances : [];
  return {
    id: asString(src.id, makeId('area')),
    name: asString(src.name, `Area ${index + 1}`),
    fieldId: typeof src.fieldId === 'string' && src.fieldId ? src.fieldId : null,
    instances: instancesRaw.map((inst, i) => normalizeAreaInstance(inst, i)),
  };
}

function normalizeVoiceEntry(raw, index) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    id: asString(src.id, makeId('voice')),
    areaId: typeof src.areaId === 'string' && src.areaId ? src.areaId : null,
    character: normalizeCharacter(src.character),
    band: normalizeBand(src.band),
    depth: clamp01(src.depth, 0.5),
    spread: clamp01(src.spread, 1),
    direction: clampDirection(src.direction),
    palette: typeof src.palette === 'string' && src.palette ? src.palette : null,
    muted: src.muted === true,
    // 'mode' character is the legacy nine-effect engine (mandalaEngine.js),
    // which keeps module-scoped mutable state per docs above — at most one
    // voice may claim it per composition. Everything else is stateless per
    // voice and unrestricted.
    isModeVoice: src.character === 'mode',
    _sourceIndex: index,
  };
}

function normalizeGround(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    enabled: src.enabled !== false,
    level: clamp01(src.level, 0.12),
    breath: clamp01(src.breath, 0.5),
    band: normalizeBand(src.band === undefined ? 'none' : src.band),
    palette: typeof src.palette === 'string' && src.palette ? src.palette : null,
  };
}

/**
 * normalizeComposition(raw) -> Composition
 * Total: never throws. Clamps/discards garbage rather than rejecting it.
 * Enforces: <= MAX_VOICES voices (plus ground, which doesn't count against
 * the cap), field folds <= MAX_FOLD, and at most one 'mode'-character voice.
 */
export function normalizeComposition(raw) {
  const src = isPlainObject(raw) ? raw : {};

  const fields = normalizeFields(Array.isArray(src.fields) ? src.fields : [])
    .map((f) => (f.fold > MAX_FOLD ? normalizeField({ ...f, fold: MAX_FOLD }) : f));

  const areas = (Array.isArray(src.areas) ? src.areas : []).map(normalizeAreaEntry);

  let voices = (Array.isArray(src.voices) ? src.voices : []).map(normalizeVoiceEntry);

  // At most one 'mode' voice: keep the first, demote the rest to the default
  // character rather than dropping them — degradation policy applies to
  // authoring-time validation too, never silently delete a voice.
  let seenModeVoice = false;
  voices = voices.map((v) => {
    if (!v.isModeVoice) return v;
    if (!seenModeVoice) {
      seenModeVoice = true;
      return v;
    }
    return { ...v, character: DEFAULT_CHARACTER, isModeVoice: false };
  });

  // Cap voice count. Excess voices are dropped at normalize time (this is
  // authoring-time input validation, not the reopen-against-a-changed-layout
  // path resolveComposition() governs — that path never drops a voice).
  if (voices.length > MAX_VOICES) voices = voices.slice(0, MAX_VOICES);

  voices = voices.map(({ _sourceIndex, ...v }) => v);

  return {
    version: SHOW_COMPOSITION_VERSION,
    id: asString(src.id, makeId('comp')),
    name: asString(src.name, 'Untitled program'),
    projectId: typeof src.projectId === 'string' && src.projectId ? src.projectId : null,
    preset: typeof src.preset === 'string' && src.preset ? src.preset : null,
    master: clamp01(src.master, 1),
    sensitivity: clamp01(src.sensitivity, 0.5),
    ground: normalizeGround(src.ground),
    fields,
    areas,
    voices,
  };
}

// ── export / import: round-trip through plain JSON ────────────────────────

export function exportComposition(composition) {
  return JSON.stringify(normalizeComposition(composition), null, 2);
}

export function importComposition(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return normalizeComposition({});
  }
  return normalizeComposition(parsed);
}

// ── persistence: keyed by projectId, a sibling of the project file ────────
// Storage shape: { [projectId]: Composition[] }. Mirrors the localStorage
// guard pattern of loadSavedParams/persistParams in src/v3/lw-show.jsx.

function readStore() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* storage full/blocked — same as persistParams, fail silently */
  }
}

/** loadCompositions(projectId) -> Composition[] saved under this project. */
export function loadCompositions(projectId) {
  if (typeof projectId !== 'string' || !projectId) return [];
  const store = readStore();
  const list = store[projectId];
  return Array.isArray(list) ? list.map(normalizeComposition) : [];
}

/** persistCompositions(projectId, compositions[]) -> normalized list saved. */
export function persistCompositions(projectId, compositions) {
  if (typeof projectId !== 'string' || !projectId) return [];
  const normalized = (Array.isArray(compositions) ? compositions : []).map((c) =>
    normalizeComposition({ ...c, projectId }));
  const store = readStore();
  store[projectId] = normalized;
  writeStore(store);
  return normalized;
}

// ── resolution: join composition against a live layout, never destructively ─

function resolveInstanceStripIds(instance, allStripIdSet) {
  if (instance.stripIds === WHOLE_PIECE) return Array.from(allStripIdSet);
  return instance.stripIds.filter((id) => allStripIdSet.has(id));
}

/**
 * resolveArea(area, fields, allStripIdSet) -> {
 *   id, name, fieldId, fold, copies, instances: [{ index, stripIds, mirrored, empty }],
 *   pixelCount, partial
 * }
 * `fold` is the AUTHORED instance count (from the matched field, or the
 * number of authored instance slots when no field matches) — it is never
 * reduced because some instances came up empty. An instance whose resolved
 * stripIds is empty is kept with `empty: true` and an empty stripIds array,
 * so downstream phase math (deriveInstancePhases) still sees the authored
 * instance count and unaffected instances keep their original phase.
 */
function resolveArea(areaEntry, fields, allStripIdSet) {
  const field = areaEntry.fieldId
    ? fields.find((f) => f.id === areaEntry.fieldId) || null
    : null;
  const authoredFold = areaEntry.instances.length > 0
    ? areaEntry.instances.length
    : (field ? fieldCopyCount(field) : 1);

  const instances = [];
  let pixelCount = 0;
  let emptyCount = 0;

  const slotCount = Math.max(authoredFold, areaEntry.instances.length);
  for (let i = 0; i < slotCount; i += 1) {
    const authored = areaEntry.instances.find((inst) => inst.index === i)
      || areaEntry.instances[i]
      || null;
    if (!authored) {
      instances.push({ index: i, stripIds: [], mirrored: false, empty: true });
      emptyCount += 1;
      continue;
    }
    const stripIds = resolveInstanceStripIds(authored, allStripIdSet);
    if (stripIds.length === 0) {
      instances.push({ index: i, stripIds: [], mirrored: authored.mirrored, empty: true });
      emptyCount += 1;
    } else {
      instances.push({ index: i, stripIds, mirrored: authored.mirrored, empty: false });
      pixelCount += stripIds.length;
    }
  }

  return {
    id: areaEntry.id,
    name: areaEntry.name,
    fieldId: areaEntry.fieldId,
    field,
    fold: slotCount,
    instances,
    pixelCount,
    partial: emptyCount > 0 && emptyCount < slotCount,
    empty: pixelCount === 0,
  };
}

/**
 * resolveComposition(composition, template) -> { fields, areas, voices,
 *   pixelIndex, warnings }
 *
 * `template` is anything symmetryFields.js geometry helpers accept: a Map,
 * plain object, or function of stripId -> {x,y,weight?}; it is ALSO read
 * here for its key set (or, if it exposes `.stripIds`/`.strips`, that) to
 * know which strip ids currently exist in the layout. Any composition
 * reference to a strip id not in that set resolves as missing, without
 * throwing and without deleting the voice/area that referenced it.
 */
export function resolveComposition(composition, template) {
  const comp = normalizeComposition(composition);
  const warnings = [];

  const allStripIdSet = collectStripIds(template);

  const fields = comp.fields;
  const resolvedAreas = new Map();
  for (const areaEntry of comp.areas) {
    resolvedAreas.set(areaEntry.id, resolveArea(areaEntry, fields, allStripIdSet));
  }

  const pixelIndex = new Map();
  for (const area of resolvedAreas.values()) {
    for (const inst of area.instances) {
      for (const stripId of inst.stripIds) {
        if (!pixelIndex.has(stripId)) pixelIndex.set(stripId, []);
        pixelIndex.get(stripId).push({ areaId: area.id, instanceIndex: inst.index });
      }
    }
  }

  const voices = comp.voices.map((voice) => {
    if (!voice.areaId) {
      warnings.push({ voiceId: voice.id, kind: 'no-area', message: 'Voice has no area assigned.' });
      return { ...voice, unresolved: true, area: null };
    }
    const area = resolvedAreas.get(voice.areaId);
    if (!area) {
      warnings.push({
        voiceId: voice.id,
        kind: 'missing-area',
        message: `Voice references area "${voice.areaId}", which no longer exists in this project.`,
      });
      return { ...voice, unresolved: true, area: null };
    }
    if (area.empty) {
      warnings.push({
        voiceId: voice.id,
        kind: 'empty-area',
        message: `Area "${area.name}" resolves to zero pixels; voice "${voice.id}" is kept but renders nothing.`,
      });
      return { ...voice, unresolved: true, area };
    }
    if (area.partial) {
      warnings.push({
        voiceId: voice.id,
        kind: 'partial-area',
        message: `Area "${area.name}" is missing some of its ${area.fold} instances; the gap is silent, timing is unchanged.`,
      });
    }
    return { ...voice, unresolved: false, area };
  });

  const newStripIds = Array.from(allStripIdSet).filter((id) => !pixelIndex.has(id));
  if (newStripIds.length > 0) {
    warnings.push({
      kind: 'unvoiced-strips',
      message: `${newStripIds.length} strip(s) in this layout are not covered by any area and will not react.`,
      stripIds: newStripIds,
    });
  }

  return {
    fields,
    areas: Array.from(resolvedAreas.values()),
    voices,
    pixelIndex,
    warnings,
  };
}

function collectStripIds(template) {
  const set = new Set();
  if (!template) return set;
  if (template instanceof Map) {
    for (const key of template.keys()) set.add(key);
    return set;
  }
  if (Array.isArray(template.stripIds)) {
    for (const id of template.stripIds) set.add(id);
    return set;
  }
  if (Array.isArray(template.strips)) {
    for (const s of template.strips) {
      const id = s?.id ?? s?.stripId ?? s?.pathId;
      if (typeof id === 'string') set.add(id);
    }
    return set;
  }
  if (isPlainObject(template)) {
    for (const key of Object.keys(template)) set.add(key);
    return set;
  }
  return set;
}

// Re-exported for callers building an area from an existing layout strip
// group (src/lib/symmetryFields.js shapes) without duplicating the
// dual-namespace membership read documented there.
export { memberStripIds, normalizeArea, readAreaSymmetry, resolveFieldForArea, deriveInstancePhases };
