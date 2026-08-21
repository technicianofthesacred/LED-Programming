// symmetryFields.js — the shared symmetry data model for the music-responsive
// ensemble. Pure functions only: no React, no DOM, no module-level mutable
// state that any caller can observe. (The one WeakSet below is a normalization
// memo; it changes no observable result.)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MODEL, IN THE OWNER'S WORDS
//
//   "if it's six going out, I might have four different things times six"
//   "you could stack six-side and two-side, where just the lily flower would
//    be six and then the outer spot ring would be one"
//
// A PIECE declares SYMMETRY FIELDS. A field is a kaleidoscope: a fold N, a
// centre in ARTWORK coordinates, a rotation offset, and an optional mirror.
// Several fields may coexist on one piece (inner region 4-fold, outer ring
// 6-fold); each carries a `scope` and they are resolved in ascending `order`,
// FIRST MATCH WINS. A strip matched by no field has fold 1.
//
// A MOTIF (an "area" — one of the existing named strip groups: lotus, bee,
// sun ray, outer spots) lives inside the base wedge. The field gives it N
// copies around the piece. The motif then carries its OWN fold, which must
// DIVIDE N, and that fold says how many INDEPENDENT INSTANCES those N copies
// form:
//
//   fold = N  → every copy is its own instance; a ripple travels copy to copy.
//   fold = 1  → all N copies are ONE instance, permanently in unison.
//   fold = 2 on N = 6 → two instances of three copies each.
//
// ─────────────────────────────────────────────────────────────────────────────
// fold = 1 AND spread = 0 ARE DIFFERENT. DO NOT MERGE THEM.
//
// A future maintainer will notice that `fold: 1` and `spread: 0` both make the
// piece move as one, and will try to collapse them into a single control.
// They are not the same fact and collapsing them destroys authoring intent:
//
//   fold = 1 is STRUCTURAL. The N copies ARE one body. There is exactly ONE
//     instance, so there is exactly one phase, one envelope, one spark
//     lifetime. Turning the spread dial up can never separate them, because
//     there is nothing to separate — `foldPhases(1, …)` returns an array of
//     LENGTH 1 for every spread value in existence.
//
//   spread = 0 is TEMPORAL. There are still N (or N/fold) separate instances,
//     each with its own envelope and its own state; they merely happen to be
//     at the same phase RIGHT NOW. Turning the spread dial up fans them apart
//     immediately with no re-authoring. `foldPhases(6, { spread: 0 })` returns
//     an array of LENGTH 6 whose entries are all equal.
//
// The observable difference is therefore the LENGTH of the phase array, not
// its contents, and every consumer must key its per-instance state off that
// length. `symmetryFields.test.js` pins this.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYMMETRY IS STORED AT PIECE LEVEL, NEVER ON THE GROUP.
//
// Four motifs share one six-fold. Fields belong to the project (piece), next
// to the layout — NOT inside `layerGroups[]`. Storing fold on the group would
// duplicate one fact per motif and force a migration of every saved project
// the first time a piece needs two fields. The group gets only its own
// membership-and-fold record under an optional `symmetry` key.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE EXISTING GROUP OBJECT IS EXTENDED, NOT REPLACED.
//
// A strip group today is:
//   { groupId, type: 'strip', name, _hidden, _expanded, members: [...] }
// and a member is:
//   { type: 'strip', stripId, pathId, layerId, pathData, name, svgLength,
//     pixelCount, color }
//
// TRAP — THERE ARE TWO IMPLEMENTATIONS OF THE GROUP SHAPE, AND THEY DIVERGE:
//   1. src/state/layoutReducer.js:210  `stripGroupMember()` + GROUP_STRIPS
//      (:336) — the reducer path.
//   2. src/components/layout/hooks/useLayoutState.js:176 `stripGroupMember()`,
//      consumed by useLayoutStrips.js `createStripGroupFromIds` (:330) and
//      `addStripsToGroup` (:366), and by useLayoutArtwork.js:219 — the hook
//      path.
// They produce the same member fields today but are separate literals that
// have to be edited together. Worse, the two group-pruning paths differ:
// the reducer filters members with `m.stripId` ONLY (layoutReducer.js:350)
// while the hook filters with `m.stripId || m.pathId` (useLayoutStrips.js:355).
// So ALWAYS read membership through `memberStripIds()` below, which accepts
// both keys, and never assume one call site is the whole story.
//
// This module adds ONE optional key to the group and touches nothing else:
//
//   group.symmetry = {
//     version:     1,
//     fieldId:     string | null,          // which piece field this motif sits in
//     fold:        number,                 // MUST divide the field's copy count
//     orderMode:   'field' | 'angle' | 'manual',
//     spread:      number,                 // 0..1, temporal stagger (see above)
//     direction:   1 | -1,
//     copyMapping: 'interleaved' | 'contiguous',
//     instances: [{
//       stripIds:   string[],
//       wedgeIndex: number | null,
//       phase:      number | null,         // authored phase; honoured in 'manual'
//       flip:       boolean,
//       confirmed:  boolean,
//       source:     'legacy'|'field'|'angle'|'manual'|'mirror'|'detected',
//     }],
//   }
//
// ─────────────────────────────────────────────────────────────────────────────
// MIGRATION IS FREE. NOTHING IS REWRITTEN ON LOAD. NO VERSION BUMP.
//
// A group saved before this feature simply has no `symmetry` key.
// `readAreaSymmetry(group)` synthesises a single CONFIRMED instance holding
// every member, at fold 1 — which is byte-for-byte how that group renders
// today. Loading a project must not write this back; `readAreaSymmetry` never
// mutates its argument and callers must not persist its output unless the
// owner actually edited the motif.
//
// FLAG FOR src/lib/projectModel.js (DO NOT EDIT IT FROM HERE):
//   `migrateStripIdNamespace` (projectModel.js:~289) already remaps
//   `group.members[].stripId` through `oldToNew` (step 3, projectModel.js:~289
//   comment block). When symmetry data starts being SAVED, two more id
//   namespaces need the same remap in that same loop, or a legacy-namespace
//   project will load with instances pointing at strips that no longer exist:
//     (a) `group.symmetry.instances[].stripIds[]`  — strip ids;
//     (b) piece-level field `scope.stripIds[]` for `scope.kind === 'strips'`.
//   Both are plain strip ids, so the remap is the same one-line `oldToNew.get`
//   treatment. Neither exists in any saved project yet, so `migrateProject`
//   (projectModel.js:~420) is correct as it stands right now.
//
// ─────────────────────────────────────────────────────────────────────────────
// WIRING NOTE FOR src/v3/lw-show.jsx (NOT EDITED BY THIS MODULE — another
// session owns that file). When the ensemble engine is wired in, Show should:
//   1. `const fields = normalizeFields(project.layout.symmetryFields)` once per
//      project load, NOT per frame — normalization allocates.
//   2. Per motif group, once per layout change:
//        const field = resolveFieldForArea(group, fields, geometry)
//        const area  = readAreaSymmetry(group, { field, geometry })
//        const plan  = deriveInstancePhases(area, field, { spread, direction })
//      then build the pixel masks from `plan.instances[].stripIds`, SORTED BY
//      INSTANCE, so `plan.phases[i]` is read once per instance per frame rather
//      than once per pixel.
//   3. Per frame, use ONLY `plan.phases[i]` as a phase OFFSET into the
//      authored clock. See the locked aesthetic below.
//
// ─────────────────────────────────────────────────────────────────────────────
// LOCKED AESTHETIC, ENFORCED STRUCTURALLY.
//
// "Audio may modulate amplitude, breadth, contrast, position, texture. Audio
//  may NEVER modulate an authored clock or rotation speed."
//
// This module is the reason that is enforceable rather than merely promised:
// NO FUNCTION HERE ACCEPTS AN AUDIO BAND VALUE. There is no parameter named
// bass/mid/high/energy/centroid/flux anywhere in this file, and every phase it
// produces is a pure function of (fold, spread, direction, offset, geometry) —
// all authored constants. A band value physically cannot reach a clock
// increment through this module, because there is no argument to put it in.
// Consumers must add the phase to an authored clock, never multiply the clock
// by anything derived from it. Keep it that way: if a future change adds an
// audio argument to any export here, the guarantee is gone.
// ─────────────────────────────────────────────────────────────────────────────

