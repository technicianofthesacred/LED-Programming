// showEnsembleBench.js — the bridge between a real drawn piece and a playable
// ensemble Program. Pure ESM: no React, no DOM, no audio. Everything here is a
// function of the layout the owner already drew.
//
// Two jobs, both of them about the FIRST thirty seconds in front of the wall:
//
//   1. buildStarterComposition() turns his layout into a composition he can
//      hear immediately. If he has named strip groups, those names ARE the
//      areas — "lotus", "bee", "sun ray", "spots" — because seeing his own
//      words on the voice cards is most of the value. If he never grouped
//      anything, three areas are cut by distance from centre so the screen is
//      never empty on any piece, however messy the drawing.
//
//   2. The character round-trip. showComposition.js's normalizeComposition()
//      rewrites `character` to one of ITS five words (amplitude/breadth/…)
//      while showEnsemble.js reads the five INSTRUMENT words
//      (swell/twinkle/…) — see the "TWO NAMING COLLISIONS" block in
//      showEnsemble.js, which deliberately leaves the two vocabularies
//      unreconciled. Persisting through loadCompositions/persistCompositions
//      therefore loses the instrument. `palette` is the one free-form string
//      that survives normalization intact, so the instrument key is mirrored
//      there and read back out on load (characterKeyOf / restoreCharacters).
//      This costs nothing semantically: showEnsemble derives a voice's zone as
//      `palette || characterKey`, so palette === characterKey is byte-for-byte
//      the same zone the voice would have had with no palette at all.
import {
  memberStripIds,
  normalizeFields,
  readAreaSymmetry,
  resolveFieldForArea,
  stripCentroids,
} from './symmetryFields.js';
import { CHARACTERS, CHARACTER_LIBRARY } from './showCharacters.js';
import { MAX_VOICES } from './showComposition.js';

/** The four bands a person can actually point at in a room, in the words a
 * person uses, each paired with the key showAudioFeatures/getLevels reports
 * it under. `meter` is the same key — named separately so a future band whose
 * meter differs from its composition key does not need a second table. */
export const BAND_CHOICES = Object.freeze([
  Object.freeze({ key: 'bass', label: 'lows', meter: 'bass' }),
  Object.freeze({ key: 'mid', label: 'mids', meter: 'mid' }),
  Object.freeze({ key: 'high', label: 'highs', meter: 'high' }),
  Object.freeze({ key: 'beat', label: 'hits', meter: 'beat' }),
]);

/** The five instruments, in library order, for the character chip row. */
export const CHARACTER_CHOICES = Object.freeze(
  CHARACTER_LIBRARY.map((c) => Object.freeze({ key: c.key, label: c.label, verb: c.verb })),
);

const DEFAULT_CHARACTER = 'glow';
/** Names for the no-groups fallback, indexed by how many rings actually came
 * out of the split — a two-ring piece has a centre and an outside, no middle. */
const RING_NAMES = Object.freeze({
  1: ['The whole piece'],
  2: ['Centre', 'Outer'],
  3: ['Centre', 'Middle', 'Outer'],
});
const STARTER_DEPTH = 0.6;
const STARTER_SPREAD = 0.35;

export function bandLabel(key) {
  const found = BAND_CHOICES.find((b) => b.key === key);
  return found ? found.label : 'quiet';
}

export function characterLabel(key) {
  const found = CHARACTER_CHOICES.find((c) => c.key === key);
  return found ? found.label : key;
}

/**
 * The instrument a voice record names, whatever shape it arrived in.
 * Order matches showEnsemble.js's resolveCharacterKey(), with `palette`
 * appended as the survives-normalization carrier described in the header.
 */
export function characterKeyOf(voice) {
  if (!voice) return DEFAULT_CHARACTER;
  for (const candidate of [voice.characterKey, voice.character, voice.palette]) {
    if (typeof candidate === 'string'
      && Object.prototype.hasOwnProperty.call(CHARACTERS, candidate)) return candidate;
  }
  return DEFAULT_CHARACTER;
}

/** Stamp an instrument onto a voice in all three places it has to agree. */
export function withCharacter(voice, key) {
  const safe = Object.prototype.hasOwnProperty.call(CHARACTERS, key) ? key : DEFAULT_CHARACTER;
  return { ...voice, character: safe, characterKey: safe, palette: safe };
}

/**
 * Repair a composition that has just come back through normalizeComposition()
 * (i.e. out of loadCompositions). Idempotent — a composition that never lost
 * its instruments comes back unchanged.
 */
