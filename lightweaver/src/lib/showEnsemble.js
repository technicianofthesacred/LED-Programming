// showEnsemble.js — the Show runtime that lets DIFFERENT AREAS OF THE PIECE
// LISTEN TO DIFFERENT SOUNDS AT ONCE. Pure ESM: no React, no DOM, no audio
// capture. It joins the four modules built ahead of it —
//
//   showComposition.js   the saved Program (fields + areas + voices + ground)
//   symmetryFields.js    the authored symmetry model (via showAreaBinding)
//   showAreaBinding.js   the bind-time flattening of motif -> pixels
//   showCharacters.js    the five audio-reactive voice characters
//
// — into one per-frame call, `tickVoices(target, ctx)`.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE ENGINE, ONE FLAT ACCUMULATOR, N MASKED KERNELS
//
// The tempting shape is "instantiate one mandalaEngine per voice and mix the
// outputs". That is a CORRECTNESS bug, not merely waste: each engine carries
// its own auto-gain, its own onset detector and its own authored clocks. N
// auto-gains chasing the same signal fight each other — every one of them
// normalizes the loudest thing IT can see, so a quiet voice on a quiet area
// silently ramps itself up to match a loud voice on a loud area, and the
// mix's relative dynamics (the entire point of an ensemble) collapse. N onset
// detectors also fire at N slightly different instants, which reads as smear
// rather than as one hit.
//
// So there is exactly ONE accumulator (`target`, a Float32Array the caller
// owns) and N kernels that ADD into masked pixel ranges of it. Gain, onset
// and band extraction happen upstream, ONCE, in showAudioFeatures.js, and
// arrive here as `ctx.bands`. Nothing in this file computes an auto-gain.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LOCKED AESTHETIC IS STRUCTURAL HERE TOO
//
// Audio may modulate amplitude, breadth, contrast, position, texture. Audio
// may NEVER modulate an authored clock or rotation speed. This file cannot
// break that rule even by accident, because it never computes a clock: every
// clock lives inside a character's `tick(vr, ctx)` in showCharacters.js,
// which advances it by a literal constant times `ctx.dt`. What THIS module
// contributes per instance is `vr.phase` — a 0..1 OFFSET that characters
// only ever ADD to a clock reading or use as an angular offset. `phase` is a
// pure function of `field.angularOrder` / `field.radialRank` (bind-time
// geometry) and the voice's authored `spread` / `direction`. No band value
// reaches `instancePhase()`; it has no access to `ctx` at all — that is
// enforced by its signature, and asserted by a test.
//
// ─────────────────────────────────────────────────────────────────────────────
// PER-FRAME ORDER (the order is the design; do not reorder)
//
//   0. zero `target`
//   1. GROUND pass — the Glow kernel over the WHOLE template, so the piece
//      reads as one organism rather than a patchwork of gadgets. Ground
//      works over real x/y and radius; it knows nothing about instances, so
//      it crosses field boundaries naturally and is what "silence decays to
//      a dim living-coal field, never black" looks like.
//   2. for each voice, in stable composition order:
//        ch.tick(vr, ctx)                             ONCE per voice
//        for k in 0..area.fold-1:
//          vr.phase = instancePhase(field, voice, k)  per instance
//          ch.kernel(area, instanceStart[k], instanceStart[k+1], target, vr, ctx)
//      Because `area.pixelIndex` is sorted by instance (showAreaBinding's
//      rule 1), each k is one contiguous run and the phase is read once per
//      run, not once per pixel.
//   3. SOFT CLIP the accumulator (knee at 0.75 — see below)
//   4. resolve palette zones with hysteresis (see below)
//
// ─────────────────────────────────────────────────────────────────────────────
// EACH VOICE LISTENS TO ITS OWN BAND (this is the whole point of an ensemble)
//
// A voice's authored `band` is the sound IT reacts to — that is what lets the
// bass do one thing and the highs another in the same piece. showCharacters.js
// exposes no way to hardcode a band any more: every character reads
// `readVoiceBand(ctx, itsOwnRecommendedBand)`, and `ctx.band` is set here,
// once per voice per frame, from `voice.band`.
//
// The band is read from the RAW composition, like the character is (see
// collision 1 below), because normalizeComposition() rewrites an absent band
// to its own default ('mid'), which would silently re-point every unauthored
// voice at the mid band instead of leaving it on its character's own
// recommendation. Raw is the only place "the author chose nothing" survives.
//
// Two fallbacks, both in readVoiceBand() and both deliberate: a voice that
// names no band (or 'none') keeps its character's recommended band, and a
// voice naming a band THIS audio source does not produce also falls back
// rather than going silent.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LIVING-COAL FLOOR — "never black" is enforced here, not authored
//
// The aesthetic spec says the piece decays to a dim living-coal field and
// NEVER to black. The ground layer is what paints that field, but the ground
// is an AUTHORED setting: `ground.enabled: false` used to mean a silent piece
// went to hard zero, and even with the ground on at its 0.12 default, silence
// landed near 0.017 (~4/255) — technically alive, visually black.
//
// So LIVING_COAL_FLOOR is applied to every pixel as the last step of every
// frame, after the soft clip, and no authored setting can defeat it. It is
// not a replacement for the ground layer — the ground is what makes the floor
// breathe and drift; the floor is what makes "never black" a fact.
//
// ─────────────────────────────────────────────────────────────────────────────
// SOFT CLIP WITH A KNEE — the authored look below 0.75 is BYTE-IDENTICAL
//
//   softClip(x) = x <= 0.75 ? x : 0.75 + 0.25 * (1 - exp(-(x - 0.75) / 0.25))
//
// Monotone, continuous, f(0.75) === 0.75 exactly, and it approaches 1
// asymptotically — it never overshoots and never wraps. (Be precise about the
// asymptote: mathematically it is strictly below 1, but above x ~= 9.7 the
// remaining gap falls under a double's resolution and the result rounds to
// exactly 1.0. That is full brightness, a legal value, not an overflow.)
// The `x <= KNEE` early return is not an optimization — it is the guarantee
// that a single voice playing alone produces the exact same bytes it would
// have produced with no ensemble around it. Only the sum of overlapping
// voices ever reaches the curved part.
//
// ─────────────────────────────────────────────────────────────────────────────
// PALETTE ZONES NEED HYSTERESIS — THIS IS NOT OPTIONAL POLISH
//
// Each voice declares a zone (its palette). `zoneOf[i]` is set by the voice
// contributing the MOST at pixel i. Without hysteresis, two voices that
// overlap at similar strength swap ownership of the same pixel every frame
// as their envelopes wobble past each other, and the pixel's palette
// alternates at frame rate. That is a visible, ugly flicker on a wall piece.
//
// So the incumbent owner (carried across frames in `zoneOwner`) keeps the
// pixel unless a challenger beats it by ZONE_HYSTERESIS (15%) THIS frame:
//
//   if (bestChallenger > incumbentContribution * 1.15) -> hand over
//
// Contribution is measured by diffing the accumulator across a voice's own
// kernel calls, over that voice's own pixels only — so it is the voice's
// actual light at that pixel, not a proxy for it.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO NAMING COLLISIONS BETWEEN THE MODULES THIS JOINS (deliberate bridges,
// not bugs — both are adapted here rather than by editing another agent's file)
//
// 1. `voice.character`. showComposition.js's VOICE_CHARACTERS is
//    ['amplitude','breadth','contrast','position','texture'] — the five
//    MODULATION TARGETS the locked aesthetic permits. showCharacters.js's
//    CHARACTERS is {swell,twinkle,ripple,glow,trace} — the five INSTRUMENTS.
//    Two different vocabularies under one field name, and
//    `normalizeComposition()` rewrites anything outside its own list to
//    'amplitude'. So this module reads the character from the RAW
//    composition (before normalization), preferring `voice.characterKey`,
//    then `voice.character`, and falls back to GROUND_CHARACTER ('glow')
//    with an `unknown-character` warning rather than guessing a mapping
//    between two vocabularies that were never meant to be one. Reconciling
//    the two field names is a later, separate change; nothing here depends
//    on which way it goes.
//
// 2. Pixel geometry field names. showAreaBinding.js emits `r` / `ang`;
//    showCharacters.js kernels read `radius` / `angle`. `kernelView()` below
//    attaches the two aliases onto the binding once at bind time (they are
//    the SAME typed arrays, not copies), so neither module has to move.
//
// ─────────────────────────────────────────────────────────────────────────────
// WIRING NOTE for src/v3/lw-show.jsx and mandalaEngine.js (NEITHER EDITED —
// a later session owns them; this is the same forward-note convention
// symmetryFields.js and showCharacters.js use)
//
// mandalaEngine.js currently paints the whole piece with one mode step:
//
//   line ~907 (grep `STEPS[mode]` — it is the only occurrence):
//     const lead = (STEPS[mode] || fxStrata)(fxCtx, wholePiece, 0, wholePiece.count, target);
//
// The one-line swap that makes the engine ensemble-driven is to replace that
// single call with:
//
//   const lead = ensemble.tickVoices(target, fxCtx).label;
//
// where `ensemble` is a module-scope `createEnsembleRuntime({ template, composition })`
// built in `installTemplate()` alongside `wholePiece`. Everything downstream
// of that line (fill lift, coal floor, beat substrate, hit blooms, silence
// decay, envelope, palette, dark gate, master/overdrive, wire gamma) is
// unchanged — `target` is the same Float32Array in the same units.
//
// Two constraints on whoever makes that swap:
//   - `fxCtx` must gain a `bands` object ({bass,mid,high,energy,beat}) for
//     characters to read. The engine already has those values (`CLK`/`F`);
//     this is a re-shape, not new analysis.
//   - AT MOST ONE 'mode' voice per composition. The nine fx* effects keep
//     module-scoped mutable clocks (`spiralTheta`, `latticePhase`, …) that
//     are per-ENGINE, not per-voice; two mode voices would share and
//     double-advance one set of authored clocks. showComposition.js already
//     enforces the cap (`isModeVoice`). This runtime does not render mode
//     voices at all — it renders the five showCharacters instruments, which
//     are stateless-per-voice by construction.
// ─────────────────────────────────────────────────────────────────────────────