export const SYMMETRY_MODEL_VERSION = 1;

export const TAU = Math.PI * 2;

/** The folds offered by the Symmetry-mode stepper. Storage is not limited to these. */
export const FOLD_STEPS = Object.freeze([1, 2, 3, 4, 5, 6, 8, 12]);

/** Hard ceiling so a corrupt save cannot ask for a million wedges. */
export const MAX_FOLD = 64;

export const COPY_MAPPINGS = Object.freeze(['interleaved', 'contiguous']);
export const DEFAULT_COPY_MAPPING = 'interleaved';

export const ORDER_MODES = Object.freeze(['field', 'angle', 'manual']);
export const INSTANCE_SOURCES = Object.freeze([
  'legacy', 'field', 'angle', 'manual', 'mirror', 'detected',
]);

export const SCOPE_KINDS = Object.freeze(['all', 'radius', 'strips']);

/**
 * The "clustered in one corner" detector. With `n` points spread evenly the
 * largest gap is TAU/n; with every point crammed into one corner the largest
 * gap approaches TAU. We refuse to invent an order when the gap exceeds
 * TAU - (TAU/n) * 0.75 — i.e. when all the points fit inside three quarters of
 * a single even sector. See `deriveInstancePhases`.
 */
export const CLUSTER_GAP_FACTOR = 0.75;

// Normalization memo. Referentially transparent: it only lets an
// already-normalized object skip re-normalization, and normalized objects are
// never handed out twice with different contents.
const NORMALIZED_FIELDS = new WeakSet();

// ── small numeric helpers ────────────────────────────────────────────────────

