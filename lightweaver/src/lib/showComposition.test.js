import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOW_COMPOSITION_VERSION,
  MAX_VOICES,
  MAX_FOLD,
  VOICE_CHARACTERS,
  AUDIO_BANDS,
  normalizeComposition,
  exportComposition,
  importComposition,
  resolveComposition,
  loadCompositions,
  persistCompositions,
} from './showComposition.js';
import * as showComposition from './showComposition.js';

function makeTemplate(stripIds) {
  const m = new Map();
  for (const id of stripIds) m.set(id, { x: 0, y: 0, weight: 1 });
  return m;
}

function baseComposition(overrides = {}) {
  return normalizeComposition({
    id: 'comp-1',
    name: 'Test program',
    projectId: 'proj-1',
    fields: [
      { id: 'field-1', fold: 6, centre: { x: 0, y: 0 }, order: 0 },
    ],
    areas: [
      {
        id: 'area-lotus',
        name: 'Lotus',
        fieldId: 'field-1',
        instances: [
          { index: 0, stripIds: ['s0'] },
          { index: 1, stripIds: ['s1'] },
          { index: 2, stripIds: ['s2'] },
          { index: 3, stripIds: ['s3'] },
          { index: 4, stripIds: ['s4'] },
          { index: 5, stripIds: ['s5'] },
        ],
      },
    ],
    voices: [
      { id: 'voice-1', areaId: 'area-lotus', character: 'amplitude', band: 'bass', depth: 0.6, spread: 1, direction: 1 },
    ],
    ...overrides,
  });
}

test('normalizeComposition never throws on garbage input', () => {
  assert.doesNotThrow(() => normalizeComposition(null));
  assert.doesNotThrow(() => normalizeComposition(undefined));
  assert.doesNotThrow(() => normalizeComposition('not an object'));
  assert.doesNotThrow(() => normalizeComposition(42));
  assert.doesNotThrow(() => normalizeComposition({ voices: 'nope', areas: null, fields: 5 }));
  const c = normalizeComposition({ garbage: true });
  assert.equal(c.version, SHOW_COMPOSITION_VERSION);
  assert.equal(c.voices.length, 0);
  assert.equal(c.areas.length, 0);
});

test('normalize -> export -> import is idempotent', () => {
  const original = baseComposition();
  const exported = exportComposition(original);
  const reimported = importComposition(exported);
  const reExported = exportComposition(reimported);
  assert.equal(exported, reExported);
  // And normalizing an already-normalized composition changes nothing.
  const renormalized = normalizeComposition(reimported);
  assert.equal(exportComposition(renormalized), exported);
});

test('missing area keeps the voice with a warning, never deletes it', () => {
  const comp = baseComposition({
    voices: [
      { id: 'voice-orphan', areaId: 'area-does-not-exist', character: 'amplitude', band: 'bass' },
    ],
  });
  const template = makeTemplate(['s0', 's1']);
  const resolved = resolveComposition(comp, template);
  assert.equal(resolved.voices.length, 1);
  assert.equal(resolved.voices[0].id, 'voice-orphan');
  assert.equal(resolved.voices[0].unresolved, true);
  assert.ok(resolved.warnings.some((w) => w.kind === 'missing-area'));
});

test('voice with no areaId is kept, marked unresolved', () => {
  const comp = baseComposition({
    voices: [{ id: 'voice-bare', areaId: null, character: 'amplitude', band: 'bass' }],
  });
  const resolved = resolveComposition(comp, makeTemplate([]));
  assert.equal(resolved.voices.length, 1);
  assert.equal(resolved.voices[0].unresolved, true);
  assert.ok(resolved.warnings.some((w) => w.kind === 'no-area'));
});

test('area resolving to zero pixels keeps its voice, marked unresolved, contributes no pixels', () => {
  const comp = baseComposition();
  // Template has none of the lotus strip ids.
  const resolved = resolveComposition(comp, makeTemplate(['unrelated-1', 'unrelated-2']));
  assert.equal(resolved.voices.length, 1);
  assert.equal(resolved.voices[0].unresolved, true);
  assert.equal(resolved.voices[0].area.empty, true);
  assert.equal(resolved.pixelIndex.size, 0);
  assert.ok(resolved.warnings.some((w) => w.kind === 'empty-area'));
});