import { bindAreas, bindFields } from './showAreaBinding.js';
import { CHARACTERS, Glow, cloneVoiceState } from './showCharacters.js';
import { AUDIO_BANDS, normalizeComposition, resolveComposition } from './showComposition.js';

/** Below this the accumulator passes through untouched — see header. */
export const CLIP_KNEE = 0.75;

/** A challenger must beat the incumbent by this fraction to take a pixel's zone. */
export const ZONE_HYSTERESIS = 0.15;

/** The ground layer's instrument, and the fallback when a voice names a
 * character this runtime doesn't have. Glow is the dim living-coal field. */
export const GROUND_CHARACTER = 'glow';

/** Zone name reported for any pixel no voice owns. */
export const GROUND_ZONE = 'ground';

/**
 * The hard minimum every pixel is held at, every frame, after everything
 * else. ~0.039 is about 10/255 once the engine maps the accumulator to bytes:
 * a visible ember rather than a technically-non-zero black. (Silence used to
 * land near 0.017, about 4/255, and the ground layer could be switched off
 * entirely for a hard zero.)
 *
 * The exact value is 5/128, which is representable EXACTLY in a float32, so
 * the floor survives a Float32Array accumulator byte for byte and a test can
 * assert equality against it rather than a tolerance.
 *
 * This is deliberately NOT authorable. Turning the ground layer off is a
 * legitimate authoring choice (it means "I want my voices alone, no wash");
 * it is not a way to make the piece go dark, and before this floor existed it
 * was exactly that.
 */