export function restoreCharacters(composition) {
  if (!composition || !Array.isArray(composition.voices)) return composition;
  return {
    ...composition,
    voices: composition.voices.map((v) => withCharacter(v, characterKeyOf(v))),
  };
}

// ── layout reading ────────────────────────────────────────────────────────

/**
 * Mean distance from the piece's centre, per strip, measured on the TEMPLATE
 * rather than on the raw strip paths. The template is what the show actually
 * renders: it is already centred and normalized to roughly -1..1, it already
 * drops hidden strips, and it is identical for the Mandala and connected
 * layouts. Reading the artwork coordinates instead would give a different
 * centre on an asymmetric piece (see normalizeField's "Two different centres"
 * warning in symmetryFields.js).
 */
export function templateStripRadii(template) {
  const acc = new Map();
  const list = Array.isArray(template) ? template : [];
  for (const sample of list) {
    if (!sample || sample.stripId == null) continue;
    const r = Math.hypot(sample.x || 0, sample.y || 0);
    if (!Number.isFinite(r)) continue;
    const entry = acc.get(sample.stripId) || { sum: 0, n: 0 };
    entry.sum += r;
    entry.n += 1;
    acc.set(sample.stripId, entry);
  }
  const out = new Map();
  for (const [id, entry] of acc) out.set(id, entry.sum / entry.n);
  return out;
}

function stripGroups(layerGroups) {
  return (Array.isArray(layerGroups) ? layerGroups : [])
    .filter((g) => g && typeof g === 'object' && (g.type === undefined || g.type === 'strip'));
}

// Innermost third listens to the sparkle, the outer rim carries the weight,
// the middle holds the body — the owner's own stated instinct, used as the
// opening position for every area on every piece. He edits it in seconds; it
// exists so there is something honest to edit.
function starterVoiceFor(rank, total) {
  const band = total <= 1 ? 0.5 : rank / (total - 1);
  if (band < 1 / 3) return { character: 'twinkle', band: 'high' };
  if (band < 2 / 3) return { character: 'glow', band: 'mid' };
  return { character: 'swell', band: 'bass' };
}

function makeVoice(areaId, rank, total, fold) {
  const pick = starterVoiceFor(rank, total);
  return withCharacter({
    id: `voice-${areaId}`,
    areaId,
    band: pick.band,
    depth: STARTER_DEPTH,
    spread: fold > 1 ? STARTER_SPREAD : 0,
    direction: 1,
    muted: false,
  }, pick.character);
}

/**
 * buildStarterComposition({ strips, layerGroups, template, fields })
 *   -> a composition (raw, NOT normalized — the instrument words are intact)
 *
 * A STARTING POINT, never a preset: every value here is one the owner is
 * expected to change within a minute of hearing it. It exists so that the
 * first press of "Voices" produces his piece reacting to his music with his
 * own names on the cards, instead of an empty editor.
 *
 * `fields` is optional (a project's piece-level symmetry fields). When a group
 * carries authored symmetry, its fold and instances are read through
 * readAreaSymmetry() so the fold badge and the spread/direction controls mean
 * what the owner authored on the Layout screen. A piece with no symmetry
 * authored yields fold-1 areas, which is exactly how it renders today.
 */