/** Wrap an angle into [0, TAU). */
export function wrapTau(angle) {
  if (!Number.isFinite(angle)) return 0;
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

/** Wrap a normalized phase into [0, 1). */
export function wrap01(value) {
  if (!Number.isFinite(value)) return 0;
  const v = value % 1;
  return v < 0 ? v + 1 : v;
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clampFold(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_FOLD, n);
}

function uniqueStrings(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || !item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Every divisor of `n`, ascending. `divisorsOf(6)` → [1, 2, 3, 6]. */
export function divisorsOf(n) {
  const target = clampFold(n);
  const out = [];
  for (let d = 1; d <= target; d += 1) if (target % d === 0) out.push(d);
  return out;
}

/**
 * A motif fold is legal only when it DIVIDES the field's copy count. Six copies
 * can be read as 1, 2, 3 or 6 independent instances; asking for 4 is
 * meaningless because the copies cannot be split into four equal groups.
 */
export function isValidFold(fold, copies) {
  const f = Math.trunc(Number(fold));
  const n = Math.trunc(Number(copies));
  if (!Number.isFinite(f) || !Number.isFinite(n)) return false;
  if (f < 1 || n < 1 || f > n) return false;
  return n % f === 0;
}

// ── geometry lookup ──────────────────────────────────────────────────────────
//
// Geometry is supplied by the caller as a lookup from strip id to a point:
// a Map, a plain object, or a function. Points are `{ x, y, weight? }` in
// ARTWORK coordinates. Keeping it injected is what makes every function here
// unit-testable with no DOM.

function geometryGet(geometry, stripId) {
  if (!geometry || typeof stripId !== 'string') return null;
  let entry = null;
  if (typeof geometry === 'function') entry = geometry(stripId);
  else if (typeof geometry.get === 'function') entry = geometry.get(stripId);
  else entry = geometry[stripId];
  if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) return null;
  return entry;
}

/**
 * Build a geometry lookup from real strips. Each strip's centroid is the mean
 * of its sampled `pixels` ({ x, y } — see lib/mapper.js `samplePath`), weighted
 * later by pixel count so a long strip pulls a motif centroid more than a stub.
 * Strips with no sampled pixels get NO entry: a missing point is reported
 * honestly rather than guessed at (0,0).
 */
export function stripCentroids(strips) {
  const out = new Map();
  if (!Array.isArray(strips)) return out;
  for (const strip of strips) {
    const pixels = Array.isArray(strip?.pixels) ? strip.pixels : null;
    if (!pixels || pixels.length === 0) continue;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const px of pixels) {
      if (!px || !Number.isFinite(px.x) || !Number.isFinite(px.y)) continue;
      sx += px.x;
      sy += px.y;
      n += 1;
    }
    if (!n) continue;
    out.set(strip.id, { x: sx / n, y: sy / n, weight: n });
  }
  return out;
}

/**
 * The centroid of one instance: the weighted mean of its strips' centroids.
 * Returns null when NO strip in the set has geometry — an unknown position is
 * never faked, because a faked position silently invents an ordering.
 */
export function instanceCentroid(stripIds, geometry) {
  const ids = Array.isArray(stripIds) ? stripIds : [];
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const id of ids) {
    const point = geometryGet(geometry, id);
    if (!point) continue;
    const w = Number.isFinite(point.weight) && point.weight > 0 ? point.weight : 1;
    sx += point.x * w;
    sy += point.y * w;
    sw += w;
  }
  if (sw <= 0) return null;
  return { x: sx / sw, y: sy / sw };
}

function meanPoint(points) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of points) {
    if (!p) continue;
    sx += p.x;
    sy += p.y;
    n += 1;
  }
  if (!n) return { x: 0, y: 0 };
  return { x: sx / n, y: sy / n };
}

// ── fields ───────────────────────────────────────────────────────────────────

function normalizeScope(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (src.kind === 'strips') {
    return { kind: 'strips', stripIds: uniqueStrings(src.stripIds) };
  }
  if (src.kind === 'radius') {
    const inner = Math.max(0, num(src.inner, 0));
    // `null` means unbounded. JSON cannot carry Infinity, so a round-trip
    // turns Infinity back into null and normalization turns it back again.
    const rawOuter = src.outer === null || src.outer === undefined ? Infinity : num(src.outer, Infinity);
    const outer = Math.max(inner, rawOuter);
    return { kind: 'radius', inner, outer };
  }
  return { kind: 'all' };
}

/**
 * Normalize one symmetry field. Total: any garbage yields a usable fold-1
 * field rather than throwing, because this runs on load and a corrupt save
 * must never stop a project from opening.
 *
 * Shape:
 *   { version, id, fold, centre: {x, y}, rotationOffset, mirror, scope, order }
 *
 * `centre` is in ARTWORK coordinates. NOTE the plan's warning (build plan §6,
 * "Two different centres"): the render pipeline renormalizes to a strip
 * bounding-box centre, and on an asymmetric piece those differ. Convert
 * explicitly at the render boundary; this module always means artwork space.
 *
 * `rotationOffset` is radians and is deliberately NOT wrapped — the authoring
 * ring should read back the number the owner set, not its modulus.
 */