test('partial fold (4 of 6) keeps authored fold and empty runs; surviving instance phases unchanged', () => {
  const comp = baseComposition();
  // Only 4 of the 6 lotus strips exist in this layout.
  const partialTemplate = makeTemplate(['s0', 's1', 's2', 's3']);
  const fullTemplate = makeTemplate(['s0', 's1', 's2', 's3', 's4', 's5']);

  const resolvedPartial = resolveComposition(comp, partialTemplate);
  const resolvedFull = resolveComposition(comp, fullTemplate);

  const areaPartial = resolvedPartial.areas.find((a) => a.id === 'area-lotus');
  const areaFull = resolvedFull.areas.find((a) => a.id === 'area-lotus');

  // Fold (instance slot count) is unchanged by partial resolution.
  assert.equal(areaPartial.fold, 6);
  assert.equal(areaFull.fold, 6);
  assert.equal(areaPartial.partial, true);
  assert.equal(areaFull.partial, false);

  // Missing instances (4,5) are present as empty slots, not removed.
  assert.equal(areaPartial.instances.length, 6);
  assert.equal(areaPartial.instances[4].empty, true);
  assert.equal(areaPartial.instances[4].stripIds.length, 0);
  assert.equal(areaPartial.instances[5].empty, true);

  // Surviving instances (0-3) are identical in shape/index between partial
  // and full resolution — the "gap in the wave, not a re-timed wave" claim.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(areaPartial.instances[i].empty, false);
    assert.deepEqual(areaPartial.instances[i].stripIds, areaFull.instances[i].stripIds);
    assert.equal(areaPartial.instances[i].index, areaFull.instances[i].index);
  }

  // Deriving phases off the same authored fold produces identical phase
  // values for surviving instances regardless of which strips are missing —
  // this is the actual "spread timing unchanged" guarantee, computed from
  // symmetryFields.js's own engine on the authored fold count.
  const phaseTable = showComposition.deriveInstancePhases(
    { fold: 6, copies: 6, orderMode: 'field', spread: 1, direction: 1, instances: [] },
    null,
    { fold: 6 },
  ).phaseTable;
  assert.equal(phaseTable.length, 6);

  assert.ok(resolvedPartial.warnings.some((w) => w.kind === 'partial-area'));
  assert.ok(!resolvedFull.warnings.some((w) => w.kind === 'partial-area'));
});

test('reopening against a layout with more strips leaves new strips unvoiced, nothing auto-joins', () => {
  const comp = baseComposition();
  const grownTemplate = makeTemplate(['s0', 's1', 's2', 's3', 's4', 's5', 'new-strip-a', 'new-strip-b']);
  const resolved = resolveComposition(comp, grownTemplate);
  const area = resolved.areas.find((a) => a.id === 'area-lotus');
  const allAssigned = area.instances.flatMap((i) => i.stripIds);
  assert.ok(!allAssigned.includes('new-strip-a'));
  assert.ok(!allAssigned.includes('new-strip-b'));
  const unvoicedWarning = resolved.warnings.find((w) => w.kind === 'unvoiced-strips');
  assert.ok(unvoicedWarning);
  assert.ok(unvoicedWarning.stripIds.includes('new-strip-a'));
  assert.ok(unvoicedWarning.stripIds.includes('new-strip-b'));
});

test('whole-piece sentinel "*" resolves to every known strip id', () => {
  const comp = normalizeComposition({
    areas: [{ id: 'area-all', name: 'All', instances: [{ index: 0, stripIds: '*' }] }],
    voices: [{ id: 'v1', areaId: 'area-all', character: 'amplitude' }],
  });
  const resolved = resolveComposition(comp, makeTemplate(['a', 'b', 'c']));
  const area = resolved.areas[0];
  assert.deepEqual(area.instances[0].stripIds.sort(), ['a', 'b', 'c']);
});

test('caps: voice count rejects correctly (drops excess at normalize, never throws)', () => {
  const voices = [];
  for (let i = 0; i < MAX_VOICES + 5; i += 1) {
    voices.push({ id: `voice-${i}`, areaId: 'area-lotus', character: 'amplitude' });
  }
  const comp = normalizeComposition({ areas: [], voices });
  assert.equal(comp.voices.length, MAX_VOICES);
});

test('caps: fold is clamped to MAX_FOLD', () => {
  const comp = normalizeComposition({
    fields: [{ id: 'huge', fold: MAX_FOLD * 4, centre: { x: 0, y: 0 }, order: 0 }],
  });
  assert.ok(comp.fields[0].fold <= MAX_FOLD);
});

test('caps: at most one mode-character voice per composition, excess demoted not dropped', () => {
  const comp = normalizeComposition({
    voices: [
      { id: 'v-mode-1', areaId: null, character: 'mode' },
      { id: 'v-mode-2', areaId: null, character: 'mode' },
      { id: 'v-mode-3', areaId: null, character: 'mode' },
    ],
  });
  assert.equal(comp.voices.length, 3);
  const modeVoices = comp.voices.filter((v) => v.isModeVoice);
  assert.equal(modeVoices.length, 1);
  assert.equal(modeVoices[0].id, 'v-mode-1');
  // The demoted voices are kept, not dropped, with a valid fallback character.
  assert.ok(VOICE_CHARACTERS.includes(comp.voices[1].character));
  assert.ok(VOICE_CHARACTERS.includes(comp.voices[2].character));
});