export const LIVING_COAL_FLOOR = 0.0390625;   // 5/128 — exact in float32

const ZONE_UNOWNED = -1;

/**
 * Monotone soft clip with a knee. Identity at or below CLIP_KNEE (so a lone
 * voice is byte-identical to the no-ensemble case), asymptotic toward 1 above
 * it. f(CLIP_KNEE) === CLIP_KNEE exactly. Never exceeds 1.
 */
export function softClip(x) {
  if (!(x > CLIP_KNEE)) return x;
  const span = 1 - CLIP_KNEE;
  return CLIP_KNEE + span * (1 - Math.exp(-(x - CLIP_KNEE) / span));
}

/**
 * The zone hand-over rule, isolated so it is directly testable. A challenger
 * takes a pixel's palette only by beating the incumbent's CURRENT-FRAME
 * contribution by the hysteresis margin. Exactly the margin is not enough —
 * ties and near-ties belong to whoever already holds the pixel, which is the
 * whole point.
 */
export function zoneChallengeWins(incumbentContribution, challengerContribution) {
  return challengerContribution > incumbentContribution * (1 + ZONE_HYSTERESIS);
}

/**
 * The per-instance phase OFFSET, in 0..1 of one authored cycle.
 *
 * NOTE THE SIGNATURE: no `ctx`, therefore no bands, therefore audio cannot
 * reach a phase. Everything here is bind-time geometry (`field.angularOrder`,
 * `field.radialRank`) and authored constants (`voice.spread`,
 * `voice.direction`).
 *
 * spread 0 is UNISON — a bass hit is one bloom over the whole motif.
 * spread 1 staggers the instances evenly across one full cycle, so the same
 * hit becomes a wave travelling around the piece.
 *
 * @param {object|null} field  a FieldBinding from bindFields()
 * @param {object} voice       { spread, direction, wedgeOf? }
 * @param {number} k           instance index within the area
 */