export function normalizeField(raw, index = 0) {
  if (raw && typeof raw === 'object' && NORMALIZED_FIELDS.has(raw)) return raw;
  const src = raw && typeof raw === 'object' ? raw : {};
  const centreSrc = (src.centre || src.center || {});
  const field = {
    version: SYMMETRY_MODEL_VERSION,
    id: typeof src.id === 'string' && src.id ? src.id : `field-${index}`,
    fold: clampFold(src.fold),
    centre: { x: num(centreSrc.x, 0), y: num(centreSrc.y, 0) },
    rotationOffset: num(src.rotationOffset, 0),
    mirror: src.mirror === true,
    scope: normalizeScope(src.scope),
    order: num(src.order, index),
  };
  NORMALIZED_FIELDS.add(field);
  return field;
}

/**
 * Normalize a piece's whole field list and sort it by ascending `order`
 * (ties broken by declaration order, so the sort is stable and reproducible).
 * Resolution is FIRST MATCH WINS over this array.
 */
export function normalizeFields(fields) {
  const list = Array.isArray(fields) ? fields : (fields ? [fields] : []);
  return list
    .map((raw, i) => ({ field: normalizeField(raw, i), i }))
    .sort((a, b) => (a.field.order - b.field.order) || (a.i - b.i))
    .map(entry => entry.field);
}

/**
 * How many copies a field produces.
 *
 * N = fold, DOUBLED when mirror is on: a mirrored kaleidoscope of fold 6 has
 * twelve sectors, six direct and six reflected. Every "must divide N" rule in
 * this module means THIS number, not the bare fold.
 */
export function fieldCopyCount(field) {
  const f = normalizeField(field);
  return f.fold * (f.mirror ? 2 : 1);
}

/**
 * Enumerate a field's copies in canonical order: wedge 0 direct, wedge 0
 * mirrored, wedge 1 direct, wedge 1 mirrored, … The mirrored twin sits
 * IMMEDIATELY after its wedge so that the default interleaved mapping puts a
 * direct/mirrored pair into two different instances when the motif fold allows
 * it — which is what makes a mirrored motif read as a reflected pair rather
 * than a doubled single body.
 */
export function enumerateCopies(field) {
  const f = normalizeField(field);
  const per = f.mirror ? 2 : 1;
  const out = [];
  for (let wedge = 0; wedge < f.fold; wedge += 1) {
    for (let m = 0; m < per; m += 1) {
      out.push({ copyIndex: wedge * per + m, wedgeIndex: wedge, flip: m === 1 });
    }
  }
  return out;
}

/** The canonical copy index for a (wedgeIndex, flip) pair inside a field. */
export function copyIndexOf(wedgeIndex, flip, field) {
  const f = normalizeField(field);
  const per = f.mirror ? 2 : 1;
  const w = Number.isFinite(wedgeIndex) ? ((Math.trunc(wedgeIndex) % f.fold) + f.fold) % f.fold : 0;
  return w * per + (flip === true && f.mirror ? 1 : 0);
}

/**
 * Which wedge of `field` a point falls in, 0 .. fold-1.
 *
 * Angles are measured with atan2(y - cy, x - cx) in SVG coordinates, where y
 * grows DOWNWARD — so increasing wedge index runs clockwise on screen. That is
 * a convention, not a bug; every consumer here uses the same one, so ghost
 * echoes, wedge indices and angle ordering all agree.
 */
export function wedgeIndexOf(point, field) {
  const f = normalizeField(field);
  if (f.fold <= 1) return 0;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return 0;
  const angle = wrapTau(Math.atan2(point.y - f.centre.y, point.x - f.centre.x) - f.rotationOffset);
  const index = Math.floor(angle / (TAU / f.fold));
  return Math.min(f.fold - 1, Math.max(0, index));
}

function fieldMatchesStrip(field, stripId, geometry) {
  const scope = field.scope;
  if (scope.kind === 'all') return true;
  if (scope.kind === 'strips') return scope.stripIds.includes(stripId);
  if (scope.kind === 'radius') {
    const point = geometryGet(geometry, stripId);
    // No geometry means we cannot decide. A field must not CLAIM a strip it
    // cannot measure, or an un-sampled strip would silently join the wrong
    // kaleidoscope; fall through to the next field instead.
    if (!point) return false;
    const dx = point.x - field.centre.x;
    const dy = point.y - field.centre.y;
    const r = Math.sqrt(dx * dx + dy * dy);
    return r >= scope.inner && r <= scope.outer;
  }
  return false;
}

/**
 * Resolve which field owns a strip. Fields are tried in ascending `order`,
 * FIRST MATCH WINS. Returns null when no field claims the strip — meaning
 * fold 1, a strip that stands alone.
 *
 * @param {string} stripId
 * @param {Array} fields          piece-level fields (any order; sorted here)
 * @param {Map|Object|Function} [geometry]  strip id → { x, y, weight? }
 */
export function resolveFieldForStrip(stripId, fields, geometry = null) {
  for (const field of normalizeFields(fields)) {
    if (fieldMatchesStrip(field, stripId, geometry)) return field;
  }
  return null;
}

/**
 * Resolve the field for a whole motif: the field claimed by the MOST of its
 * member strips, ties broken by field order. A motif whose strips straddle two
 * fields is an authoring mistake; this picks the majority reading and the
 * caller can compare `resolveFieldForStrip` per strip to detect the straddle.
 */