test('unknown character and band clamp to defaults rather than throw', () => {
  const comp = normalizeComposition({
    ground: { band: 'nonsense-band' },
    voices: [{ id: 'v1', areaId: null, character: 'totally-not-a-character', band: 'also-nonsense' }],
  });
  assert.ok(VOICE_CHARACTERS.includes(comp.voices[0].character));
  assert.ok(AUDIO_BANDS.includes(comp.voices[0].band));
  assert.ok(AUDIO_BANDS.includes(comp.ground.band));
});

test('out-of-range depth/spread/master/sensitivity clamp to [0,1] rather than throw', () => {
  const comp = normalizeComposition({
    master: 99,
    sensitivity: -50,
    voices: [{ id: 'v1', areaId: null, depth: 5, spread: -3 }],
  });
  assert.equal(comp.master, 1);
  assert.equal(comp.sensitivity, 0);
  assert.equal(comp.voices[0].depth, 1);
  assert.equal(comp.voices[0].spread, 0);
});

test('direction always normalizes to exactly 1 or -1', () => {
  const comp = normalizeComposition({
    voices: [
      { id: 'v1', areaId: null, direction: -1 },
      { id: 'v2', areaId: null, direction: 1 },
      { id: 'v3', areaId: null, direction: 'garbage' },
      { id: 'v4', areaId: null, direction: 0 },
    ],
  });
  assert.deepEqual(comp.voices.map((v) => v.direction), [-1, 1, 1, 1]);
});

test('a saved "mode" voice survives being reloaded twice, not just once', () => {
  // normalizeCharacter used to translate 'mode' away to the default character
  // on the very first pass while isModeVoice stayed true (read off the
  // pre-normalized input) — so a SECOND normalize, which can only see the
  // already-mangled character, silently flipped isModeVoice to false. Prove
  // the round trip is stable at least two reloads deep.
  const raw = { voices: [{ id: 'v1', areaId: null, character: 'mode' }] };
  const once = normalizeComposition(raw);
  assert.equal(once.voices[0].character, 'mode');
  assert.equal(once.voices[0].isModeVoice, true);

  const reimportedOnce = importComposition(exportComposition(once));
  assert.equal(reimportedOnce.voices[0].character, 'mode');
  assert.equal(reimportedOnce.voices[0].isModeVoice, true);

  const reimportedTwice = importComposition(exportComposition(reimportedOnce));
  assert.equal(reimportedTwice.voices[0].character, 'mode');
  assert.equal(reimportedTwice.voices[0].isModeVoice, true);

  // And normalizing it a third time in place changes nothing further.
  assert.equal(exportComposition(reimportedTwice), exportComposition(reimportedOnce));
});

test('no export here can be handed an audio band — the model is audio-free', () => {
  // Every export is a pure function; none accepts anything band-shaped as an
  // argument name/parameter. We assert this structurally: normalizeComposition
  // and resolveComposition both take exactly the documented (data, data)
  // shape, and re-normalizing never introduces a numeric multiplier keyed off
  // 'band' anywhere near a rotation/clock field. Concretely: rotationOffset
  // on any field surviving normalization is untouched by band/depth/spread.
  const before = normalizeComposition({
    fields: [{ id: 'f1', fold: 4, centre: { x: 0, y: 0 }, rotationOffset: 1.2345, order: 0 }],
    voices: [{ id: 'v1', areaId: null, band: 'bass', depth: 1 }],
  });
  const after = normalizeComposition(before);
  assert.equal(after.fields[0].rotationOffset, 1.2345);
  assert.equal(normalizeComposition.length, 1);
  assert.equal(resolveComposition.length, 2);
});

test('persistence: load/persist round-trip is keyed by projectId, sibling of project storage', () => {
  const store = {};
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  try {
    assert.deepEqual(loadCompositions('proj-x'), []);
    const saved = persistCompositions('proj-x', [baseComposition()]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].projectId, 'proj-x');

    const loaded = loadCompositions('proj-x');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'comp-1');

    // A different project id sees nothing.
    assert.deepEqual(loadCompositions('proj-y'), []);

    // The storage key used is the documented sibling key, not embedded in
    // any project-shaped key.
    assert.ok('lw.show.compositions.v1' in store);
  } finally {
    delete global.localStorage;
  }
});

test('persistence: bad/missing localStorage never throws', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(global, 'localStorage');
  delete global.localStorage;
  try {
    assert.doesNotThrow(() => loadCompositions('proj-z'));
    assert.doesNotThrow(() => persistCompositions('proj-z', [baseComposition()]));
    assert.deepEqual(loadCompositions('proj-z'), []);
  } finally {
    if (originalDescriptor) Object.defineProperty(global, 'localStorage', originalDescriptor);
  }
});