export function instancePhase(field, voice, k) {
  if (!field || !(field.fold > 1)) return 0;
  const spread = Number.isFinite(voice?.spread) ? voice.spread : 0;
  if (!(spread > 0)) return 0;

  const N = field.fold;
  // The area's instance k sits in this field wedge. `wedgeOf` is captured at
  // resolve time from the authored instance index, so an area whose fold
  // differs from its field's still lands on the right wedge.
  const wedge = Array.isArray(voice?.wedgeOf) && Number.isFinite(voice.wedgeOf[k])
    ? (((voice.wedgeOf[k] % N) + N) % N)
    : (((k % N) + N) % N);

  const direction = voice?.direction;
  let ord;
  if (direction === 'ccw') ord = (N - field.angularOrder[wedge]) % N;
  else if (direction === 'centre-out') ord = field.radialRank[wedge];
  else ord = field.angularOrder[wedge];

  return (ord / N) * spread;
}

/**
 * Normalize the several spellings of `direction` this codebase carries.
 * showComposition.js stores 1 | -1; the ensemble vocabulary is
 * 'cw' | 'ccw' | 'centre-out'. Both are accepted; unknown values are 'cw'.
 */
export function normalizeDirection(raw) {
  if (raw === 'ccw' || raw === -1 || raw === '-1') return 'ccw';
  if (raw === 'centre-out' || raw === 'center-out' || raw === 'radial') return 'centre-out';
  return 'cw';
}

/** FNV-1a — the SAME seed formula showAreaBinding.js uses, so a pixel's
 * ground seed and its area seed agree. */
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** Attach the `radius`/`angle` aliases showCharacters kernels read onto a
 * binding from showAreaBinding (same typed arrays — see header collision 2). */
function kernelView(binding) {
  if (!binding) return null;
  binding.radius = binding.r;
  binding.angle = binding.ang;
  return binding;
}

/**
 * The identity binding for the ground pass: every template pixel, one
 * instance, template order. Chain-inactive pixels (`stripId === null`, from
 * a patch board's gaps) are INCLUDED — they are not wired to anything, and
 * including them keeps `pixelIndex[j] === j`, which is what makes the ground
 * pass a straight linear walk.
 */
function buildGroundBinding(template) {
  const list = Array.isArray(template) ? template : [];
  const n = list.length;
  const pixelIndex = new Int32Array(n);
  const radius = new Float32Array(n);
  const angle = new Float32Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const seed = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const px = list[i] || {};
    pixelIndex[i] = i;
    radius[i] = Number.isFinite(px.radius) ? px.radius : 0;
    angle[i] = Number.isFinite(px.angle) ? px.angle : 0;
    x[i] = Number.isFinite(px.x) ? px.x : 0;
    y[i] = Number.isFinite(px.y) ? px.y : 0;
    seed[i] = hashSeed(`${px.stripId == null ? 'null' : px.stripId}:${i}`);
  }
  const instanceStart = new Int32Array(2);
  instanceStart[0] = 0;
  instanceStart[1] = n;
  return {
    areaId: null,
    fieldId: null,
    fold: 1,
    count: n,
    pixelIndex,
    instanceStart,
    radius,
    angle,
    r: radius,
    ang: angle,
    x,
    y,
    seed,
  };
}

/** Strip-id set in the shape resolveComposition()'s `collectStripIds` reads.
 * It does NOT understand a bare template array, so hand it `{ stripIds }`. */
function stripIdsOf(template) {
  const seen = new Set();
  const list = Array.isArray(template) ? template : [];
  for (const px of list) {
    if (px && typeof px.stripId === 'string' && px.stripId) seen.add(px.stripId);
  }
  return Array.from(seen);
}