export function resolveFieldForArea(group, fields, geometry = null) {
  const members = memberStripIds(group);
  if (!members.length) return null;
  const sorted = normalizeFields(fields);
  const tally = new Map();
  for (const id of members) {
    for (const field of sorted) {
      if (!fieldMatchesStrip(field, id, geometry)) continue;
      tally.set(field.id, (tally.get(field.id) || 0) + 1);
      break;
    }
  }
  let best = null;
  let bestCount = 0;
  for (const field of sorted) {
    const count = tally.get(field.id) || 0;
    if (count > bestCount) {
      best = field;
      bestCount = count;
    }
  }
  return best;
}

// ── copies → instances ───────────────────────────────────────────────────────

/**
 * Map a copy index to an instance index.
 *
 * TWO MAPPINGS, AND THE DIFFERENCE IS VISIBLE IN THE ART. With N = 6 copies
 * and fold = 2:
 *
 *   'interleaved' (k % fold)               → copies 0,2,4 = instance 0
 *                                            copies 1,3,5 = instance 1
 *     Alternating petals. The assignment is itself invariant under a rotation
 *     of two wedges, so the piece keeps its radial balance: both instances are
 *     distributed evenly around the mandala and no side of the object is ever
 *     brighter than the other.
 *
 *   'contiguous' (floor(k / (N / fold)))   → copies 0,1,2 = instance 0
 *                                            copies 3,4,5 = instance 1
 *     Solid arcs. One half of the piece answers, then the other — a wipe.
 *     It breaks the radial symmetry into a left/right split.
 *
 * DEFAULT IS 'interleaved'. The governing aesthetic is a quiet gallery
 * companion where "nothing performs at you" and beats "propagate through the
 * geometry" — an alternating read stays balanced and reads as one breathing
 * organism, while a contiguous read stages a directional sweep that draws the
 * eye and performs. 'contiguous' stays available because a deliberate arc
 * sweep is a real, wanted gesture; it just should not be what you get by
 * accident.
 *
 * When fold >= N every copy is its own instance and both mappings agree.
 */
export function copyToInstance(copyIndex, copies, fold, mapping = DEFAULT_COPY_MAPPING) {
  const n = Math.max(1, Math.trunc(Number(copies)) || 1);
  const f = Math.max(1, Math.trunc(Number(fold)) || 1);
  const raw = Math.trunc(Number(copyIndex));
  const k = Number.isFinite(raw) ? ((raw % n) + n) % n : 0;
  if (f >= n) return k;
  if (f <= 1) return 0;
  if (mapping === 'contiguous') return Math.min(f - 1, Math.floor(k / (n / f)));
  return k % f;
}

/**
 * The phase table for a motif: one phase per INSTANCE, in [0, 1).
 *
 * LENGTH IS `fold`. This is the load-bearing distinction:
 *   foldPhases(1, { spread: 1 })  → [0]                       — one body
 *   foldPhases(6, { spread: 0 })  → [0, 0, 0, 0, 0, 0]        — six, in unison
 *   foldPhases(6, { spread: 1 })  → [0, 1/6, 2/6, 3/6, 4/6, 5/6]
 *
 * `spread` is NOT clamped here: this is the math, and a caller experimenting
 * with a stagger that wraps more than once should be able to. The stored
 * authoring value is clamped to [0, 1] by `normalizeArea`.
 *
 * NOTE (locked aesthetic): the result is a PHASE OFFSET, never a rate. Add it
 * to an authored clock. Multiplying a clock by anything from this table would
 * turn an authoring control into a speed control, which is exactly what the
 * aesthetic forbids.
 */
export function foldPhases(fold, options = {}) {
  const f = clampFold(fold);
  const spread = Number.isFinite(options.spread) ? options.spread : 1;
  const direction = options.direction < 0 ? -1 : 1;
  const offset = Number.isFinite(options.offset) ? options.offset : 0;
  const out = new Array(f);
  for (let j = 0; j < f; j += 1) {
    out[j] = wrap01(offset + direction * spread * (j / f));
  }
  return out;
}

/**
 * The structural expansion of a field into instances, independent of any real
 * strips. This is what the kaleidoscope screen draws ghost echoes from, and
 * what proves the mirror behaviour: a mirrored fold-1 field produces TWO
 * copies, so at fold 2 it produces two instances with `flip` on the second.
 *
 * @returns {Array<{ index, phase, flip, copies: Array<{copyIndex,wedgeIndex,flip}> }>}
 */
export function expandFieldInstances(field, options = {}) {
  const f = normalizeField(field);
  const copies = enumerateCopies(f);
  const n = copies.length;
  const requested = Number.isFinite(options.fold) ? Math.trunc(options.fold) : n;
  const fold = isValidFold(requested, n) ? requested : n;
  const mapping = COPY_MAPPINGS.includes(options.copyMapping) ? options.copyMapping : DEFAULT_COPY_MAPPING;
  const phases = foldPhases(fold, options);
  const buckets = Array.from({ length: fold }, (_, index) => ({
    index,
    phase: phases[index],
    flip: false,
    copies: [],
  }));
  for (const copy of copies) {
    buckets[copyToInstance(copy.copyIndex, n, fold, mapping)].copies.push(copy);
  }
  for (const bucket of buckets) {
    // An instance reads as "flipped" only when every copy in it is flipped —
    // an instance holding a direct/mirrored pair is a symmetric body, not a
    // reflected one.
    bucket.flip = bucket.copies.length > 0 && bucket.copies.every(c => c.flip);
  }
  return buckets;
}

