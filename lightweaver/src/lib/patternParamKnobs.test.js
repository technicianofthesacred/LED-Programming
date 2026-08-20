// Verifies the contract PatternKnobPanel.jsx and PatternLabControls.jsx rely
// on: that a per-pattern `@param` knob edited in `recipe.base.params`
// actually reaches the render engine and visibly changes pixel output, and
// that the recipe round-trips through JSON (the same serialization
// patternLabStorage.js uses for drafts) without losing an edited param.
//
// requestAnimationFrame is frozen in the harness browser tabs used to
// eyeball the Lab, so pixel-level proof has to come from this render-path
// test rather than a screenshot diff (see task brief + THINKING conventions
// for why "it's wired" needs evidence, not a claim).

import test from 'node:test';
import assert from 'node:assert/strict';

import { recipeFromPattern, renderPatternLabRecipeFrame } from './patternLabPatternAdapter.js';
import { parseParamsFromCode } from './patternParams.js';
import { HIDDEN_PARAM_NAMES, resolveParamLabel } from './patternParamLabels.js';
import { getPatternById } from './patternRegistry.js';
import { normalizePatternLabRecipe } from './patternLabRecipe.js';
import { PATTERNS } from './patterns-library.js';

const FIXED_PALETTE = ['#16002f', '#2962ff', '#00d7b7', '#ffe266'];
const FIXED_LAYOUT = [
  {
    id: 'inner',
    brightness: 0.82,
    speed: 0.75,
    hueShift: 7,
    spacing: 4,
    pts: [
      { x: 20, y: 15, p: 0 },
      { x: 42, y: 9, p: 0.33 },
      { x: 55, y: 32, p: 0.66 },
      { x: 28, y: 44, p: 1 },
    ],
  },
];

function renderWithParams(patternId, params, t = 42.5) {
  const recipe = recipeFromPattern(patternId, { palette: FIXED_PALETTE });
  recipe.base.params = params;
  return renderPatternLabRecipeFrame(recipe, {
    t,
    strips: FIXED_LAYOUT,
    bpm: 93,
    audioBands: { bass: 0.6, mid: 0.3, hi: 0.1 },
  });
}

test('fire: moving the "scale" knob to its max changes the rendered pixels', () => {
  const pattern = getPatternById('fire');
  const declared = parseParamsFromCode(pattern.code);
  const scale = declared.find(param => param.name === 'scale');
  assert.ok(scale, 'fire declares a scale @param');

  const defaultParams = Object.fromEntries(declared.map(param => [param.name, param.value]));
  const editedParams = { ...defaultParams, scale: scale.max };

  const defaultFrame = renderWithParams('fire', defaultParams);
  const editedFrame = renderWithParams('fire', editedParams);

  assert.notDeepEqual(
    editedFrame.pixels,
    defaultFrame.pixels,
    'changing the scale knob must change what the engine renders',
  );
});

test('chase: moving "dotSize" to its min changes the rendered pixels', () => {
  const pattern = getPatternById('chase');
  const declared = parseParamsFromCode(pattern.code);
  const dotSize = declared.find(param => param.name === 'dotSize');
  assert.ok(dotSize, 'chase declares a dotSize @param');

  const defaultParams = Object.fromEntries(declared.map(param => [param.name, param.value]));
  const editedParams = { ...defaultParams, dotSize: dotSize.max };

  // t=1.25 (rather than the module's default 42.5) puts the moving dot over
  // a pixel with room to grow into its wider neighbours as dotSize changes;
  // fixed-time snapshots of a single traveling dot can otherwise land the
  // whole sparse 4-point fixture off the dot for both param values at once,
  // which would make this test pass by coincidence rather than by proof.
  const defaultFrame = renderWithParams('chase', defaultParams, 1.25);
  const editedFrame = renderWithParams('chase', editedParams, 1.25);

  assert.notDeepEqual(editedFrame.pixels, defaultFrame.pixels);
});

test('a knob edit survives a JSON round trip through the recipe (draft save/reload)', () => {
  const recipe = recipeFromPattern('fire', { palette: FIXED_PALETTE });
  recipe.base.params = { ...recipe.base.params, scale: 9.25 };

  const persisted = JSON.parse(JSON.stringify(recipe));
  const reloaded = normalizePatternLabRecipe(persisted);

  assert.equal(reloaded.base.params.scale, 9.25, 'the edited param value must survive save + reload');

  const beforeSave = renderPatternLabRecipeFrame(recipe, {
    t: 10, strips: FIXED_LAYOUT, bpm: 93, audioBands: { bass: 0, mid: 0, hi: 0 },
  });
  const afterReload = renderPatternLabRecipeFrame(reloaded, {
    t: 10, strips: FIXED_LAYOUT, bpm: 93, audioBands: { bass: 0, mid: 0, hi: 0 },
  });
  assert.deepEqual(afterReload.pixels, beforeSave.pixels, 'the reloaded recipe must render identically to the saved one');
});

test('speed-only patterns declare zero visible knobs (duplicates the universal Speed control)', () => {
  const onlySpeedPatternIds = ['aurora', 'lava', 'ocean', 'matrix', 'warp', 'inkdrop', 'drift',
    'smoke', 'waterfall', 'circuit', 'zen', 'morse', 'thermal'];
  for (const id of onlySpeedPatternIds) {
    const pattern = getPatternById(id);
    assert.ok(pattern, `${id} exists in the library`);
    const declared = parseParamsFromCode(pattern.code).filter(param => !HIDDEN_PARAM_NAMES.has(param.name));
    assert.equal(declared.length, 0, `${id} should show no knobs once the speed duplicate is hidden`);
  }
});

test('every @param name declared anywhere in the library resolves to a non-empty curated label', () => {
  const uncurated = [];
  for (const pattern of PATTERNS) {
    for (const param of parseParamsFromCode(pattern.code)) {
      if (HIDDEN_PARAM_NAMES.has(param.name)) continue;
      const { label } = resolveParamLabel(pattern.id, param.name);
      if (!label || !label.trim()) uncurated.push(`${pattern.id}.${param.name}`);
    }
  }
  assert.deepEqual(uncurated, [], 'every visible knob must have a non-empty label');
});