/** Raw (pre-normalization) voice records, so the real character survives —
 * see header collision 1. Matched by array index, which normalizeComposition
 * preserves (it demotes and slices, never reorders), with an id fallback. */
function rawVoicesOf(composition) {
  const list = composition && Array.isArray(composition.voices) ? composition.voices : [];
  const byId = new Map();
  list.forEach((v) => {
    if (v && typeof v.id === 'string' && v.id) byId.set(v.id, v);
  });
  return { list, byId };
}

/**
 * The band a voice actually listens to, or null for "use the character's own
 * recommendation". Read from the RAW voice — see the header: normalization
 * turns an unauthored band into 'mid', which is a default, not a choice.
 */
function resolveVoiceBand(rawVoice, resolvedVoice) {
  const candidate = rawVoice ? rawVoice.band : (resolvedVoice ? resolvedVoice.band : null);
  if (typeof candidate !== 'string' || candidate === 'none') return null;
  return AUDIO_BANDS.includes(candidate) ? candidate : null;
}

function resolveCharacterKey(raw) {
  if (!raw) return { key: GROUND_CHARACTER, known: false };
  const candidates = [raw.characterKey, raw.character];
  for (const c of candidates) {
    if (typeof c === 'string' && Object.prototype.hasOwnProperty.call(CHARACTERS, c)) {
      return { key: c, known: true };
    }
  }
  return { key: GROUND_CHARACTER, known: false };
}

/**
 * createEnsembleRuntime({ template, composition })
 *
 * @param {Array}  template     createConnectedSpatialTemplate() / createMandalaSpatialTemplate() output
 * @param {object} composition  a Program, any shape normalizeComposition() accepts
 * @returns {{
 *   setTemplate: (t: Array) => void,
 *   setComposition: (c: object) => void,
 *   getResolved: () => object,
 *   tickVoices: (target: Float32Array|number[], ctx: object) => object,
 *   getVoiceZones: () => object,
 *   getVoiceDebug: (voiceId: string) => object|null,
 * }}
 */
