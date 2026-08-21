// showAreaBinding.js — the hot-path precompute that maps symmetry motifs onto
// pixels. Pure ESM, no React/DOM/audio. Consumes the shapes defined in
// symmetryFields.js and the per-pixel samples produced by
// createConnectedSpatialTemplate() in showSpatialTemplate.js (read, not
// edited, by this module).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS MODULE EXISTS
//
// symmetryFields.js answers "what phase does instance i have right now" as a
// small array of numbers, recomputed once per layout change. Turning that into
// per-pixel colour every frame means walking every pixel of every symmetric
// area and asking "which instance am I, and what is my position inside it in
// wedge-local coordinates". Doing that walk-and-derive PER PIXEL PER FRAME is
// the expensive part: it destructures a sample object and runs trig on every
// pixel, 30-60 times a second. This module does that walk ONCE, at bind time
// (project load / layout change), and flattens the result into typed arrays
// an effect can stream through with no per-pixel branching.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO RULES THAT MUST NOT BE RELAXED
//
// 1. `pixelIndex` is sorted by (instance, outputIndex), so every instance's
//    pixels form one CONTIGUOUS run (`instanceStart[k] .. instanceStart[k+1]`).
//    A caller reads/derives the instance's phase ONCE PER RUN and applies it
//    to every pixel in that run — not once per pixel. That contiguity is the
//    entire performance design; do not reorder pixelIndex by anything else.
// 2. ALL per-pixel geometry is flattened into typed arrays (`u`, `vRad`,
//    `angLoc`, `ang`, `x`, `y`, `r`, `seed`, `mirrored`) at bind time. Existing
//    effects destructure a sample object per pixel per frame — that deref is
//    the real cost today. Nothing downstream of this module may go back to
//    reading fields off a per-pixel object in the frame loop.
//
// ─────────────────────────────────────────────────────────────────────────────
// MIRRORING IS BAKED IN HERE, NEVER IN THE KERNEL
//
//   u      = mirrored ? 1 - stripProgress : stripProgress
//   angLoc = mirrored ? -(ang - centreAngle[k]) : (ang - centreAngle[k])
//            wrapped to -PI..PI
//
// No downstream effect may contain a mirror branch. If a pattern needs to
// know "am I mirrored", it reads `mirrored[i]` — it must not re-derive it.
//
// ─────────────────────────────────────────────────────────────────────────────
// TRAP: DERIVE STRUCTURE FROM THE LAYOUT, NEVER FROM THE RENDER TEMPLATE
//
// `createConnectedSpatialTemplate()` SKIPS hidden strips — its `outputIndex`
// values and pixel count depend on which strips are currently visible. If
// this module counted wedges, instances, or fold by scanning the template, a
// visitor hiding ONE arm of a six-fold motif would renumber every remaining
// arm's wedge index, and phases would jump. So every structural quantity here
// — `fold`, the instance count, which strips belong to which instance and
// wedge — comes ONLY from the authored, layout-level shapes (`fields`,
// `areas[].instances[]`, both from symmetryFields.js, which already encode
// full membership independent of visibility). The template is consulted only
// to ask "does this strip currently have visible pixels, and where are they"
// — never "how many wedges/instances exist". A hidden strip's instance still
// occupies its slot in `instanceStart`; it just contributes a zero-length run.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO AUDIO IN, EVER (see symmetryFields.js's locked-aesthetic note). Nothing
// exported here accepts a band value, and every number produced is a pure
// function of geometry + the authored field/area records. A consumer applies
// an instance's audio-modulated envelope to amplitude/breadth/contrast at
// render time — never to anything computed in this file.
//
// ─────────────────────────────────────────────────────────────────────────────
// INPUT CONTRACTS (this module does not persist or own these shapes)
//
// `fields` — a piece's symmetry fields, any form `normalizeFields()` from
//   symmetryFields.js accepts (raw or already-normalized).
//
// `template` — the array returned by `createConnectedSpatialTemplate()`:
//   `{ outputIndex, stripId, stripIndex, stripProgress, x, y, radius, angle }`
//   per visible pixel, ARTWORK-normalized coordinates.
//
// `areas` — one entry per symmetric motif, already resolved by the caller
//   through symmetryFields.js (`readAreaSymmetry` / `deriveInstancePhases`):
//     { areaId: string, fieldId: string|null,
//       instances: [{ stripIds: string[], wedgeIndex: number|null, flip: boolean }] }
//   `instances.length` IS the instance count for that area (already reduced
//   from the field's raw copy count down to the motif's own fold by
//   symmetryFields.js — this module does not re-apply the fold rule). Array
//   position `k` in `instances` is instance `k` in the resulting binding;
//   this module does not reorder instances relative to their given array
//   position. A `wedgeIndex` of `null` falls back to the instance's own
//   array position, so an area with no field (fold-1, one instance) still
//   binds correctly with `wedgeIndex: 0`/`null`.
// ─────────────────────────────────────────────────────────────────────────────