// ── the group's own symmetry record ──────────────────────────────────────────

/**
 * Every strip id in a group, tolerating BOTH group implementations (see the
 * trap note at the top of this file): the reducer prunes on `stripId` alone
 * while the hooks prune on `stripId || pathId`, so members may legitimately
 * carry either key.
 */
export function memberStripIds(group) {
  const members = Array.isArray(group?.members) ? group.members : [];
  return uniqueStrings(members.map(m => m?.stripId || m?.pathId));
}

function normalizeInstance(raw, fold, field) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let wedgeIndex = null;
  if (Number.isFinite(src.wedgeIndex)) {
    const w = Math.trunc(src.wedgeIndex);
    const limit = field ? field.fold : Math.max(1, fold);
    wedgeIndex = ((w % limit) + limit) % limit;
  }
  return {
    stripIds: uniqueStrings(src.stripIds),
    wedgeIndex,
    phase: Number.isFinite(src.phase) ? wrap01(src.phase) : null,
    flip: src.flip === true,
    confirmed: src.confirmed === true,
    source: INSTANCE_SOURCES.includes(src.source) ? src.source : 'manual',
  };
}

/**
 * Normalize a motif's stored `symmetry` record.
 *
 * THE FOLD RULE IS ENFORCED HERE. A fold that does not divide the field's copy
 * count N is REJECTED: it is replaced by N (full independence — every copy its
 * own instance) and the offending value is reported on `foldRejected` so the
 * UI can say so out loud. N rather than 1 is the fallback because the owner
 * asking for "4 of 6" clearly wanted several instances, and collapsing to one
 * body would be a bigger lie than splitting further.
 *
 * @param {object} raw               a group's `symmetry` value
 * @param {object} [options]
 * @param {object} [options.field]   the resolved piece field
 * @param {number} [options.copies]  override for N (defaults to fieldCopyCount)
 * @param {string[]} [options.members] group membership, for pruning stale ids
 */
export function normalizeArea(raw, options = {}) {
  const field = options.field ? normalizeField(options.field) : null;
  const copies = Number.isFinite(options.copies)
    ? Math.max(1, Math.trunc(options.copies))
    : (field ? fieldCopyCount(field) : 1);

  const src = raw && typeof raw === 'object' ? raw : {};
  const requested = Number.isFinite(src.fold) ? Math.trunc(src.fold) : null;
  const valid = requested !== null && isValidFold(requested, copies);
  const fold = valid ? requested : copies;
  const foldRejected = (requested !== null && !valid) ? requested : null;

  const memberSet = Array.isArray(options.members) && options.members.length
    ? new Set(options.members)
    : null;

  const rawInstances = Array.isArray(src.instances) ? src.instances : [];
  const instances = rawInstances
    .map(item => normalizeInstance(item, fold, field))
    .map(inst => (memberSet
      ? { ...inst, stripIds: inst.stripIds.filter(id => memberSet.has(id)) }
      : inst));

  const assigned = new Set();
  for (const inst of instances) for (const id of inst.stripIds) assigned.add(id);
  const unassignedStripIds = memberSet
    ? [...memberSet].filter(id => !assigned.has(id))
    : [];

  return {
    version: SYMMETRY_MODEL_VERSION,
    fieldId: typeof src.fieldId === 'string' && src.fieldId ? src.fieldId : (field ? field.id : null),
    fold,
    foldRejected,
    copies,
    orderMode: ORDER_MODES.includes(src.orderMode) ? src.orderMode : 'field',
    // Clamped to [0, 1] as an AUTHORING range: 1 is a full even stagger all the
    // way around, 0 is unison. `foldPhases` itself does not clamp.
    spread: Math.min(1, Math.max(0, num(src.spread, 1))),
    direction: src.direction < 0 ? -1 : 1,
    copyMapping: COPY_MAPPINGS.includes(src.copyMapping) ? src.copyMapping : DEFAULT_COPY_MAPPING,
    instances,
    unassignedStripIds,
    legacy: false,
  };
}

function legacyAreaSymmetry(members, field) {
  return {
    version: SYMMETRY_MODEL_VERSION,
    fieldId: field ? field.id : null,
    // One body. This is exactly how a pre-symmetry group renders today, which
    // is what makes the migration free.
    fold: 1,
    foldRejected: null,
    copies: field ? fieldCopyCount(field) : 1,
    orderMode: 'manual',
    spread: 1,
    direction: 1,
    copyMapping: DEFAULT_COPY_MAPPING,
    instances: [{
      stripIds: members,
      wedgeIndex: 0,
      phase: 0,
      flip: false,
      confirmed: true,
      source: 'legacy',
    }],
    unassignedStripIds: [],
    legacy: true,
  };
}

