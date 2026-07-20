import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const recipeHeader = fs.readFileSync(path.join(root, 'src/LightweaverRecipe.h'), 'utf8');
const recipeSource = fs.readFileSync(path.join(root, 'src/LightweaverRecipe.cpp'), 'utf8');
const types = fs.readFileSync(path.join(root, 'src/LightweaverTypes.h'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'src/LightweaverStorage.cpp'), 'utf8');
const patterns = fs.readFileSync(path.join(root, 'src/LightweaverPatterns.cpp'), 'utf8');
const runtimeApi = fs.readFileSync(path.join(root, 'src/LightweaverRuntimeApi.h'), 'utf8');
const web = fs.readFileSync(path.join(root, 'src/LightweaverWeb.cpp'), 'utf8');

for (const constant of [
  'LW_RECIPE_SCHEMA_VERSION', 'LW_RECIPE_MAX_LAYERS',
  'LW_RECIPE_MAX_CONFIG_BYTES', 'LW_RECIPE_MAX_OPERATIONS_PER_FRAME',
  'LW_RECIPE_MAX_STATE_BYTES',
]) assert.match(recipeHeader, new RegExp(constant));

for (const token of [
  'solid', 'palette', 'wave', 'fastled-noise', 'hash-sparkle',
  'scale', 'offset', 'repeat', 'mirror', 'radial-mask', 'linear-mask',
  'threshold', 'add', 'max', 'multiply', 'crossfade', 'lfo', 'noise-clock',
]) assert.match(recipeSource, new RegExp(`"${token}"`), `${token} must be modeled explicitly`);

for (const bakeOnly of ['particles', 'reaction-diffusion', 'graph', 'shader', 'audio']) {
  assert.match(recipeSource, new RegExp(`"${bakeOnly}"`), `${bakeOnly} must be explicitly bake-only`);
}

assert.match(types, /struct LookConfig\s*{[\s\S]*bool hasNativeRecipe[\s\S]*NativeRecipe nativeRecipe/);
assert.match(storage, /parseNativeRecipeV1\(/, 'storage must validate recipes at the ArduinoJson boundary');
assert.match(storage, /synchronizeNativeRecipes\(/, 'only active validated config recipes should reach runtime dispatch');
assert.match(patterns, /findNativeRecipe\(/, 'recipe lookup must be additive to built-in pattern dispatch');
assert.match(patterns, /renderNativeRecipe\(/, 'accepted native recipes must use the bounded renderer');

for (const legacy of ['aurora', 'custom-color', 'warm-white', 'blackout', 'test-white']) {
  assert.match(patterns, new RegExp(`"${legacy}"`), `legacy pattern ${legacy} must remain available`);
}

assert.match(runtimeApi, /String\s+runtimeRecipeCapabilities\(\)/);
assert.match(web, /recipeCapabilities/, 'firmware info should expose the versioned recipe descriptor');
for (const field of [
  'schemaVersions', 'supportedNodes', 'supportedBlends', 'supportedModulators',
  'maxLayers', 'maxConfigBytes', 'maxOperationsPerFrame', 'maxEstimatedStateBytes',
  'firmwareVersion', 'buildId',
]) assert.match(recipeSource, new RegExp(`"${field}"`), `capability descriptor must expose ${field}`);

assert.doesNotMatch(
  `${recipeSource}\n${patterns}`,
  /physical(?:ly)?\s+(?:identical|parity|match)/i,
  'source must not claim physical parity before real-card inspection',
);

console.log('recipe capability contract tests passed');