import { normalizeFields } from './symmetryFields.js';

const TAU = Math.PI * 2;

function wrapTau(angle) {
  if (!Number.isFinite(angle)) return 0;
  const a = angle % TAU;
  return a < 0 ? a + TAU : a;
}

/** Wrap an angle difference into (-PI, PI]. */
function wrapPI(angle) {
  if (!Number.isFinite(angle)) return 0;
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

/** Deterministic 32-bit FNV-1a hash, used only to seed per-pixel sparkle/noise. */
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function groupTemplateByStrip(template) {
  const map = new Map();
  const list = Array.isArray(template) ? template : [];
  for (const px of list) {
    if (!px || typeof px.stripId !== 'string') continue;
    let bucket = map.get(px.stripId);
    if (!bucket) {
      bucket = [];
      map.set(px.stripId, bucket);
    }
    bucket.push(px);
  }
  return map;
}

/**
 * Rank each value ascending, stable on ties (original index breaks ties).
 * Returns an Int8Array that is always a PERMUTATION of 0..values.length-1 —
 * every rank is used exactly once, by construction.
 */
function rankOf(values) {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => (values[a] - values[b]) || (a - b));
  const rank = new Int8Array(n);
  order.forEach((originalIndex, position) => {
    rank[originalIndex] = position;
  });
  return rank;
}

function normalizeAreaList(areas) {
  const list = Array.isArray(areas) ? areas : [];
  return list.map((area) => {
    const src = area && typeof area === 'object' ? area : {};
    const instances = Array.isArray(src.instances) && src.instances.length
      ? src.instances
      : [{ stripIds: [], wedgeIndex: 0, flip: false }];
    return {
      areaId: typeof src.areaId === 'string' ? src.areaId : null,
      fieldId: typeof src.fieldId === 'string' ? src.fieldId : null,
      instances,
    };
  });
}

/**
 * Build one FieldBinding per field, describing each of its wedges' physical
 * centre angle and centre radius. This is what lets `bindAreas` turn a raw
 * pixel angle into a wedge-LOCAL angle (`angLoc`) without re-deriving the
 * wedge geometry per pixel per frame.
 *
 * The centre of wedge `k` is the circular mean angle / mean radius of every
 * CURRENTLY VISIBLE pixel belonging to a strip assigned to wedge `k` by any
 * area bound to this field (structural assignment, per the trap note above —
 * wedge membership comes from `area.instances[].wedgeIndex`, not from
 * scanning the template for "how many wedges appear"). When a wedge has no
 * visible pixels at all (every strip in it hidden, or no area uses this
 * field yet), it falls back to the field's own authored geometry:
 * `rotationOffset + (k + 0.5) * (TAU / fold)`, radius 0 — still a valid,
 * stable number, just not measured.
 *
 * @param {Array} fields   piece-level symmetry fields (raw or normalized)
 * @param {Array} areas    resolved areas, see the module header contract
 * @param {Array} template output of createConnectedSpatialTemplate()
 * @returns {Map<string, object>} fieldId → FieldBinding
 */