export function createEnsembleRuntime({ template = [], composition = {} } = {}) {
  let currentTemplate = Array.isArray(template) ? template : [];
  let currentComposition = composition;

  let resolved = null;          // resolveComposition() output
  let fieldBindings = new Map();
  let areaBindings = new Map(); // areaId -> kernelView(AreaBinding)
  let voices = [];              // runtime voice records, stable composition order
  let ground = null;            // { enabled, level, band, zone, vr, binding }
  let groundBinding = null;
  let total = 0;
  let warnings = [];

  // ── zone state, persistent ACROSS frames (that persistence IS the hysteresis)
  let zoneOwner = new Int16Array(0);   // voice ordinal owning each pixel, or -1
  let incumbentContrib = new Float32Array(0);
  let bestChallenger = new Float32Array(0);
  let bestChallengerOwner = new Int16Array(0);
  let scratchPrev = new Float32Array(0);   // per-voice before-values, sized to the widest area

  // One reusable per-voice frame ctx. Characters read `depth` and `band` off
  // ctx, and BOTH are authored PER VOICE, so the caller's ctx is never
  // mutated — this private object is re-stamped before each voice's tick.
  const voiceCtx = { dt: 0, bands: null, depth: 1, band: null };
  // The ground's authored band is remapped onto 'energy' below, so the ground
  // ctx names no band and Glow falls back to its own recommendation.
  const groundBands = { energy: 0 };
  const groundCtx = { dt: 0, bands: groundBands, depth: 1, band: null };

  function rebuild() {
    // Live-edit continuity. Every knob turn in the Show screen calls
    // setComposition(), which lands here. Handing each voice a FRESH runtime
    // would restart its authored clock and drop its envelope back to zero on
    // every frame of a slider drag — the piece visibly dips while the owner is
    // dragging, which reads as the instrument fighting him. So: a voice whose
    // id and character are unchanged KEEPS the runtime it was already living
    // in, and only a genuinely new or retyped voice gets a fresh one.
    // Depth/band/spread/direction are read per frame from the voice record, so
    // reusing the runtime does not stale any of them.
    const carriedRuntimes = new Map();
    for (const prev of voices) {
      if (prev && prev.id != null && prev.runtime) {
        carriedRuntimes.set(`${prev.id}::${prev.characterKey}`, prev.runtime);
      }
    }
    const carriedGroundVr = (ground && ground.vr) ? ground.vr : null;

    const stripIds = stripIdsOf(currentTemplate);
    // resolveComposition() joins fields/areas/voices against the live layout
    // but does NOT carry the ground layer through, so the ground is read from
    // the normalized composition directly. Both calls normalize the same
    // input, so the two views cannot disagree.
    const normalized = normalizeComposition(currentComposition);
    resolved = resolveComposition(currentComposition, { stripIds });
    warnings = resolved.warnings.slice();
    total = currentTemplate.length;
    groundBinding = buildGroundBinding(currentTemplate);

    // showAreaBinding's area contract, from resolveComposition's areas.
    const adaptedAreas = resolved.areas.map((area) => ({
      areaId: area.id,
      fieldId: area.fieldId,
      instances: area.instances.map((inst) => ({
        stripIds: inst.stripIds,
        wedgeIndex: Number.isFinite(inst.index) ? inst.index : null,
        flip: inst.mirrored === true,
      })),
    }));

    fieldBindings = bindFields(resolved.fields, adaptedAreas, currentTemplate);
    const bound = bindAreas(adaptedAreas, resolved.fields, currentTemplate, fieldBindings);
    areaBindings = new Map();
    bound.forEach((binding) => {
      if (binding && binding.areaId != null) areaBindings.set(binding.areaId, kernelView(binding));
    });

    const wedgeByArea = new Map(resolved.areas.map((area) => [
      area.id,
      area.instances.map((inst) => (Number.isFinite(inst.index) ? inst.index : 0)),
    ]));

    const raw = rawVoicesOf(currentComposition);
    voices = resolved.voices.map((v, index) => {
      const rawVoice = raw.byId.get(v.id) || raw.list[index] || null;
      const { key, known } = resolveCharacterKey(rawVoice);
      if (!known) {
        warnings.push({
          voiceId: v.id,
          kind: 'unknown-character',
          message: `Voice "${v.id}" names character "${rawVoice ? rawVoice.character : '(none)'}", `
            + `which is not one of the ensemble instruments; falling back to "${GROUND_CHARACTER}".`,
        });
      }
      const binding = v.areaId ? (areaBindings.get(v.areaId) || null) : null;
      return {
        id: v.id,
        ordinal: index,
        areaId: v.areaId,
        characterKey: key,
        character: CHARACTERS[key],
        band: v.band,
        // The band handed to the character on ctx.band each frame. null means
        // "the character's own recommended band" — see resolveVoiceBand().
        listensTo: resolveVoiceBand(rawVoice, v),
        depth: v.depth,
        spread: v.spread,
        direction: normalizeDirection(rawVoice && rawVoice.direction !== undefined
          ? rawVoice.direction
          : v.direction),
        muted: v.muted === true,
        unresolved: v.unresolved === true,
        zone: (typeof v.palette === 'string' && v.palette) ? v.palette : key,
        binding,
        field: v.areaId && binding && binding.fieldId
          ? (fieldBindings.get(binding.fieldId) || null)
          : null,
        wedgeOf: wedgeByArea.get(v.areaId) || null,
        runtime: carriedRuntimes.get(`${v.id}::${key}`) || cloneVoiceState(CHARACTERS[key]),
      };
    });

    const g = normalized.ground || {};
    ground = {
      enabled: g.enabled !== false,
      level: Number.isFinite(g.level) ? g.level : 0.12,
      band: typeof g.band === 'string' ? g.band : 'none',
      zone: (typeof g.palette === 'string' && g.palette) ? g.palette : GROUND_ZONE,
      vr: carriedGroundVr || cloneVoiceState(Glow),   // same continuity rule as voices above
      binding: groundBinding,
    };

    // Zone state is sized to the template and RESET on rebuild — an owner
    // ordinal from a previous composition means nothing in the new one.
    zoneOwner = new Int16Array(total).fill(ZONE_UNOWNED);
    incumbentContrib = new Float32Array(total);
    bestChallenger = new Float32Array(total);
    bestChallengerOwner = new Int16Array(total).fill(ZONE_UNOWNED);

    let widest = 0;
    for (const b of areaBindings.values()) widest = Math.max(widest, b.count);
    scratchPrev = new Float32Array(widest);
  }

  rebuild();

  function setTemplate(next) {
    currentTemplate = Array.isArray(next) ? next : [];
    rebuild();
  }

  function setComposition(next) {
    currentComposition = next || {};
    rebuild();
  }

  function getResolved() {
    return {
      fields: resolved.fields,
      areas: resolved.areas,
      voices: voices.map((v) => ({
        id: v.id,
        areaId: v.areaId,
        characterKey: v.characterKey,
        band: v.band,
        listensTo: v.listensTo,
        depth: v.depth,
        spread: v.spread,
        direction: v.direction,
        muted: v.muted,
        unresolved: v.unresolved,
        zone: v.zone,
        fold: v.binding ? v.binding.fold : 0,
        pixelCount: v.binding ? v.binding.count : 0,
        fieldId: v.binding ? v.binding.fieldId : null,
      })),
      ground: ground ? {
        enabled: ground.enabled, level: ground.level, band: ground.band, zone: ground.zone,
      } : null,
      warnings,
      pixelCount: total,
      fieldIds: Array.from(fieldBindings.keys()),
    };
  }

  function phasesOf(voice) {
    const fold = voice.binding ? voice.binding.fold : 0;
    const out = new Array(fold);
    for (let k = 0; k < fold; k += 1) out[k] = instancePhase(voice.field, voice, k);
    return out;
  }

  function getVoiceDebug(voiceId) {
    const v = voices.find((entry) => entry.id === voiceId);
    if (!v) return null;
    return {
      id: v.id,
      areaId: v.areaId,
      characterKey: v.characterKey,
      band: v.band,
      listensTo: v.listensTo,
      depth: v.depth,
      spread: v.spread,
      direction: v.direction,
      muted: v.muted,
      unresolved: v.unresolved,
      zone: v.zone,
      fieldId: v.binding ? v.binding.fieldId : null,
      fold: v.binding ? v.binding.fold : 0,
      pixelCount: v.binding ? v.binding.count : 0,
      phases: phasesOf(v),
      clock: v.runtime ? v.runtime.clock : 0,
      env: v.runtime ? v.runtime.env : 0,
    };
  }

  function getVoiceZones() {
    const zoneNames = [GROUND_ZONE];
    const nameIndex = new Map([[GROUND_ZONE, 0]]);
    if (ground && ground.zone !== GROUND_ZONE) {
      nameIndex.set(ground.zone, zoneNames.length);
      zoneNames.push(ground.zone);
    }
    const ordinalToZone = new Int16Array(voices.length);
    voices.forEach((v, i) => {
      if (!nameIndex.has(v.zone)) {
        nameIndex.set(v.zone, zoneNames.length);
        zoneNames.push(v.zone);
      }
      ordinalToZone[i] = nameIndex.get(v.zone);
    });
    const groundZoneIndex = ground ? nameIndex.get(ground.zone) : 0;

    const zoneOf = new Int16Array(total);
    for (let i = 0; i < total; i += 1) {
      const owner = zoneOwner[i];
      zoneOf[i] = owner === ZONE_UNOWNED ? groundZoneIndex : ordinalToZone[owner];
    }
    return {
      zoneOf,
      zoneNames,
      zoneOwner: zoneOwner.slice(),
      groundZone: groundZoneIndex,
    };
  }

  /**
   * tickVoices(target, ctx) — the per-frame call. See the PER-FRAME ORDER
   * block in the header; the order there is the contract.
   *
   * `target` is ZEROED first: the ground pass FILLS the accumulator, it does
   * not composite onto whatever was left there. `ctx` is never mutated.
   *
   * @param {Float32Array|number[]} target  the one flat accumulator
   * @param {object} ctx  { dt, bands: {bass,mid,high,energy,beat} }
   */
  function tickVoices(target, ctx) {
    const dt = Number.isFinite(ctx && ctx.dt) ? ctx.dt : 0;
    const bands = (ctx && ctx.bands) || null;
    const n = Math.min(total, target ? target.length : 0);

    for (let i = 0; i < n; i += 1) target[i] = 0;

    // ── 1. GROUND ─────────────────────────────────────────────────────────
    // Works over real x/y and radius, never over instance index, so it
    // crosses field boundaries naturally and reads as one organism.
    let groundRan = false;
    if (ground && ground.enabled && groundBinding && groundBinding.count > 0) {
      const bandName = ground.band === 'none' ? null : ground.band;
      const bandValue = bandName && bands && Number.isFinite(bands[bandName])
        ? Math.min(1, Math.max(0, bands[bandName]))
        : 0;
      groundBands.energy = bandValue;
      groundCtx.dt = dt;
      groundCtx.depth = Math.min(1, Math.max(0, ground.level));
      Glow.tick(ground.vr, groundCtx);
      Glow.kernel(groundBinding, 0, Math.min(groundBinding.count, n), target, ground.vr, groundCtx);
      groundRan = true;
    }

    // ── 2. VOICES ─────────────────────────────────────────────────────────
    for (let i = 0; i < n; i += 1) {
      incumbentContrib[i] = 0;
      bestChallenger[i] = 0;
      bestChallengerOwner[i] = ZONE_UNOWNED;
    }

    let painted = 0;
    for (const v of voices) {
      const ch = v.character;
      if (!ch) continue;

      // Muted and unresolved voices STILL tick. The clock is authored time;
      // letting it run means unmuting rejoins the piece in phase instead of
      // snapping. What they do not do is touch the accumulator.
      voiceCtx.dt = dt;
      voiceCtx.bands = bands;
      voiceCtx.depth = Number.isFinite(v.depth) ? v.depth : 1;
      // THE per-voice band. This one line is what makes two voices of the
      // same character on different bands move differently.
      voiceCtx.band = v.listensTo;
      ch.tick(v.runtime, voiceCtx);

      if (v.muted) continue;
      const area = v.binding;
      if (!area || !area.count) continue;

      // Snapshot this voice's own pixels so its contribution can be measured
      // as an actual difference in the accumulator, not a proxy for one.
      const count = area.count;
      for (let j = 0; j < count; j += 1) {
        const p = area.pixelIndex[j];
        scratchPrev[j] = (p >= 0 && p < n) ? target[p] : 0;
      }

      for (let k = 0; k < area.fold; k += 1) {
        const from = area.instanceStart[k];
        const to = area.instanceStart[k + 1];
        if (to <= from) continue;                    // a hidden/missing copy: silent gap, timing unchanged
        v.runtime.phase = instancePhase(v.field, v, k);
        ch.kernel(area, from, to, target, v.runtime, voiceCtx);
      }
      v.runtime.phase = 0;
      painted += 1;

      for (let j = 0; j < count; j += 1) {
        const p = area.pixelIndex[j];
        if (p < 0 || p >= n) continue;
        // Measured BEFORE the soft clip below, so a voice's zone weight is its
      // own light, not its share of an already-compressed sum.
      const delta = target[p] - scratchPrev[j];
        if (!(delta > 0)) continue;
        if (zoneOwner[p] === v.ordinal) {
          incumbentContrib[p] = delta;
        } else if (delta > bestChallenger[p]) {
          bestChallenger[p] = delta;
          bestChallengerOwner[p] = v.ordinal;
        }
      }
    }

    // ── 3. SOFT CLIP, THEN THE LIVING-COAL FLOOR ──────────────────────────
    // The floor is last and unconditional: see LIVING_COAL_FLOOR. `!(y >=
    // floor)` rather than `y < floor` so a NaN that reached the accumulator
    // lands on the floor too, instead of propagating to the wire.
    let clipped = 0;
    let maxRaw = 0;
    let floored = 0;
    for (let i = 0; i < n; i += 1) {
      const x = target[i];
      if (x > maxRaw) maxRaw = x;
      let y = x;
      if (y > CLIP_KNEE) {
        y = softClip(y);
        clipped += 1;
      }
      if (!(y >= LIVING_COAL_FLOOR)) {
        y = LIVING_COAL_FLOOR;
        floored += 1;
      }
      target[i] = y;
    }

    // ── 4. ZONES, WITH HYSTERESIS ─────────────────────────────────────────
    for (let i = 0; i < n; i += 1) {
      const challenger = bestChallengerOwner[i];
      if (challenger === ZONE_UNOWNED) continue;
      if (zoneOwner[i] === ZONE_UNOWNED) {
        zoneOwner[i] = challenger;
      } else if (zoneChallengeWins(incumbentContrib[i], bestChallenger[i])) {
        zoneOwner[i] = challenger;
      }
    }

    return {
      label: 'ensemble',
      voices: voices.length,
      painted,
      ground: groundRan,
      clipped,
      floored,
      maxRaw,
      pixels: n,
    };
  }

  return { setTemplate, setComposition, getResolved, tickVoices, getVoiceZones, getVoiceDebug };
}