/**
 * Read a motif's symmetry off the EXISTING group object without touching it.
 *
 * MIGRATION IS FREE. A group saved before this feature has no `symmetry` key,
 * and this synthesises ONE confirmed instance containing ALL members at fold 1
 * — identical to today's rendering. Nothing is rewritten, nothing is persisted,
 * no project version is bumped. Do not write the result back on load; only
 * write when the owner actually edits the motif.
 *
 * @param {object} group  a strip group (see the shape note at the top)
 * @param {object} [options]
 * @param {object} [options.field]     resolved piece field for this motif
 * @param {Map|Object|Function} [options.geometry]
 * @returns {object} normalized area symmetry (never null)
 */
export function readAreaSymmetry(group, options = {}) {
  const members = memberStripIds(group);
  const field = options.field ? normalizeField(options.field) : null;
  const raw = group && typeof group === 'object' ? group.symmetry : null;
  const hasStored = raw && typeof raw === 'object'
    && Array.isArray(raw.instances) && raw.instances.length > 0;
  if (!hasStored) return legacyAreaSymmetry(members, field);
  return normalizeArea(raw, {
    field,
    copies: Number.isFinite(options.copies) ? options.copies : undefined,
    members,
  });
}

/**
 * Attach a symmetry record to a group without mutating the original. Purely a
 * convenience for the authoring screens; nothing on the read path needs it.
 */
export function withAreaSymmetry(group, symmetry, options = {}) {
  if (!group || typeof group !== 'object') return group;
  if (symmetry === null) {
    const { symmetry: _dropped, ...rest } = group;
    return rest;
  }
  return {
    ...group,
    symmetry: normalizeArea(symmetry, {
      field: options.field,
      copies: options.copies,
      members: memberStripIds(group),
    }),
  };
}

// ── ordering + phases ────────────────────────────────────────────────────────

function rankByAngle(instances, geometry, centre, field = null) {
  const points = instances.map(inst => instanceCentroid(inst.stripIds, geometry));
  // An EMPTY instance (no strips left in it — the gap in a partial fold) has
  // no centroid and no pixels to render; it must not force a "missing
  // geometry" refusal onto the instances that ARE present, nor blow up the
  // angle math below. Only a POPULATED instance with no measurable centroid
  // is a real refusal. Empty instances are excluded from every ranking
  // computation here and get a placeholder rank back (their phase is never
  // observed — nothing renders from them — so any value is safe).
  const populated = [];
  instances.forEach((inst, i) => {
    if (inst.stripIds.length > 0) populated.push(i);
  });
  if (populated.some(i => !points[i])) {
    return { needsUserOrder: true, rank: null, reason: 'missing-geometry' };
  }
  const n = points.length;
  const rank = new Array(n).fill(0);
  if (populated.length < 2) {
    populated.forEach((i, k) => { rank[i] = k; });
    return { needsUserOrder: false, rank, reason: null };
  }

  // FIELD-ABSOLUTE WEDGE FIRST. Two motifs sharing one field must agree on
  // what "wedge 3" means even when one holds all N copies and the other
  // holds only a subset — a rank relative to just THIS motif's own present
  // instances (below) cannot promise that; the field's own geometry can,
  // because wedgeIndexOf(point, field) is a pure function of the point and
  // the shared field, never of what else happens to be in this area. Only
  // used when every populated point resolves to a distinct wedge; a
  // collision (two instances measuring into the same wedge) falls through
  // to the relative ranking below, same as today.
  if (field && field.fold > 1) {
    const wedges = populated.map(i => wedgeIndexOf(points[i], field));
    if (new Set(wedges).size === wedges.length) {
      populated.forEach((i, k) => { rank[i] = wedges[k]; });
      return { needsUserOrder: false, rank, reason: null, absolute: true };
    }
  }

  const populatedPoints = populated.map(i => points[i]);
  const origin = centre || meanPoint(populatedPoints);
  const angles = populatedPoints.map(p => wrapTau(Math.atan2(p.y - origin.y, p.x - origin.x)));
  const m = angles.length;
  const sorted = angles
    .map((a, k) => ({ a, k }))
    .sort((x, y) => (x.a - y.a) || (x.k - y.k));

  let maxGap = 0;
  for (let k = 0; k < m; k += 1) {
    const next = sorted[(k + 1) % m];
    const gap = k === m - 1 ? (TAU - sorted[k].a + next.a) : (next.a - sorted[k].a);
    if (gap > maxGap) maxGap = gap;
  }
  // Everything huddled in one corner: an angular order would be arbitrary and
  // would look wrong on the wall. Refuse rather than invent one.
  if (maxGap > TAU - (TAU / m) * CLUSTER_GAP_FACTOR) {
    return { needsUserOrder: true, rank: null, reason: 'clustered' };
  }

  const localRank = new Array(m);
  sorted.forEach((entry, position) => { localRank[entry.k] = position; });
  populated.forEach((i, k) => { rank[i] = localRank[k]; });
  return { needsUserOrder: false, rank, reason: null };
}