export function bindFields(fields, areas, template) {
  const fieldList = normalizeFields(fields);
  const areaList = normalizeAreaList(areas);
  const pixelsByStrip = groupTemplateByStrip(template);
  const out = new Map();

  for (const field of fieldList) {
    const fold = Math.max(1, Math.trunc(field.fold) || 1);
    const sinSum = new Float64Array(fold);
    const cosSum = new Float64Array(fold);
    const radiusSum = new Float64Array(fold);
    const count = new Float64Array(fold);

    for (const area of areaList) {
      if (area.fieldId !== field.id) continue;
      area.instances.forEach((inst, idx) => {
        const wedge = Number.isFinite(inst?.wedgeIndex)
          ? (((Math.trunc(inst.wedgeIndex) % fold) + fold) % fold)
          : (idx % fold);
        const stripIds = Array.isArray(inst?.stripIds) ? inst.stripIds : [];
        for (const stripId of stripIds) {
          const pxs = pixelsByStrip.get(stripId);
          if (!pxs) continue;
          for (const px of pxs) {
            sinSum[wedge] += Math.sin(px.angle);
            cosSum[wedge] += Math.cos(px.angle);
            radiusSum[wedge] += px.radius;
            count[wedge] += 1;
          }
        }
      });
    }

    const centreAngle = new Float32Array(fold);
    const centreRadius = new Float32Array(fold);
    for (let k = 0; k < fold; k += 1) {
      if (count[k] > 0) {
        centreAngle[k] = wrapTau(Math.atan2(sinSum[k] / count[k], cosSum[k] / count[k]));
        centreRadius[k] = radiusSum[k] / count[k];
      } else {
        centreAngle[k] = wrapTau(field.rotationOffset + (k + 0.5) * (TAU / fold));
        centreRadius[k] = 0;
      }
    }

    out.set(field.id, {
      fieldId: field.id,
      fold,
      centreAngle,
      centreRadius,
      angularOrder: rankOf(centreAngle),
      radialRank: rankOf(centreRadius),
    });
  }

  return out;
}

function bindOneArea(area, fieldById, pixelsByStrip, fieldBindings) {
  const field = area.fieldId ? (fieldById.get(area.fieldId) || null) : null;
  const fb = area.fieldId && fieldBindings ? (fieldBindings.get(area.fieldId) || null) : null;
  const instances = area.instances;
  const fold = instances.length;

  const perInstanceRows = Array.from({ length: fold }, () => []);

  instances.forEach((inst, idx) => {
    const mirrored = inst?.flip === true;
    const wedge = Number.isFinite(inst?.wedgeIndex)
      ? (((Math.trunc(inst.wedgeIndex) % fold) + fold) % fold)
      : (idx % fold);
    const centreAngle = fb ? fb.centreAngle[wedge % fb.fold] : (field ? field.rotationOffset : 0);
    const stripIds = Array.isArray(inst?.stripIds) ? inst.stripIds : [];

    for (const stripId of stripIds) {
      const pxs = pixelsByStrip.get(stripId);
      if (!pxs) continue;
      for (const px of pxs) {
        const stripProgress = Number.isFinite(px.stripProgress) ? px.stripProgress : 0;
        const rawLocal = wrapPI(px.angle - centreAngle);
        perInstanceRows[idx].push({
          outputIndex: px.outputIndex,
          u: mirrored ? 1 - stripProgress : stripProgress,
          vRad: stripProgress * TAU,
          angLoc: mirrored ? -rawLocal : rawLocal,
          ang: px.angle,
          x: px.x,
          y: px.y,
          r: px.radius,
          seed: hashSeed(`${stripId}:${px.outputIndex}`),
          mirrored: mirrored ? 1 : 0,
        });
      }
    }
    // Stable within-instance order so the run is reproducible bind to bind.
    perInstanceRows[idx].sort((a, b) => a.outputIndex - b.outputIndex);
  });

  const instanceStart = new Int32Array(fold + 1);
  let total = 0;
  for (let k = 0; k < fold; k += 1) {
    instanceStart[k] = total;
    total += perInstanceRows[k].length;
  }
  instanceStart[fold] = total;

  const pixelIndex = new Int32Array(total);
  const u = new Float32Array(total);
  const vRad = new Float32Array(total);
  const angLoc = new Float32Array(total);
  const ang = new Float32Array(total);
  const x = new Float32Array(total);
  const y = new Float32Array(total);
  const r = new Float32Array(total);
  const seed = new Int32Array(total);
  const mirroredArr = new Uint8Array(total);

  let i = 0;
  for (let k = 0; k < fold; k += 1) {
    for (const row of perInstanceRows[k]) {
      pixelIndex[i] = row.outputIndex;
      u[i] = row.u;
      vRad[i] = row.vRad;
      angLoc[i] = row.angLoc;
      ang[i] = row.ang;
      x[i] = row.x;
      y[i] = row.y;
      r[i] = row.r;
      seed[i] = row.seed;
      mirroredArr[i] = row.mirrored;
      i += 1;
    }
  }

  return {
    areaId: area.areaId,
    fieldId: area.fieldId,
    fold,
    count: total,
    pixelIndex,
    instanceStart,
    u,
    vRad,
    angLoc,
    ang,
    x,
    y,
    r,
    seed,
    mirrored: mirroredArr,
  };
}