export function buildStarterComposition({
  strips = [],
  layerGroups = [],
  template = [],
  fields = [],
} = {}) {
  const radii = templateStripRadii(template);
  const present = new Set(radii.keys());
  const normalizedFields = normalizeFields(fields);
  const geometry = stripCentroids(strips);

  const areas = [];
  const groups = stripGroups(layerGroups);

  for (const group of groups) {
    const members = memberStripIds(group).filter((id) => present.has(id));
    if (members.length === 0) continue;
    const memberSet = new Set(members);
    const field = resolveFieldForArea(group, normalizedFields, geometry);
    const symmetry = readAreaSymmetry(group, { field, geometry });
    const instances = (Array.isArray(symmetry.instances) ? symmetry.instances : [])
      .map((inst, index) => ({
        index,
        stripIds: (inst.stripIds || []).filter((id) => memberSet.has(id)),
        mirrored: inst.flip === true,
      }))
      .filter((inst) => inst.stripIds.length > 0);
    if (instances.length === 0) {
      instances.push({ index: 0, stripIds: members, mirrored: false });
    }
    const meanRadius = members.reduce((sum, id) => sum + (radii.get(id) || 0), 0) / members.length;
    areas.push({
      id: `area-${group.groupId || group.id || areas.length}`,
      // HIS words. Never rewritten, never prettified.
      name: typeof group.name === 'string' && group.name ? group.name : `Area ${areas.length + 1}`,
      fieldId: field ? field.id : null,
      instances,
      meanRadius,
    });
  }

  // No named groups on this piece — cut three rings out of whatever was drawn.
  // Split by RANK, not by radius value: a piece whose strips all sit at nearly
  // the same distance would give two empty areas under a value split, and an
  // empty voice card teaches nobody anything.
  if (areas.length === 0) {
    const ordered = Array.from(radii.keys()).sort((a, b) => radii.get(a) - radii.get(b));
    if (ordered.length === 0) return emptyComposition();
    const per = Math.ceil(ordered.length / 3);
    const slices = [];
    for (let i = 0; i < 3; i += 1) {
      const slice = ordered.slice(i * per, (i + 1) * per);
      if (slice.length > 0) slices.push(slice);
    }
    // A two-strip piece has no middle. Name what is actually there, so the
    // card never says "Middle" about the outermost ring on the wall.
    const names = RING_NAMES[slices.length] || RING_NAMES[3];
    slices.forEach((slice, i) => {
      areas.push({
        id: `area-ring-${i}`,
        name: names[i],
        fieldId: null,
        instances: [{ index: 0, stripIds: slice, mirrored: false }],
        meanRadius: slice.reduce((sum, id) => sum + radii.get(id), 0) / slice.length,
      });
    });
  }

  // Centre-out ordering is what makes the starter assignment land where he
  // expects: the first card on screen is the innermost motif.
  areas.sort((a, b) => a.meanRadius - b.meanRadius);
  const kept = areas.slice(0, MAX_VOICES);

  const voices = kept.map((area, index) =>
    makeVoice(area.id, index, kept.length, area.instances.length));

  return {
    version: 1,
    id: `comp-starter-${Date.now().toString(36)}`,
    name: 'Starter',
    master: 1,
    sensitivity: 0.5,
    ground: { enabled: true, level: 0.12, breath: 0.5, band: 'none' },
    fields: normalizedFields,
    areas: kept.map(({ meanRadius, ...area }) => area),
    voices,
  };
}

function emptyComposition() {
  return {
    version: 1,
    id: `comp-starter-${Date.now().toString(36)}`,
    name: 'Starter',
    master: 1,
    sensitivity: 0.5,
    ground: { enabled: true, level: 0.12, breath: 0.5, band: 'none' },
    fields: [],
    areas: [],
    voices: [],
  };
}

// ── live editing helpers ──────────────────────────────────────────────────

/** Replace one voice, returning a new composition. Never mutates. */
export function patchVoice(composition, voiceId, patch) {
  if (!composition || !Array.isArray(composition.voices)) return composition;
  return {
    ...composition,
    voices: composition.voices.map((v) => {
      if (v.id !== voiceId) return v;
      const next = { ...v, ...patch };
      return patch && patch.character
        ? withCharacter(next, patch.character)
        : next;
    }),
  };
}

/** Replace the ground layer, returning a new composition. Never mutates. */
export function patchGround(composition, patch) {
  if (!composition) return composition;
  return { ...composition, ground: { ...(composition.ground || {}), ...patch } };
}

/** Solo dim for every voice that is NOT the soloed one. Not a mute: the
 * locked aesthetic is one organism, and a motif judged against silence reads
 * wrong against the piece it actually lives in. */
export const SOLO_OTHERS_DEPTH = 0.2;
/** Ground drops to embers under a solo — present, barely alive, never gone. */
export const SOLO_GROUND_LEVEL = 0.04;

/**
 * The composition the ENGINE is given: the authored one, plus the two live
 * overlays that are deliberately never saved.
 *
 * `solo` dims the other voices instead of muting them. `audition` is the
 * held-chip preview — a patch applied to one voice for exactly as long as a
 * finger is down on a chip. Neither ever reaches persistence, which is why
 * they are applied here and not folded into the authored record.
 */
export function performanceComposition(composition, { soloVoiceId = null, audition = null } = {}) {
  if (!composition) return composition;
  let out = composition;
  if (audition && audition.voiceId && audition.patch) {
    out = patchVoice(out, audition.voiceId, audition.patch);
  }
  if (!soloVoiceId) return out;
  return {
    ...out,
    ground: {
      ...(out.ground || {}),
      level: Math.min(
        SOLO_GROUND_LEVEL,
        Number.isFinite(out.ground?.level) ? out.ground.level : SOLO_GROUND_LEVEL,
      ),
    },
    voices: (out.voices || []).map((v) => (v.id === soloVoiceId
      ? v
      : { ...v, depth: (Number.isFinite(v.depth) ? v.depth : 0.5) * SOLO_OTHERS_DEPTH })),
  };
}