/**
 * Turn a motif's symmetry record into one phase per instance.
 *
 * ORDERING POLICY:
 *   'field'  — THE ROTATIONAL CASE, and the default. The phase comes straight
 *              from wedgeIndex via the copy→instance mapping. No angle sorting,
 *              no heuristic, no geometry needed: wedge 3 of 6 IS instance 3.
 *              This is the whole point of declaring the symmetry once.
 *   'angle'  — FALLBACK ONLY, for scattered non-angular sets that have no
 *              wedge index. Instances are ordered by the angle of their
 *              centroid about the field centre. If their centroids are all
 *              clustered in one corner (largest gap > TAU - (TAU/n)*0.75), or
 *              if any centroid is unknown, this REFUSES and returns
 *              `needsUserOrder: true` instead of inventing an order.
 *   'manual' — array order, and an instance's authored `phase` wins if set.
 *
 * When `needsUserOrder` is true every phase is the base offset — the motif
 * still renders, it simply does not ripple until the owner orders it. That is
 * an honest unison, not a spread-0 unison: `needsUserOrder` distinguishes them
 * and the UI must say "tell me the order" rather than pretend it knows.
 *
 * NO AUDIO INPUT. See the locked-aesthetic note at the top of this file.
 *
 * @param {object} area    normalized or raw area symmetry
 * @param {object} [field] resolved piece field
 * @param {object} [options] { spread, direction, offset, copyMapping, geometry, centre, members }
 */
export function deriveInstancePhases(area, field = null, options = {}) {
  const f = field ? normalizeField(field) : null;
  const fallbackCopies = Math.max(1, Array.isArray(area?.instances) ? area.instances.length : 1);
  const copies = f ? fieldCopyCount(f) : (Number.isFinite(area?.copies) ? area.copies : fallbackCopies);
  const sym = normalizeArea(area, { field: f, copies, members: options.members });

  const fold = sym.fold;
  const mapping = COPY_MAPPINGS.includes(options.copyMapping) ? options.copyMapping : sym.copyMapping;
  const spread = Number.isFinite(options.spread) ? options.spread : sym.spread;
  const direction = Number.isFinite(options.direction)
    ? (options.direction < 0 ? -1 : 1)
    : sym.direction;
  const offset = Number.isFinite(options.offset) ? options.offset : 0;
  const phaseTable = foldPhases(fold, { spread, direction, offset });

  const geometry = options.geometry || null;
  const centre = options.centre || (f ? f.centre : null);

  let resolvedMode = sym.orderMode;
  let order = null;
  let needsUserOrder = false;
  let orderReason = null;

  if (resolvedMode === 'field') {
    // An EMPTY instance (the gap in a partial fold — no strips assigned) is
    // exempt from the wedge-index requirement: it renders nothing, so it
    // must not be able to knock the WHOLE motif out of field mode and
    // re-time every surviving, fully-authored instance onto array order.
    // That silent re-timing is exactly what "a gap in the wave, not a
    // re-timed wave" forbids.
    const usable = f && sym.instances.length > 0
      && sym.instances.every(inst => inst.stripIds.length === 0 || Number.isFinite(inst.wedgeIndex));
    if (usable) {
      order = sym.instances.map(inst => copyToInstance(
        copyIndexOf(inst.wedgeIndex, inst.flip, f), copies, fold, mapping,
      ));
    } else {
      // No wedge information at all — the rotational answer is unavailable.
      resolvedMode = geometry ? 'angle' : 'manual';
      orderReason = 'no-wedge-index';
    }
  }

  if (resolvedMode === 'angle' && order === null) {
    const ranked = rankByAngle(sym.instances, geometry, centre, f);
    if (ranked.needsUserOrder) {
      needsUserOrder = true;
      orderReason = ranked.reason;
    } else if (ranked.absolute && f) {
      // `ranked.rank` holds an absolute field WEDGE per instance (shared
      // across every motif on this field), not a rank relative to this
      // motif alone — route it through the same copy→instance math 'field'
      // mode uses, rather than a bare modulo.
      order = ranked.rank.map(wedge => copyToInstance(
        copyIndexOf(wedge, false, f), copies, fold, mapping,
      ));
    } else {
      order = ranked.rank.map(r => r % fold);
    }
  }

  if (resolvedMode === 'manual' && order === null && !needsUserOrder) {
    order = sym.instances.map((_, i) => i % fold);
  }

  const base = wrap01(offset);
  const phases = sym.instances.map((inst, i) => {
    if (needsUserOrder || !order) return base;
    // An authored phase is honoured only in 'manual' — that is what makes
    // manual mode manual. In 'field'/'angle' the structure decides.
    if (resolvedMode === 'manual' && inst.phase !== null) return inst.phase;
    return phaseTable[order[i] % phaseTable.length];
  });

  return {
    fold,
    copies,
    copyMapping: mapping,
    spread,
    direction,
    orderMode: resolvedMode,
    needsUserOrder,
    orderReason,
    order: needsUserOrder ? null : order,
    phaseTable,
    phases,
    foldRejected: sym.foldRejected,
    legacy: sym.legacy,
    unassignedStripIds: sym.unassignedStripIds,
    instances: sym.instances.map((inst, i) => ({
      ...inst,
      order: needsUserOrder || !order ? null : order[i],
      phase: phases[i],
    })),
  };
}