/**
 * Build one AreaBinding per area — the hot-path structure. See the module
 * header for the two rules (contiguous-by-instance, fully flattened) that
 * govern its shape.
 *
 * @param {Array} areas          resolved areas, see module header contract
 * @param {Array} fields         piece-level symmetry fields (raw or normalized)
 * @param {Array} template       output of createConnectedSpatialTemplate()
 * @param {Map} fieldBindings    output of bindFields() (may be empty/undefined)
 * @returns {Array} AreaBinding[]
 */
export function bindAreas(areas, fields, template, fieldBindings) {
  const areaList = normalizeAreaList(areas);
  const fieldList = normalizeFields(fields);
  const fieldById = new Map(fieldList.map((f) => [f.id, f]));
  const pixelsByStrip = groupTemplateByStrip(template);
  return areaList.map((area) => bindOneArea(area, fieldById, pixelsByStrip, fieldBindings));
}

/**
 * Build the inspection table used for canvas tinting / debugging / tests —
 * NOT part of the hot render path. For every output pixel 0..total-1:
 *   areaOf[i]     — index into the `areaBindings` array that owns pixel i, or -1
 *   fieldOf[i]    — ordinal of that area's field (assigned in first-seen
 *                   order across `areaBindings`; stored in a signed byte, so
 *                   only meaningful up to 127 distinct fields), or -1
 *   instanceOf[i] — the instance (wedge) index within its area, or the
 *                   unsigned sentinel 255 (Uint8Array cannot hold -1; 255 is
 *                   the "no field" value — never a real instance index,
 *                   since AreaBinding.fold is capped well under 255 by
 *                   symmetryFields.js's MAX_FOLD)
 *
 * @param {Array} areaBindings  output of bindAreas()
 * @param {number} total        total pixel count (template length)
 */
export function bindPixelIndex(areaBindings, total) {
  const n = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  const areaOf = new Int16Array(n).fill(-1);
  const fieldOf = new Int8Array(n).fill(-1);
  const instanceOf = new Uint8Array(n).fill(255);

  const list = Array.isArray(areaBindings) ? areaBindings : [];
  const fieldOrdinal = new Map();

  list.forEach((binding, areaIdx) => {
    if (!binding) return;
    let fOrd = -1;
    if (binding.fieldId != null) {
      if (!fieldOrdinal.has(binding.fieldId)) fieldOrdinal.set(binding.fieldId, fieldOrdinal.size);
      fOrd = fieldOrdinal.get(binding.fieldId);
    }
    for (let k = 0; k < binding.fold; k += 1) {
      const start = binding.instanceStart[k];
      const end = binding.instanceStart[k + 1];
      for (let i = start; i < end; i += 1) {
        const outputIndex = binding.pixelIndex[i];
        if (outputIndex < 0 || outputIndex >= n) continue;
        areaOf[outputIndex] = areaIdx;
        fieldOf[outputIndex] = fOrd;
        instanceOf[outputIndex] = k;
      }
    }
  });

  return { areaOf, fieldOf, instanceOf };
}
